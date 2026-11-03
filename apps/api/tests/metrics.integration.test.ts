import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { deleteBusinessAccount } from '../src/accounts.js';
import { hashToken } from '../src/auth.js';
import { draftIpBudgetKey } from '../src/usage.js';
import { formatReport, metricsReport, recordActivity, recordMilestone } from '../src/metrics.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

const eventsFor = async (subject: string) =>
  (
    await rows(
      // Milestones only: the ones recorded once each.
      'SELECT name,detail FROM product_events WHERE subject=? AND dedupe_key IS NOT NULL ORDER BY created_at,name',
      [subject],
    )
  ).map((item) => `${item.name}${item.detail ? `:${item.detail}` : ''}`);

test(
  'setup and signup steps are recorded once each, and closing the account leaves nothing linking them to it',
  { skip: !enabled },
  async () => {
    const browser = request.agent(createApp());
    await browser.post('/api/v1/onboarding/start').set('Origin', origin).expect(201);
    // Give back the setup this used: every test here shares one address, which may start ten a day.
    const day = new Date().toISOString().slice(0, 10);
    const returned = await mutate(
      'UPDATE auth_rate_limits SET attempts=attempts-1 WHERE bucket_key=? AND attempts>0',
      [hashToken(draftIpBudgetKey('127.0.0.1', day))],
    );
    assert.equal(returned.affectedRows, 1);
    const name = `Metrics ${randomUUID()}`;
    await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ name, services: ['Lawn mowing'] });
    for (const step of ['services', 'practice', 'services', 'practice'])
      await browser.patch('/api/v1/onboarding/step').set('Origin', origin).send({ step });
    const [business] = await rows('SELECT id,metrics_subject FROM businesses WHERE name=?', [name]);
    const subject = String(business.metrics_subject);
    assert.match(subject, /^[0-9a-f-]{36}$/);
    assert.notEqual(subject, business.id, 'The tag is not the business id');

    const password = 'test password strong123';
    const signup = await browser
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({
        firstName: 'Ana',
        lastName: 'Reyes',
        email: `metrics-${randomUUID()}@example.test`,
        password,
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    await browser
      .post('/api/v1/auth/verify-email-code')
      .set('Origin', origin)
      .send({ code: signup.body.data.devCode })
      .expect(200);
    const recorded = [
      'account_created',
      'email_verified',
      'setup_started',
      'setup_step:practice',
      'setup_step:services',
    ];
    assert.deepEqual((await eventsFor(subject)).sort(), recorded);

    await browser
      .delete('/api/v1/account')
      .set('Origin', origin)
      .send({ password, confirmation: name })
      .expect(200);
    const [deletion] = await rows('SELECT id FROM account_deletion_audits WHERE business_id=?', [
      business.id,
    ]);
    await deleteBusinessAccount(String(business.id), String(deletion.id));
    assert.deepEqual((await eventsFor(subject)).sort(), recorded, 'The counts stay');
    assert.equal(
      (await rows('SELECT id FROM businesses WHERE metrics_subject=?', [subject])).length,
      0,
      'Nothing links them to the business any more',
    );
  },
);

test(
  'public page visits are counted once a day per visitor, without cookies or addresses',
  {
    skip: !enabled,
  },
  async () => {
    const app = createApp();
    const agent = `metrics-test-${randomUUID()}`;
    const send = (body: object, from = origin) =>
      request(app).post('/api/v1/visits').set('Origin', from).set('User-Agent', agent).send(body);
    const first = await send({ path: '/pricing', referrer: 'google.com', campaign: 'newsletter' });
    assert.equal(first.status, 204, JSON.stringify(first.body));
    assert.equal(first.headers['set-cookie'], undefined);
    assert.equal((await send({ path: '/pricing', referrer: 'google.com' })).status, 204);
    assert.equal((await send({ path: '/' })).status, 204);
    for (const bad of [
      { path: '/app/settings' },
      { path: '/', referrer: 'https://google.com/search?q=x' },
      { path: '/', email: 'someone@example.test' },
    ])
      assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await send({ path: '/' }, 'https://elsewhere.example')).status, 403);

    const day = new Date().toISOString().slice(0, 10);
    const saved = await rows(
      "SELECT path,visitor,referrer,campaign FROM page_visits WHERE day=? AND path IN ('/','/pricing') AND created_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) ORDER BY path",
      [day],
    );
    const mine = saved.filter((item) => item.visitor === saved.at(-1)?.visitor);
    assert.deepEqual(
      mine.map((item) => [item.path, item.referrer, item.campaign]),
      [
        ['/', '', ''],
        ['/pricing', 'google.com', 'newsletter'],
      ],
    );
    assert.match(String(mine[0].visitor), /^[0-9a-f]{64}$/);
  },
);

test(
  'the report counts sends, price changes and outcomes, and compares with the span before',
  {
    skip: !enabled,
  },
  async () => {
    const before = await metricsReport(1);
    const businessId = randomUUID();
    await mutate(
      'INSERT INTO businesses (id,name,slug,description,metrics_subject) VALUES (?,?,?,?,UUID())',
      [businessId, 'Report Test', `report-test-${businessId}`, ''],
    );
    await recordMilestone(undefined, businessId, 'setup_started');
    const changed = randomUUID(),
      kept = randomUUID(),
      practice = randomUUID();
    await recordActivity(undefined, businessId, 'customer_chat', {
      ref: randomUUID(),
      detail: 'link',
    });
    await recordActivity(undefined, businessId, 'quote_drafted', {
      ref: changed,
      detail: 'live',
      value: 20000,
    });
    await recordActivity(undefined, businessId, 'quote_sent', {
      ref: changed,
      detail: 'owner',
      value: 24000,
    });
    await recordActivity(undefined, businessId, 'quote_drafted', {
      ref: kept,
      detail: 'live',
      value: 9000,
    });
    await recordActivity(undefined, businessId, 'quote_sent', {
      ref: kept,
      detail: 'auto',
      value: 9000,
    });
    await recordActivity(undefined, businessId, 'quote_sent', {
      ref: kept,
      detail: 'auto',
      value: 9000,
    });
    await recordActivity(undefined, businessId, 'quote_outcome', { ref: kept, detail: 'accepted' });
    await recordActivity(undefined, businessId, 'quote_sent', {
      ref: practice,
      detail: 'test',
      value: 5,
    });

    const report = await metricsReport(1, new Date(Date.now() + 1000));
    const grew = (label: string) =>
      report.totals.find((item) => item.label === label)!.count -
      before.totals.find((item) => item.label === label)!.count;
    assert.equal(grew('Customer requests'), 1);
    assert.equal(grew('Quotes sent on their own'), 1, 'A repeat of the same send counts once');
    assert.equal(grew('Quotes sent by the owner'), 1);
    assert.equal(grew('  owner changed the price'), 1);
    assert.equal(grew('Accepted'), 1);
    assert.equal(report.sentValueCents - before.sentValueCents, 33000, 'Owner tests are left out');
    assert.ok(report.funnel[0].count >= 1);
    const text = formatReport(report);
    assert.match(text, /Quotes sent by the owner\s+\d+/);
    assert.match(text, /^PriceCharm, the last day$/m);
    assert.match(text, /Setups started in that time/);
    await mutate('DELETE FROM businesses WHERE id=?', [businessId]);
  },
);
