import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, rows } from '../src/db.js';
import { decryptEmail } from '../src/integrations/email.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'we get one email each when someone starts training, makes an account and adds a card',
  { skip: !enabled },
  async () => {
    process.env.SIGNUPS_EMAIL = 'signups@example.test';
    process.env.TRUST_PROXY = '1';
    try {
      // An address of its own, since the other tests use up 127.0.0.1's ten setups a day.
      const suffix = randomUUID();
      const browser = request
        .agent(createApp())
        .set('X-Forwarded-For', `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(9, 13)}::1`);
      await browser.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
      const name = `Alert Test Plumbing ${randomUUID().slice(0, 8)}`;
      await browser
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send({ tradeId: 'pressure-washing', name, area: 'Austin, TX' })
        .expect(200);
      const email = `alerts-${randomUUID()}@example.test`;
      const signup = await browser.post('/api/v1/auth/register').set('Origin', origin).send({
        firstName: 'Dana',
        lastName: 'Reyes',
        email,
        password: 'a-long-test-password',
      });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      const businessId = String(signup.body.data.business.id);
      await browser
        .post('/api/v1/app/billing/plan')
        .set('Origin', origin)
        .send({ plan: 'per_quote' })
        .expect(200);
      // Coming back from checkout twice, or Stripe saying so again, still sends one.
      await browser.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      await browser.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);

      const sent = (
        await rows(
          "SELECT payload_encrypted FROM email_outbox WHERE business_id=? AND dedupe_key LIKE 'signup-alert:%' ORDER BY created_at",
          [businessId],
        )
      ).map((row) => decryptEmail(String(row.payload_encrypted)));
      assert.deepEqual(
        sent.map((item) => item.subject),
        ['Someone started training a Charm', `New account: ${name}`, `Card added: ${name}`],
      );
      assert.ok(sent.every((item) => item.to === 'signups@example.test'));
      assert.match(sent[1].text, new RegExp(`Dana Reyes \\(${email}\\) just made an account`));
      assert.match(sent[1].text, /Area: Austin, TX/);
      assert.equal(sent[1].replyTo, email, 'A reply reaches the owner');
      assert.match(sent[2].text, /Plan: pay per quote/);
    } finally {
      delete process.env.SIGNUPS_EMAIL;
      delete process.env.TRUST_PROXY;
    }
  },
);
