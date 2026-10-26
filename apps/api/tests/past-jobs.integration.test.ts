import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

async function photo(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

test(
  'past jobs keep every field, attach photos picked before saving, and stay in their own setup',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'quotefolk-jobs-'));
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    const owner = request.agent(app),
      stranger = request.agent(app);
    for (const agent of [owner, stranger])
      await agent.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ tradeId: 'pressure-washing', services: ['Driveways', 'Patios & pavers'] })
      .expect(200);

    const upload = (agent: typeof owner, bytes: Buffer) =>
      agent
        .post('/api/v1/onboarding/photos')
        .set('Origin', origin)
        .attach('file', bytes, { filename: 'job.jpg', contentType: 'image/jpeg' });
    const first = await upload(owner, await photo({ r: 200, g: 40, b: 40 }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await upload(owner, await photo({ r: 40, g: 200, b: 40 }));
    const theirs = await upload(stranger, await photo({ r: 40, g: 40, b: 200 }));
    assert.match(first.body.data.url, /^\/api\/v1\/onboarding\/photos\/[0-9a-f-]{36}$/);
    const served = await owner.get(first.body.data.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/jpeg');
    assert.equal((await stranger.get(first.body.data.url)).status, 404, 'Photos stay private');

    const job = {
      serviceName: 'Patios & pavers',
      description: 'Back patio and walkway, about 600 sq ft. Lots of moss in the joints.',
      priceCents: 27500,
      size: '600 sq ft',
      duration: '3 hours',
      when: 'June 2026',
      materialsCents: 1800,
      discount: { kind: 'percent', value: 10, reason: 'Neighbor discount' },
      notes: 'Had to haul water',
      photoIds: [first.body.data.id, second.body.data.id],
    };
    const created = await owner.post('/api/v1/onboarding/jobs').set('Origin', origin).send(job);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const saved = created.body.data;
    const { photoIds, ...fields } = job;
    const { id: _id, createdAt: _createdAt, photos: savedPhotos, ...savedFields } = saved;
    assert.deepEqual(savedFields, { ...fields, source: 'manual' });
    assert.deepEqual(
      savedPhotos.map((item: { id: string }) => item.id),
      photoIds,
    );
    const borrowed = await owner
      .post('/api/v1/onboarding/jobs')
      .set('Origin', origin)
      .send({ ...job, photoIds: [theirs.body.data.id] });
    assert.equal(borrowed.status, 404, 'A job can only use its own setup’s photos');
    for (const bad of [
      { ...job, priceCents: 0, photoIds: [] },
      { ...job, description: 'ok', photoIds: [] },
      { ...job, discount: { kind: 'percent', value: 120, reason: '' }, photoIds: [] },
    ]) {
      const rejected = await owner.post('/api/v1/onboarding/jobs').set('Origin', origin).send(bad);
      assert.equal(rejected.status, 400, JSON.stringify(bad));
    }

    const edited = await owner
      .put(`/api/v1/onboarding/jobs/${saved.id}`)
      .set('Origin', origin)
      .send({ ...job, priceCents: 29000, discount: null, photoIds: [second.body.data.id] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.priceCents, 29000);
    assert.equal(edited.body.data.discount, null);
    assert.deepEqual(
      edited.body.data.photos.map((item: { id: string }) => item.id),
      [second.body.data.id],
    );
    assert.equal((await owner.get(first.body.data.url)).status, 404, 'A removed photo is deleted');
    assert.equal(
      (
        await stranger
          .put(`/api/v1/onboarding/jobs/${saved.id}`)
          .set('Origin', origin)
          .send({ ...job, photoIds: [] })
      ).status,
      404,
    );

    const listed = await owner.get('/api/v1/onboarding/jobs');
    assert.equal(listed.body.data.length, 1);
    assert.equal((await stranger.get('/api/v1/onboarding/jobs')).body.data.length, 0);

    const read = await owner
      .post('/api/v1/onboarding/jobs/read')
      .set('Origin', origin)
      .attach('file', Buffer.from('%PDF-1.4 fixture'), {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
      });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.found, true);
    assert.equal(
      read.body.data.job.serviceName,
      'Driveways',
      'It picks one of the setup’s services',
    );
    assert.match(read.body.data.issues[0], /Demo mode/);
    const unreadable = await owner
      .post('/api/v1/onboarding/jobs/read')
      .set('Origin', origin)
      .attach('file', Buffer.from('not a document'), { filename: 'notes.txt' });
    assert.equal(unreadable.status, 415);

    const removed = await owner.delete(`/api/v1/onboarding/jobs/${saved.id}`).set('Origin', origin);
    assert.equal(removed.status, 200);
    assert.equal((await owner.get(second.body.data.url)).status, 404);
    assert.equal((await owner.get('/api/v1/onboarding/jobs')).body.data.length, 0);
  },
);

test('a draft has a smaller daily AI pool and a lifetime cap', { skip: !enabled }, async () => {
  const { reserveAiCall } = await import('../src/usage.js');
  const { randomUUID } = await import('node:crypto');
  const saved = {
    lifetime: process.env.AI_DRAFT_LIFETIME_LIMIT,
    pool: process.env.AI_DAILY_DRAFT_APP_LIMIT,
  };
  const draft = randomUUID();
  try {
    await mutate(
      "INSERT INTO businesses (id,name,slug,description,status,draft_expires_at) VALUES (?,'',?,'','draft',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",
      [draft, `draft-${draft}`],
    );
    await mutate(
      'INSERT INTO ai_daily_budgets (budget_day,total_reserved) VALUES (UTC_DATE(),0) ON DUPLICATE KEY UPDATE total_reserved=total_reserved',
    );
    const [budget] = await rows(
      'SELECT draft_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
    );
    process.env.AI_DRAFT_LIFETIME_LIMIT = '2';
    process.env.AI_DAILY_DRAFT_APP_LIMIT = String(Number(budget.draft_reserved) + 50);
    await reserveAiCall(draft, 'practice');
    await reserveAiCall(draft, 'practice');
    await assert.rejects(reserveAiCall(draft, 'practice'), { code: 'SETUP_AI_LIMIT' });
    const [after] = await rows(
      'SELECT draft_reserved FROM ai_daily_budgets WHERE budget_day=UTC_DATE()',
    );
    assert.equal(Number(after.draft_reserved) - Number(budget.draft_reserved), 2);
    process.env.AI_DRAFT_LIFETIME_LIMIT = '50';
    process.env.AI_DAILY_DRAFT_APP_LIMIT = String(Number(after.draft_reserved));
    await assert.rejects(reserveAiCall(draft, 'practice'), { code: 'SETUP_AI_CAPACITY' });
  } finally {
    await mutate(
      'UPDATE ai_daily_budgets SET total_reserved=total_reserved-2,draft_reserved=draft_reserved-2 WHERE budget_day=UTC_DATE()',
    );
    await mutate('DELETE FROM usage_events WHERE business_id=?', [draft]);
    await mutate('DELETE FROM businesses WHERE id=?', [draft]);
    for (const [key, value] of [
      ['AI_DRAFT_LIFETIME_LIMIT', saved.lifetime],
      ['AI_DAILY_DRAFT_APP_LIMIT', saved.pool],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
