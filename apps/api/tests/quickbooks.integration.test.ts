import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { openSecret } from '../src/integrations/email.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
const REALM = '4620816365';
after(() => closeDatabase());

/** 22 ordinary invoices, newest first, then a voided one and one in another currency. */
function companyInvoices() {
  const ordinary = Array.from({ length: 22 }, (_, index) => {
    const price = 300 + index;
    return {
      Id: String(index + 1),
      DocNumber: String(1001 + index),
      TxnDate: `2026-06-${String(29 - index).padStart(2, '0')}`,
      TotalAmt: price + 10,
      CurrencyRef: { value: 'USD' },
      CustomerRef: { value: '9', name: 'Jane Customer' },
      Line: [
        {
          DetailType: 'SalesItemLineDetail',
          Amount: price,
          Description: 'Driveway, about 900 sq ft',
          SalesItemLineDetail: {
            ItemRef: { value: '1', name: 'Driveway cleaning' },
            Qty: 1,
            UnitPrice: price,
          },
        },
        { DetailType: 'SubTotalLineDetail', Amount: price },
      ],
      TxnTaxDetail: { TotalTax: 10 },
    };
  });
  return [
    { ...ordinary[0], Id: '50', DocNumber: '9050', TotalAmt: 0, Line: [], TxnTaxDetail: {} },
    ...ordinary,
    { ...ordinary[0], Id: '51', DocNumber: '9051', CurrencyRef: { value: 'CAD' } },
  ];
}

