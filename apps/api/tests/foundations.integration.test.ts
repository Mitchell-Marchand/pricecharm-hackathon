import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { closeDatabase, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'owners see only their own customers’ photos, and AI allowances hold under parallel calls',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'quotefolk-foundations-'));
    process.env.AI_DAILY_BUSINESS_LIMIT = '5';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const { createApp } = await import('../src/app.js');
    const { reserveAiCall } = await import('../src/usage.js');
    const app = createApp();

    async function business(name: string) {
      const owner = request.agent(app);
      await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
      await owner
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send({ tradeId: 'pressure-washing', services: ['Driveways'], name, area: 'Austin, TX' })
        .expect(200);
      const signup = await owner
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          firstName: 'Quinn',
          lastName: 'Lee',
          email: `qa-foundations-${randomUUID()}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      return {
        owner,
        id: String(signup.body.data.business.id),
        slug: String(signup.body.data.business.slug),
      };
    }
    const shop = await business('Photo Owner Washing');
    const other = await business('Other Washing');

    // A customer adds a photo to their chat; it belongs to that business alone.
    const started = await request(app)
      .post(`/api/v1/chat/${shop.slug}/start`)
      .set('Origin', origin)
      .send({});
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const jpeg = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#7a8b9c' },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await request(app)
      .post(`/api/v1/chat/${shop.slug}/${started.body.data.chat.id}/photos`)
      .set('Origin', origin)
      .set('Authorization', `Bearer ${started.body.data.token}`)
      .attach('file', jpeg, 'driveway.jpg');
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const [photo] = await rows(
      'SELECT id FROM attachments WHERE business_id=? AND conversation_id=?',
      [shop.id, started.body.data.chat.id],
    );
    const mine = await shop.owner.get(`/api/v1/uploads/${photo.id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.type, 'image/jpeg');
    await other.owner.get(`/api/v1/uploads/${photo.id}`).expect(404);
    await request(app).get(`/api/v1/uploads/${photo.id}`).expect(401);

    // Twelve calls at once against an allowance of five: exactly five get through.
    const reservations = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => reserveAiCall(shop.id, `qa-${index}`)),
    );
    assert.equal(reservations.filter((result) => result.status === 'fulfilled').length, 5);
    const rejected = reservations.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.ok(rejected.every((result) => result.reason.code === 'AI_BUSINESS_BUDGET'));
    await reserveAiCall(other.id, 'qa-other');
    const [otherCount] = await rows(
      "SELECT COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation' AND created_at>=UTC_DATE()",
      [other.id],
    );
    assert.equal(Number(otherCount.count), 1, 'One business’s calls never use up another’s');
  },
);
