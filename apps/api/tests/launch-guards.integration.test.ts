import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { mutate, rows, closeDatabase } from '../src/db.js';
import { reserveAiCall, reserveCustomerAiCall } from '../src/usage.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

function saveEnvironment(keys: string[]) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
async function codes(attempts: Promise<unknown>[]) {
  return (await Promise.allSettled(attempts)).map((result) =>
    result.status === 'fulfilled' ? 'reserved' : (result.reason as { code: string }).code,
  );
}
const count = (list: string[], code: string) => list.filter((item) => item === code).length;

test(
  'customer chat has allowances of its own, so it can never use up what owners need',
  { skip: !enabled },
  async () => {
    const restore = saveEnvironment([
      'MAIL_ENCRYPTION_KEY',
      'AI_DAILY_APP_LIMIT',
      'AI_DAILY_CUSTOMER_APP_LIMIT',
      'AI_DAILY_BUSINESS_LIMIT',
      'AI_DAILY_BUSINESS_CUSTOMER_LIMIT',
      'AI_DAILY_CUSTOMER_IP_LIMIT',
    ]);
    const businesses = [randomUUID(), randomUUID(), randomUUID()];
    try {
      process.env.MAIL_ENCRYPTION_KEY = createHash('sha256').update(randomUUID()).digest('base64');
      for (const id of businesses)
        await mutate('INSERT INTO businesses (id,name,slug,description) VALUES (?,?,?,?)', [
          id,
          'QA budget',
          `qa-budget-${id}`,
          '',
        ]);
      await mutate(
        'INSERT INTO ai_daily_budgets (budget_day,total_reserved) VALUES (UTC_DATE(),0) ON DUPLICATE KEY UPDATE total_reserved=total_reserved',
      );
      const [baseline] = await rows(
        'SELECT total_reserved,customer_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
      );
      process.env.AI_DAILY_APP_LIMIT = String(Number(baseline.total_reserved) + 100);
      process.env.AI_DAILY_CUSTOMER_APP_LIMIT = String(Number(baseline.customer_reserved) + 12);
      process.env.AI_DAILY_BUSINESS_LIMIT = '3';
      process.env.AI_DAILY_BUSINESS_CUSTOMER_LIMIT = '4';
      process.env.AI_DAILY_CUSTOMER_IP_LIMIT = '6';
      const [first, second, third] = businesses;
      const customer = (businessId: string, ip: string) =>
        reserveCustomerAiCall({ businessId, sessionId: randomUUID(), ip });

      // One business's customers stop at its own allowance, even from many addresses.
      const busy = await codes(
        Array.from({ length: 7 }, (_, index) => customer(first, `198.51.100.${index + 1}`)),
      );
      assert.equal(count(busy, 'reserved'), 4, busy.join(', '));
      assert.equal(count(busy, 'AI_BUSINESS_CUSTOMER_BUDGET'), 3, busy.join(', '));
      // ...and the owner of that business can still train.
      await reserveAiCall(first, 'owner-training');

      // One address stops at its own allowance across businesses.
      const oneAddress = await codes([
        ...Array.from({ length: 4 }, () => customer(second, '203.0.113.50')),
        ...Array.from({ length: 4 }, () => customer(third, '203.0.113.50')),
      ]);
      assert.equal(count(oneAddress, 'reserved'), 6, oneAddress.join(', '));
      assert.equal(count(oneAddress, 'AI_CUSTOMER_IP_LIMIT'), 2, oneAddress.join(', '));

      // All customers together stop at the customer pool; owners still have the rest.
      process.env.AI_DAILY_BUSINESS_CUSTOMER_LIMIT = '100';
      const pool = await codes([
        customer(second, '192.0.2.1'),
        customer(third, '192.0.2.2'),
        customer(second, '192.0.2.3'),
      ]);
      assert.equal(count(pool, 'reserved'), 2, pool.join(', '));
      assert.equal(count(pool, 'AI_CUSTOMER_CAPACITY'), 1, pool.join(', '));
      await reserveAiCall(second, 'owner-training');
      await reserveAiCall(third, 'owner-training');

      const [after] = await rows(
        'SELECT total_reserved,customer_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
      );
      assert.equal(Number(after.customer_reserved) - Number(baseline.customer_reserved), 12);
      assert.equal(Number(after.total_reserved) - Number(baseline.total_reserved), 15);
    } finally {
      const [created] = await rows(
        "SELECT SUM(kind='ai_customer_reservation') AS customer, COUNT(*) AS total FROM usage_events WHERE business_id IN (?,?,?) AND kind IN ('ai_reservation','ai_customer_reservation')",
        businesses,
      );
      await mutate(
        'UPDATE ai_daily_budgets SET total_reserved=total_reserved-?, customer_reserved=customer_reserved-? WHERE budget_day=UTC_DATE()',
        [Number(created.total || 0), Number(created.customer || 0)],
      );
      await mutate('DELETE FROM usage_events WHERE business_id IN (?,?,?)', businesses);
      await mutate('DELETE FROM businesses WHERE id IN (?,?,?)', businesses);
      restore();
    }
  },
);

test(
  'wrong passwords from many addresses lock the account, but not the owner’s own browser',
  { skip: !enabled },
  async () => {
    const restore = saveEnvironment(['TRUST_PROXY', 'TURNSTILE_SECRET_KEY']);
    process.env.TRUST_PROXY = '1';
    delete process.env.TURNSTILE_SECRET_KEY;
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    const email = `qa-lock-${randomUUID()}@example.test`,
      password = 'test password strong123';
    let address = 0;
    const from = () => `198.18.${Math.floor(++address / 250)}.${address % 250}`;
    const login = (agent: ReturnType<typeof request.agent>, value: string, user = email) =>
      agent
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('X-Forwarded-For', from())
        .send({ email: user, password: value });
    try {
      const owner = request.agent(app);
      const registered = await owner
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .set('X-Forwarded-For', from())
        .send({ name: 'QA', businessName: 'QA Lock', email, password });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      // Signing in once is what marks this browser as the owner's.
      assert.equal((await login(owner, password)).status, 200);

      for (let attempt = 0; attempt < 10; attempt++)
        assert.equal((await login(request.agent(app), 'wrong guess')).status, 401);
      const locked = await login(request.agent(app), password);
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');

      const ownBrowser = await login(owner, password);
      assert.equal(ownBrowser.status, 200, JSON.stringify(ownBrowser.body));

      // An email with no account locks the same way, so a lock reveals nothing.
      const stranger = `qa-none-${randomUUID()}@example.test`;
      for (let attempt = 0; attempt < 10; attempt++)
        assert.equal((await login(request.agent(app), 'wrong guess', stranger)).status, 401);
      assert.equal((await login(request.agent(app), 'anything', stranger)).status, 429);

      // A password reset ends the lock.
      for (let attempt = 0; attempt < 10; attempt++) await login(request.agent(app), 'wrong guess');
      const forgot = await request(app)
        .post('/api/v1/auth/forgot-password')
        .set('Origin', origin)
        .send({ email });
      assert.ok(forgot.body.data.devToken, JSON.stringify(forgot.body));
      const newPassword = 'a different strong password';
      await request(app)
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin)
        .send({ token: forgot.body.data.devToken, password: newPassword })
        .expect(200);
      assert.equal((await login(request.agent(app), newPassword)).status, 200);
      // The old browser's mark was tied to the old password.
      assert.equal((await login(owner, password)).status, 401);
    } finally {
      restore();
    }
  },
);
