import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { verifyHuman } from '../src/human-check.js';
import { isDisposableEmail } from '../src/email-domains.js';
import { requestContactVerification } from '../src/verification.js';
import { reportable, scrubEvent } from '../src/error-reporting.js';

const origin = 'http://localhost:3100';
function fakeRequest(token?: string) {
  return {
    ip: '203.0.113.9',
    get: (name: string) => (name.toLowerCase() === 'x-turnstile-token' ? token : undefined),
  } as unknown as Request;
}
async function withTurnstile<T>(
  reply: (body: URLSearchParams) => unknown,
  task: () => Promise<T>,
): Promise<T> {
  const saved = { secret: process.env.TURNSTILE_SECRET_KEY, fetch: globalThis.fetch };
  process.env.TURNSTILE_SECRET_KEY = 'turnstile-test-secret';
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const result = reply(init.body as URLSearchParams);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  try {
    return await task();
  } finally {
    if (saved.secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = saved.secret;
    globalThis.fetch = saved.fetch;
  }
}

test('without a Turnstile secret the check is off', async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  await verifyHuman(fakeRequest(), 'signup');
});

test('Turnstile tokens are verified once with Cloudflare, for the action they were earned on', async () => {
  let sent: URLSearchParams | undefined;
  await withTurnstile(
    (body) => {
      sent = body;
      return { success: true, action: 'signup' };
    },
    () => verifyHuman(fakeRequest('token-from-widget'), 'signup'),
  );
  assert.equal(sent?.get('secret'), 'turnstile-test-secret');
  assert.equal(sent?.get('response'), 'token-from-widget');
  assert.equal(sent?.get('remoteip'), '203.0.113.9');

  await withTurnstile(
    () => ({ success: true, action: 'signup' }),
    () =>
      assert.rejects(verifyHuman(fakeRequest('token-from-widget'), 'quote_chat'), {
        code: 'HUMAN_CHECK_FAILED',
      }),
  );
  await withTurnstile(
    () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    () =>
      assert.rejects(verifyHuman(fakeRequest('spent-token'), 'signup'), {
        code: 'HUMAN_CHECK_FAILED',
      }),
  );
  await withTurnstile(
    () => new Error('network down'),
    () =>
      assert.rejects(verifyHuman(fakeRequest('token-from-widget'), 'signup'), {
        code: 'HUMAN_CHECK_UNAVAILABLE',
      }),
  );
  await withTurnstile(
    () => assert.fail('A missing token never reaches Cloudflare'),
    () => assert.rejects(verifyHuman(fakeRequest(), 'signup'), { code: 'HUMAN_CHECK_REQUIRED' }),
  );
});

test('signup needs a passed check before it creates anything', async () => {
  await withTurnstile(
    () => assert.fail('No token was sent'),
    async () => {
      const response = await request(createApp())
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA',
          businessName: 'QA Cleaning',
          email: 'owner@example.test',
          password: 'test password strong123',
        });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'HUMAN_CHECK_REQUIRED');
    },
  );
});

test('throwaway inboxes are recognised, including their subdomains', () => {
  assert.equal(isDisposableEmail('someone@mailinator.com'), true);
  assert.equal(isDisposableEmail('Someone@Inbox.Mailinator.COM'), true);
  assert.equal(isDisposableEmail('owner@gmail.com'), false);
  assert.equal(isDisposableEmail('owner@example.test'), false);
});

test('owners and customers must use an inbox they keep', async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  const response = await request(createApp())
    .post('/api/v1/auth/register')
    .set('Origin', origin)
    .send({
      name: 'QA',
      businessName: 'QA Cleaning',
      email: 'owner@mailinator.com',
      password: 'test password strong123',
    });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'DISPOSABLE_EMAIL');
  await assert.rejects(
    requestContactVerification({
      businessId: '00000000-0000-4000-8000-000000000001',
      sessionId: '00000000-0000-4000-8000-000000000002',
      email: 'customer@mailinator.com',
    }),
    { code: 'DISPOSABLE_EMAIL' },
  );
});

test('error reports keep the error and drop what people typed', () => {
  const event = scrubEvent({
    type: undefined,
    message: 'Failed for owner@example.test',
    request: { url: '/q/moss#session=1&token=abc', headers: { cookie: 'quotient_session=x' } },
    user: { email: 'owner@example.test', ip_address: '203.0.113.9' },
    extra: { body: 'my driveway' },
    breadcrumbs: [{ message: 'typed something' }],
    exception: {
      values: [{ type: 'Error', value: 'Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- rejected' }],
    },
  });
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.extra, undefined);
  assert.equal(event.breadcrumbs, undefined);
  assert.equal(event.message, 'Failed for [email]');
  assert.equal(event.exception?.values?.[0].value, 'Bearer [token] rejected');

  const database = Object.assign(new Error("Duplicate entry 'Maya Lopez' for key 'name'"), {
    code: 'ER_DUP_ENTRY',
    sqlState: '23000',
  });
  const safe = reportable(database) as Error;
  assert.equal(safe.message, 'Database error ER_DUP_ENTRY');
  assert.ok(!safe.stack?.includes('Maya'));
  const plain = new Error('plain');
  assert.equal(reportable(plain), plain);
});