test(
  'an owner connects QuickBooks, its invoices come onto the import list a list at a time, and it can be let go',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-quickbooks-'));
    delete process.env.QUICKBOOKS_CLIENT_ID;
    // Starting a setup has a per-address limit the whole test run shares, so these have their own.
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    const owner = request.agent(app).set('X-Forwarded-For', '203.0.113.81'),
      stranger = request.agent(app).set('X-Forwarded-For', '203.0.113.82');
    for (const agent of [owner, stranger])
      await agent.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ tradeId: 'pressure-washing', services: ['Driveways', 'Patios & pavers'] })
      .expect(200);

    const status = async (agent = owner) =>
      (await agent.get('/api/v1/onboarding/quickbooks').expect(200)).body.data;
    assert.deepEqual(await status(), { available: false, connection: null }, 'Off without keys');
    await owner
      .post('/api/v1/onboarding/quickbooks/connect')
      .set('Origin', origin)
      .send({})
      .expect(404);
    process.env.QUICKBOOKS_CLIENT_ID = 'qb-client';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';

    // QuickBooks' side.
    const invoices = companyInvoices();
    const tokenCalls: string[] = [];
    const revoked: string[] = [];
    let refused = false;
    const realFetch = globalThis.fetch.bind(globalThis);
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.href === 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer') {
        assert.equal(headers.Authorization, `Basic ${btoa('qb-client:qb-secret')}`);
        const body = new URLSearchParams(String(init?.body));
        tokenCalls.push(
          `${body.get('grant_type')} ${body.get('code') ?? body.get('refresh_token')}`,
        );
        if (body.get('grant_type') === 'authorization_code') {
          assert.equal(body.get('redirect_uri'), `${origin}/api/v1/onboarding/quickbooks/callback`);
          return Response.json({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
          });
        }
        if (refused) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        });
      }
      if (url.href === 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke') {
        revoked.push(JSON.parse(String(init?.body)).token);
        return new Response(null, { status: 200 });
      }
      if (url.origin === 'https://sandbox-quickbooks.api.intuit.com') {
        assert.match(headers.Authorization, /^Bearer access-[12]$/);
        assert.equal(url.searchParams.get('minorversion'), '75');
        if (url.pathname === `/v3/company/${REALM}/companyinfo/${REALM}`)
          return Response.json({ CompanyInfo: { CompanyName: 'Moss Washing LLC' } });
        const query = url.searchParams.get('query') ?? '';
        if (
          url.pathname === `/v3/company/${REALM}/query` &&
          query.startsWith('SELECT * FROM Invoice')
        ) {
          const [, start, size] = query.match(/STARTPOSITION (\d+) MAXRESULTS (\d+)/)!.map(Number);
          return Response.json({
            QueryResponse: { Invoice: invoices.slice(start - 1, start - 1 + size) },
          });
        }
        if (url.pathname === `/v3/company/${REALM}/query` && query.startsWith('SELECT * FROM Item'))
          return Response.json({
            QueryResponse: { Item: [{ Id: '1', Name: 'Driveway cleaning', Type: 'Service' }] },
          });
      }
      if (url.hostname.endsWith('intuit.com')) throw new Error(`Unexpected call to ${url.href}`);
      return realFetch(input, init);
    });

    const connect = async (agent: typeof owner, returnTo: string) => {
      const started = await agent
        .post('/api/v1/onboarding/quickbooks/connect')
        .set('Origin', origin)
        .send({ returnTo });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const url = new URL(started.body.data.url);
      assert.equal(url.origin + url.pathname, 'https://appcenter.intuit.com/connect/oauth2');
      assert.equal(url.searchParams.get('client_id'), 'qb-client');
      assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
      return url.searchParams.get('state')!;
    };
    const callback = async (agent: typeof owner, query: Record<string, string>) => {
      const response = await agent
        .get('/api/v1/onboarding/quickbooks/callback')
        .query(query)
        .expect(303);
      return response.headers.location;
    };

    const state = await connect(owner, '/start/jobs');
    assert.equal(
      await callback(owner, { state: 'not-it', code: 'auth-code', realmId: REALM }),
      '/start/jobs?quickbooks=failed',
    );
    const declined = await connect(owner, 'https://elsewhere.example/');
    assert.equal(
      await callback(owner, { state: declined, error: 'access_denied' }),
      '/app/train?quickbooks=cancelled',
      'It only ever sends the owner back to a page on this site',
    );
    assert.notEqual(state, declined);
    const mine = await connect(owner, '/start/jobs');
    assert.equal(
      await callback(stranger, { state: mine, code: 'auth-code', realmId: REALM }),
      '/app/train?quickbooks=failed',
      'The sign-in only finishes in the browser that started it',
    );
    assert.equal(
      await callback(owner, { state: mine, code: 'auth-code', realmId: REALM }),
      '/start/jobs?quickbooks=connected',
    );
    assert.deepEqual(tokenCalls, ['authorization_code auth-code']);
    assert.deepEqual(await status(), {
      available: true,
      connection: { companyName: 'Moss Washing LLC' },
    });
    assert.deepEqual(await status(stranger), { available: true, connection: null });
    const [stored] = await rows('SELECT * FROM accounting_connections WHERE realm_id=?', [REALM]);
    assert.doesNotMatch(String(stored.refresh_token_ciphertext), /refresh-1/, 'Tokens are sealed');
    assert.equal(openSecret(String(stored.refresh_token_ciphertext)), 'refresh-1');

    async function readAll(agent = owner) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const list = (await agent.get('/api/v1/onboarding/imports')).body.data;
        if (list.every((item: { status: string }) => item.status !== 'reading')) return list;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The invoices were never read.');
    }
    const first = await readAll();
    assert.equal(first.length, 20, 'As many as the list holds');
    assert.equal(first[0].filename, 'QuickBooks invoice 1001, Jun 29, 2026', 'Newest first');
    assert.equal(first[19].filename, 'QuickBooks invoice 1020, Jun 10, 2026');
    assert.ok(first.every((item: { status: string }) => item.status === 'ready'));
    assert.ok(
      !first.some((item: { filename: string }) => /905[01]/.test(item.filename)),
      'Voided invoices and other currencies stay out',
    );
    const [read] = await rows('SELECT source_text FROM job_imports WHERE id=?', [first[0].id]);
    assert.equal(read.source_text, null, 'What the invoice said goes once it has been read');
    assert.deepEqual(await readAll(stranger), []);

    const pull = async () => {
      const response = await owner.post('/api/v1/onboarding/quickbooks/pull').set('Origin', origin);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.data;
    };
    const full = await pull();
    assert.deepEqual([full.added, full.full], [0, true], 'Nothing more while the list is full');
    for (const item of first.slice(0, 2))
      await owner.delete(`/api/v1/onboarding/imports/${item.id}`).set('Origin', origin).expect(200);
    const more = await pull();
    assert.deepEqual([more.added, more.full], [2, true]);
    assert.deepEqual(
      more.imports.slice(-2).map((item: { filename: string }) => item.filename),
      ['QuickBooks invoice 1021, Jun 9, 2026', 'QuickBooks invoice 1022, Jun 8, 2026'],
      'Skipped invoices don’t come back; the next ones do',
    );
    await readAll();
    await owner
      .delete(`/api/v1/onboarding/imports/${first[2].id}`)
      .set('Origin', origin)
      .expect(200);
    const none = await pull();
    assert.deepEqual([none.added, none.full], [0, false], 'Every invoice has been brought in');

    const saved = await owner
      .post('/api/v1/onboarding/imports/save')
      .set('Origin', origin)
      .send({ jobs: [{ importId: first[3].id, job: first[3].job }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.jobs.at(-1).source, 'invoice');

    // An hour on, the access token is renewed, and QuickBooks' new refresh token is kept.
    await mutate(
      'UPDATE accounting_connections SET access_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE realm_id=?',
      [REALM],
    );
    await pull();
    assert.deepEqual(tokenCalls.slice(1), ['refresh_token refresh-1']);
    const [renewed] = await rows('SELECT * FROM accounting_connections WHERE realm_id=?', [REALM]);
    assert.equal(openSecret(String(renewed.refresh_token_ciphertext)), 'refresh-2');
    await pull();
    assert.equal(tokenCalls.length, 2, 'A fresh access token is used until it runs out');

    // QuickBooks lets the connection go: the owner is asked to connect again.
    refused = true;
    await mutate(
      'UPDATE accounting_connections SET access_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE realm_id=?',
      [REALM],
    );
    const lost = await owner.post('/api/v1/onboarding/quickbooks/pull').set('Origin', origin);
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error.code, 'QUICKBOOKS_DISCONNECTED');
    assert.equal((await status()).connection, null);

    refused = false;
    const again = await connect(owner, '/app/train');
    assert.equal(
      await callback(owner, { state: again, code: 'auth-code', realmId: REALM }),
      '/app/train?quickbooks=connected',
    );
    await owner.delete('/api/v1/onboarding/quickbooks').set('Origin', origin).expect(200);
    assert.deepEqual(revoked, ['refresh-1']);
    assert.equal((await status()).connection, null);
    assert.equal((await readAll()).length, 18, 'Invoices on the list stay to check');
    mock.restoreAll();
  },
);
