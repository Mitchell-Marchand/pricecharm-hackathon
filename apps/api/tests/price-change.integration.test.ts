import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { json } from '../src/models.js';
import type { Quote } from '../src/practice/types.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'a price change the owner sets goes on every quote, and never teaches the Charm',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-change-'));
    // A whole test run comes from one address, and it can use up the day's setups before this.
    process.env.LOCAL_SETUPS_PER_ADDRESS = '500';
    const { createApp } = await import('../src/app.js');
    const { pricingHistory } = await import('../src/pricing/history.js');
    const app = createApp();

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
        services: ['Driveways'],
        name: 'Busy Season Washing',
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
        email: `qa-change-${randomUUID()}@example.test`,
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
    await owner
      .patch('/api/v1/app/settings')
      .set('Origin', origin)
      .send({ autoSend: false })
      .expect(200);

    async function quoteRequest() {
      const agent = request.agent(app);
      const started = await agent
        .post(`/api/v1/chat/${shop.slug}/start`)
        .set('Origin', origin)
        .send({ language: 'es' });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const token = started.body.data.token as string;
      const id = started.body.data.chat.id as string;
      assert.equal(started.body.data.chat.language, 'es');
      assert.match(started.body.data.chat.messages[0].text, /asistente/);
      const call = (suffix: string, body: object) =>
        agent
          .post(`/api/v1/chat/${shop.slug}/${id}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      for (const text of ['Driveways', 'About 600 sq ft, two cars.', 'Skip photos'])
        await call('/messages', { text }).expect(200);
      await call('/contact', {
        name: 'Lee Park',
        email: `lee-${randomUUID()}@example.test`,
      }).expect(200);
      const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [id]);
      return quote;
    }

    const set = (body: object) =>
      owner.post('/api/v1/app/price-change').set('Origin', origin).send(body);
    await set({ percent: 0, until: 'month' }).expect(400);
    await set({ percent: 500, until: 'month' }).expect(400);
    await set({ percent: 20, until: '2020-01-01' }).expect(400);

    const before = await quoteRequest();
    assert.equal(before.price_change_percent, null);
    const own = json<Quote>(before.quote_json, {} as Quote).lines[0].amountCents;

    const read = await owner
      .post('/api/v1/app/price-change/read')
      .set('Origin', origin)
      .send({ text: "We're super busy this month, increase quotes by 20%" })
      .expect(200);
    assert.deepEqual(read.body.data, {
      changesPrices: true,
      direction: 'up',
      percent: 20,
      lasts: 'month',
    });
    const saved = await set({ percent: 20, until: 'month', words: 'Busy month' }).expect(200);
    assert.match(saved.body.data.change.words, /^Quotes are 20% higher through \w+ \d+\.$/);
    const knows = await owner.get('/api/v1/onboarding/knows').expect(200);
    assert.equal(knows.body.data.priceChange.percent, 20);

    const busy = await quoteRequest();
    assert.equal(busy.price_change_percent, 20);
    const shown = json<Quote>(busy.quote_json, {} as Quote);
    assert.equal(shown.lines[0].amountCents, Math.round((own * 1.2) / 100) * 100);
    assert.equal(Number(busy.total_cents), shown.lines[0].amountCents);
    assert.equal(
      JSON.stringify(json(busy.quote_json, {})).includes('price_change'),
      false,
      'The customer’s copy of the quote says nothing about it',
    );

    // Sent as it is, what's learned is the price before the change, and no edit by the owner.
    const detail = (await owner.get(`/api/v1/app/quotes/${busy.id}`).expect(200)).body.data;
    assert.equal(detail.priceChangePercent, 20);
    await owner
      .post(`/api/v1/app/quotes/${busy.id}/approve`)
      .set('Origin', origin)
      .send({ card: detail.card })
      .expect(200);
    const learned = (await pricingHistory(shop.id)).liveQuotes.at(-1);
    assert.equal(learned?.lines[0].amountCents, own, JSON.stringify(learned));
    assert.match(learned?.ownerChange ?? '', /draft as it was/);

    await owner.delete('/api/v1/app/price-change').set('Origin', origin).expect(200);
    assert.equal((await owner.get('/api/v1/app/price-change')).body.data.change, null);
    const after = await quoteRequest();
    assert.equal(after.price_change_percent, null);
  },
);
