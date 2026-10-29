import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { json } from '../src/models.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'real quotes teach the AI: owner changes, customer answers, reminders, no answer and starting prices',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-learning-'));
    const { createApp } = await import('../src/app.js');
    const { decryptEmail } = await import('../src/integrations/email.js');
    const { pricingHistory } = await import('../src/pricing/history.js');
    const { followUpQuotes } = await import('../src/live/followup.js');
    const app = createApp();

    // The shop: three 600 sq ft driveways, so its usual rate is known.
    const owner = request.agent(app);
    // Hand back the day's setup allowance this uses, so later test files keep theirs.
    const allowance = new Map(
      (await rows('SELECT bucket_key,attempts FROM auth_rate_limits')).map((row) => [
        String(row.bucket_key),
        Number(row.attempts),
      ]),
    );
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    for (const row of await rows('SELECT bucket_key,attempts FROM auth_rate_limits'))
      if (Number(row.attempts) > (allowance.get(String(row.bucket_key)) ?? 0))
        await mutate('UPDATE auth_rate_limits SET attempts=attempts-1 WHERE bucket_key=?', [
          row.bucket_key,
        ]);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'House wash'],
        name: 'Clearwater Washing',
        area: 'Tacoma, WA',
      })
      .expect(200);
    for (const priceCents of [25000, 27500, 30000])
      await owner
        .post('/api/v1/onboarding/jobs')
        .set('Origin', origin)
        .send({
          serviceName: 'Driveways',
          description: 'Driveway wash.',
          priceCents,
          size: '600 sq ft',
        })
        .expect(201);
    const signup = await owner
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({
        firstName: 'Ana',
        lastName: 'Reyes',
        email: `qa-learning-${randomUUID()}@example.test`,
        password: 'test password strong123',
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const shop = {
      id: String(signup.body.data.business.id),
      slug: String(signup.body.data.business.slug),
    };
    await owner
      .post('/api/v1/app/billing/plan')
      .set('Origin', origin)
      .send({ plan: 'per_quote' })
      .expect(200);
    await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    // This owner has their Charm check with them first, so they price every draft themselves.
    await owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: false })
      .expect(200);

    async function quoteRequest(slug: string, service: string, size: string) {
      const agent = request.agent(app);
      const started = await agent.post(`/api/v1/chat/${slug}/start`).set('Origin', origin).send({});
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const token = started.body.data.token as string;
      const id = started.body.data.chat.id as string;
      const call = (method: 'get' | 'post', suffix: string, body?: object) =>
        agent[method](`/api/v1/chat/${slug}/${id}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      for (const text of [service, size, 'Skip photos'])
        await call('post', '/messages', { text }).expect(200);
      // It waits for the owner, so it asks where to send it.
      const view = await call('post', '/contact', {
        name: 'Lee Park',
        email: `lee-${randomUUID()}@example.test`,
      });
      assert.equal(view.status, 200, JSON.stringify(view.body));
      assert.equal(view.body.data.chat.status, 'review');
      const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [id]);
      return { id, call, quote };
    }

    // 1. The chat records the size, and the draft starts from the owner's usual rate.
    const first = await quoteRequest(shop.slug, 'Driveways', 'About 600 sq ft, two cars.');
    const [chat] = await rows('SELECT spec_json FROM lead_chats WHERE id=?', [first.id]);
    assert.equal(json<{ quantity: number }>(chat.spec_json, { quantity: 0 }).quantity, 600);
    const engine = json<Record<string, unknown>>(first.quote.engine_json, {});
    assert.equal(engine.estimateCents, 27500, 'The middle rate of its three driveways');
    assert.equal(engine.estimateSolid, true);
    assert.ok(engine.promptVersion, 'Each quote records the instructions that drafted it');
    const checks = json<{ id: string; passed: boolean }[]>(first.quote.checks_json, []);
    assert.ok(checks.find((check) => check.id === 'rate')?.passed, 'It matches the usual rate');
    const detail = (await owner.get(`/api/v1/app/quotes/${first.quote.id}`)).body.data;
    assert.match(detail.details, /^600 sq ft/);
    assert.match(detail.basis, /usual rate/);

    // 2. The owner raises it before sending. The AI learns the change and the new price.
    await owner
      .post(`/api/v1/app/quotes/${first.quote.id}/approve`)
      .set('Origin', origin)
      .send({
        card: { ...detail.card, lines: [{ id: 'l0', label: 'Driveway', amountCents: 30000 }] },
      })
      .expect(200);
    let history = await pricingHistory(shop.id);
    assert.equal(history.liveQuotes.length, 1);
    assert.equal(history.liveQuotes[0].ownerChange, "The owner changed the AI's $275 to $300.");
    assert.equal(history.liveQuotes[0].outcome, 'waiting for the customer');
    assert.match(history.rates[0], /^Driveways: .*\(4 prices, 600 sq ft\)$/);
    const profile = (await owner.get('/api/v1/app/profile')).body.data;
    assert.equal(profile.live.reviewed, 1);
    assert.equal(profile.live.agreed, 1, '$275 is within 15% of $300');
    type Readiness = { service: string; ready: boolean; matched: number; reason: string };
    const driveways = (body: { services: Readiness[] }) =>
      body.services.find((item) => item.service === 'Driveways')!;
    assert.equal(driveways(profile).ready, false, 'One close draft is too few');
    assert.match(driveways(profile).reason, /within 15% of your price on 1 more Driveways job\./);

    // 3. The customer isn't going ahead, and says why. The owner hears, and the AI learns it.
    const lost = await first.call('post', '/decline', { reason: 'price' });
    assert.equal(lost.status, 200, JSON.stringify(lost.body));
    assert.equal(lost.body.data.quote.status, 'lost');
    assert.equal((await first.call('post', '/decline', { reason: 'price' })).status, 409);
    const [notice] = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `owner-lost:${first.id}:once`,
    ]);
    assert.match(
      decryptEmail(notice.payload_encrypted).text,
      /reason: more than I want to spend\./,
    );
    history = await pricingHistory(shop.id);
    assert.equal(history.liveQuotes[0].outcome, 'turned down: more than I want to spend');

    // 4. No answer: one reminder after three days, then "no answer" once it runs out.
    const second = await quoteRequest(shop.slug, 'Driveways', 'Roughly 600 sq ft.');
    await owner
      .post(`/api/v1/app/quotes/${second.quote.id}/approve`)
      .set('Origin', origin)
      .send({})
      .expect(200);
    const learned = (await owner.get('/api/v1/app/profile')).body.data;
    assert.equal(driveways(learned).ready, true, 'Two close drafts and Driveways can send alone');
    assert.equal(learned.autoSendReady, true);
    await mutate(
      'UPDATE live_quotes SET sent_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 4 DAY) WHERE id=?',
      [second.quote.id],
    );
    await followUpQuotes();
    await followUpQuotes();
    const reminders = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `live-quote:${second.id}:followup`,
    ]);
    assert.equal(reminders.length, 1, 'Only one reminder');
    assert.match(decryptEmail(reminders[0].payload_encrypted).text, /not to go ahead/);
    await mutate(
      'UPDATE live_quotes SET sent_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 DAY) WHERE id=?',
      [second.quote.id],
    );
    await followUpQuotes();
    const [expired] = await rows('SELECT status FROM live_quotes WHERE id=?', [second.quote.id]);
    assert.equal(expired.status, 'expired');
    assert.equal(
      (await pricingHistory(shop.id)).liveQuotes.at(-1)?.outcome,
      'no answer',
      'A quote nobody answered teaches it too',
    );
    const late = await second.call('post', '/accept');
    assert.equal(late.body.data.quote.status, 'accepted', 'A late yes still counts');

    // 5. A service it has never priced: other businesses' combined rate, only with enough of them.
    process.env.MARKET_PRICES = 'on';
    const service = `Siding wash ${randomUUID()
      .replace(/[^a-f]/g, '')
      .slice(0, 6)}`;
    async function business(name: string, services: string[], jobs: [string, number, string][]) {
      const id = randomUUID();
      await mutate(
        "INSERT INTO businesses (id,name,slug,description,status,trade_id,link_on) VALUES (?,?,?,'','active','pressure-washing',TRUE)",
        [id, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${id.slice(0, 8)}`],
      );
      for (const [position, offering] of services.entries())
        await mutate(
          'INSERT INTO offerings (id,business_id,name,custom,position) VALUES (?,?,?,?,?)',
          [randomUUID(), id, offering, offering === service, position],
        );
      for (const [serviceName, priceCents, size] of jobs)
        await mutate(
          "INSERT INTO past_jobs (id,business_id,service_name,description,price_cents,size,notes) VALUES (?,?,?,?,?,?,'')",
          [randomUUID(), id, serviceName, `${serviceName} job`, priceCents, size],
        );
      const [row] = await rows('SELECT slug FROM businesses WHERE id=?', [id]);
      return { id, slug: String(row.slug) };
    }
    const newcomer = await business(
      'Fresh Start Washing',
      ['Driveways', service],
      [['Driveways', 26000, '600 sq ft']],
    );
    for (let index = 0; index < 4; index++)
      await business(
        `Other Washers ${index}`,
        [service],
        [[service, 30000 + index * 2000, '2,000 sq ft']],
      );
    const tooFew = await quoteRequest(newcomer.slug, service, 'About 1,000 sq ft of siding.');
    assert.equal(
      json<Record<string, unknown>>(tooFew.quote.engine_json, {}).startingPoint,
      false,
      'Four is too few',
    );
    await business('Other Washers 4', [service], [[service, 40000, '2,000 sq ft']]);
    const started = await quoteRequest(newcomer.slug, service, 'About 1,000 sq ft of siding.');
    const startEngine = json<Record<string, unknown>>(started.quote.engine_json, {});
    assert.equal(startEngine.startingPoint, true);
    assert.equal(started.quote.status, 'review', 'A borrowed price always waits for the owner');
    assert.equal(json<Record<string, unknown>>(started.quote.draft_json, {}).confidence, 'low');
    delete process.env.MARKET_PRICES;
  },
);
