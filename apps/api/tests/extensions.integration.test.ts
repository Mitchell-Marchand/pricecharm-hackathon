import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { mutate, rows, transaction, closeDatabase } from '../src/db.js';
import { reserveAiCall } from '../src/usage.js';

const enabled = process.env.RUN_DB_TESTS === '1';

test(
  'CSV atomic import, private normalized photos and concurrent daily AI budgets work against MySQL',
  { skip: !enabled },
  async () => {
    assert.equal(
      process.env.AI_PROVIDER,
      'demo',
      'This test must explicitly disable live AI calls',
    );
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quotient-extension-photos-'));
    // Storage configuration is captured at import time. This fixture never touches S3.
    process.env.S3_BUCKET = '';
    process.env.UPLOAD_DIR = directory;
    process.env.AI_DAILY_BUSINESS_LIMIT = '5';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const { createApp } = await import('../src/app.js');
    const { deletePhoto, getPhoto } = await import('../src/storage.js');
    const app = createApp(),
      ownerA = request.agent(app),
      ownerB = request.agent(app);
    const origin = 'http://localhost:3100',
      marker = randomUUID(),
      tenantIds: string[] = [];
    const csvHeader = 'title,description,quantity,finalPrice,rationale\n';
    try {
      async function register(agent: typeof ownerA, label: string) {
        const result = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: `QA Extension ${label}`,
            businessName: `QA Extension ${label}`,
            email: `qa-extension-${label}-${marker}@example.test`,
            password: 'test password strong123',
          });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        tenantIds.push(result.body.data.business.id);
        return result.body.data;
      }
      const accountA = await register(ownerA, 'a'),
        accountB = await register(ownerB, 'b');
      await ownerA
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Driveway washing only', serviceArea: 'Austin' })
        .expect(200);
      const serviceResult = await ownerA
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Concrete washing',
          description: 'Standard concrete driveways',
          unitLabel: 'square feet',
          unitPriceCents: 25,
          basePriceCents: 2000,
          minimumChargeCents: 10000,
          requiredInputs: ['area', 'surface'],
        });
      assert.equal(serviceResult.status, 201);
      const serviceId = serviceResult.body.data.id;
      const importPath = `/api/v1/examples/import?serviceId=${serviceId}`;

      // A valid first row must not persist when a later row is invalid.
      const invalid = await ownerA
        .post(importPath)
        .set('Origin', origin)
        .set('Content-Type', 'text/csv')
        .send(
          csvHeader +
            'QA Valid,Concrete,400,120.00,Base plus area\nQA Invalid,Concrete,500,not-money,Invalid second row\n',
        );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'CSV_PRICE');
      assert.deepEqual((await ownerA.get('/api/v1/examples')).body.data, []);
      assert.equal((await ownerA.get('/api/v1/services')).body.data[0].version, 1);

      const validCsv =
        csvHeader +
        '"QA Driveway, small","Concrete\nnormal access",400,120.00,"Base plus area"\nQA Medium,Concrete,500,145.00,Base plus area\nQA Large,Concrete,600,170.00,Base plus area\n';
      const foreignImport = await ownerB
        .post(importPath)
        .set('Origin', origin)
        .set('Content-Type', 'text/csv')
        .send(validCsv);
      assert.equal(foreignImport.status, 404);
      assert.deepEqual((await ownerB.get('/api/v1/examples')).body.data, []);
      await request(app)
        .post(importPath)
        .set('Origin', origin)
        .set('Content-Type', 'text/csv')
        .send(validCsv)
        .expect(401);
      const imported = await ownerA
        .post(importPath)
        .set('Origin', origin)
        .set('Content-Type', 'text/csv')
        .send(validCsv);
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      assert.equal(imported.body.data.imported, 3);
      const examples = (await ownerA.get('/api/v1/examples')).body.data;
      assert.equal(examples.length, 3);
      assert.equal(
        examples.find((item: { quantity: number }) => item.quantity === 400).description,
        'Concrete\nnormal access',
      );
      assert.equal(
        examples.find((item: { quantity: number }) => item.quantity === 500).finalPriceCents,
        14500,
      );
      assert.equal((await ownerA.get('/api/v1/services')).body.data[0].version, 2);

      // The input deliberately includes EXIF orientation. Persisted images must contain no EXIF.
      const original = await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: '#325b63' },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      assert.ok(
        (await sharp(original).metadata()).exif,
        'The fixture must actually carry EXIF metadata',
      );
      const spoofed = await ownerA
        .post('/api/v1/uploads')
        .set('Origin', origin)
        .attach('file', Buffer.from('<html>This is not a JPEG</html>'), {
          filename: 'not-a-photo.jpg',
          contentType: 'image/jpeg',
        });
      assert.equal(spoofed.status, 422);
      assert.equal(spoofed.body.error.code, 'INVALID_IMAGE');
      const disguisedSvg = await ownerA
        .post('/api/v1/uploads')
        .set('Origin', origin)
        .attach(
          'file',
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
          ),
          { filename: 'disguised.jpg', contentType: 'image/jpeg' },
        );
      assert.equal(
        disguisedSvg.status,
        422,
        'SVG bytes declared as JPEG must not bypass the supported photo formats',
      );
      const uploaded = await ownerA
        .post('/api/v1/uploads')
        .set('Origin', origin)
        .field('exampleId', examples[0].id)
        .attach('file', original, { filename: 'driveway.jpg', contentType: 'image/jpeg' });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const attachmentId = uploaded.body.data.id;
      const photo = await ownerA.get(`/api/v1/uploads/${attachmentId}`);
      assert.equal(photo.status, 200);
      assert.match(photo.headers['content-type'], /image\/jpeg/);
      const normalized = await sharp(photo.body).metadata();
      assert.equal(normalized.format, 'jpeg');
      assert.equal(normalized.exif, undefined);
      assert.equal(normalized.orientation, undefined);
      assert.equal(normalized.width, 720);
      assert.equal(normalized.height, 1440);
      assert.ok(photo.body.length < 1024 * 1024);
      await request(app).get(`/api/v1/uploads/${attachmentId}`).expect(401);
      await request(app)
        .delete(`/api/v1/uploads/${attachmentId}`)
        .set('Origin', origin)
        .expect(401);
      await ownerB.get(`/api/v1/uploads/${attachmentId}`).expect(404);
      await ownerB.delete(`/api/v1/uploads/${attachmentId}`).set('Origin', origin).expect(404);
      await ownerA.get(`/api/v1/uploads/${attachmentId}`).expect(200);
      const associationEscape = await ownerB
        .post('/api/v1/uploads')
        .set('Origin', origin)
        .field('exampleId', examples[0].id)
        .attach('file', original, { filename: 'foreign.jpg', contentType: 'image/jpeg' });
      assert.equal(associationEscape.status, 404);

      await ownerA
        .post(`/api/v1/services/${serviceId}/evaluate`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      await ownerA
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const started = await request(app)
        .post(`/api/v1/public/${accountA.business.slug}/sessions`)
        .send({ serviceId });
      assert.equal(started.status, 201);
      const sessionId = started.body.data.session.id,
        token = started.body.data.token;
      const publicPath = `/api/v1/public/${accountA.business.slug}/sessions/${sessionId}/uploads`;
      await request(app).get(publicPath).expect(401);
      await request(app)
        .post(publicPath)
        .set('Authorization', `Bearer ${'a'.repeat(43)}`)
        .attach('file', original, { filename: 'invalid-token.jpg', contentType: 'image/jpeg' })
        .expect(404);
      const publicIds: string[] = [];
      for (let index = 0; index < 3; index++) {
        const result = await request(app)
          .post(publicPath)
          .set('Authorization', `Bearer ${token}`)
          .attach('file', original, { filename: `public-${index}.jpg`, contentType: 'image/jpeg' });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        publicIds.push(result.body.data.id);
      }
      const fourth = await request(app)
        .post(publicPath)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', original, { filename: 'public-fourth.jpg', contentType: 'image/jpeg' });
      assert.equal(fourth.status, 422);
      assert.equal(fourth.body.error.code, 'PHOTO_LIMIT');
      const publicPhotos = await request(app)
        .get(publicPath)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(publicPhotos.body.data.length, 3);
      await request(app)
        .get(`/api/v1/public/${accountB.business.slug}/sessions/${sessionId}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      for (const id of publicIds) await ownerB.get(`/api/v1/uploads/${id}`).expect(404);
      const [persistedPhotos] = await rows(
        'SELECT COUNT(*) AS count FROM attachments WHERE business_id = ? AND conversation_id = ?',
        [accountA.business.id, sessionId],
      );
      assert.equal(Number(persistedPhotos.count), 3);

      const [ownerFile] = await rows(
        'SELECT storage_key FROM attachments WHERE id = ? AND business_id = ?',
        [attachmentId, accountA.business.id],
      );
      await ownerA.delete(`/api/v1/uploads/${attachmentId}`).set('Origin', origin).expect(200);
      await ownerA.get(`/api/v1/uploads/${attachmentId}`).expect(404);
      await assert.rejects(() => getPhoto(ownerFile.storage_key), { code: 'ENOENT' });

      // Yesterday's usage must not consume today's allowance. Account for the fixture in the
      // durable app counter so cleanup can subtract exactly the reservations it created.
      await transaction(async (connection) => {
        await mutate(
          'INSERT IGNORE INTO ai_daily_budgets (budget_day,total_reserved) VALUES (DATE_SUB(UTC_DATE(),INTERVAL 1 DAY),0)',
          [],
          connection,
        );
        await rows(
          'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day = DATE_SUB(UTC_DATE(),INTERVAL 1 DAY) FOR UPDATE',
          [],
          connection,
        );
        await mutate(
          'UPDATE ai_daily_budgets SET total_reserved = total_reserved + 1 WHERE budget_day = DATE_SUB(UTC_DATE(),INTERVAL 1 DAY)',
          [],
          connection,
        );
        await mutate(
          "INSERT INTO usage_events (id,business_id,kind,metadata_json,created_at) VALUES (?,?,'ai_reservation',?,DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",
          [randomUUID(), accountA.business.id, JSON.stringify({ fixture: marker })],
          connection,
        );
      });
      const reservations = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          reserveAiCall(accountA.business.id, `qa-${marker}-${index}`),
        ),
      );
      assert.equal(
        reservations.filter((result) => result.status === 'fulfilled').length,
        5,
        `Reservation results: ${reservations.map((result) => (result.status === 'fulfilled' ? 'reserved' : result.reason.code)).join(', ')}`,
      );
      const rejected = reservations.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      assert.equal(rejected.length, 7);
      assert.ok(rejected.every((result) => result.reason.code === 'AI_BUSINESS_BUDGET'));
      const [tenantCount] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation' AND created_at >= UTC_DATE()",
        [accountA.business.id],
      );
      assert.equal(Number(tenantCount.count), 5);
      await reserveAiCall(accountB.business.id, `qa-${marker}-tenant-b`);
      const [otherCount] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation' AND created_at >= UTC_DATE()",
        [accountB.business.id],
      );
      assert.equal(Number(otherCount.count), 1);
      const [providerCalls] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id IN (?, ?) AND kind = 'ai_call'",
        [accountA.business.id, accountB.business.id],
      );
      assert.equal(Number(providerCalls.count), 0, 'No provider calls are made by these tests');
    } finally {
      for (const businessId of tenantIds) {
        const attachments = await rows(
          'SELECT storage_key FROM attachments WHERE business_id = ?',
          [businessId],
        );
        for (const attachment of attachments) await deletePhoto(attachment.storage_key);
        await transaction(async (connection) => {
          const days = await rows(
            "SELECT DATE(created_at) AS day, COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation' GROUP BY DATE(created_at)",
            [businessId],
            connection,
          );
          for (const day of days) {
            await rows(
              'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day = ? FOR UPDATE',
              [day.day],
              connection,
            );
            await mutate(
              'UPDATE ai_daily_budgets SET total_reserved = GREATEST(0, total_reserved - ?) WHERE budget_day = ?',
              [Number(day.count), day.day],
              connection,
            );
          }
          await mutate('DELETE FROM usage_events WHERE business_id = ?', [businessId], connection);
          await mutate(
            'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id = ?)',
            [businessId],
            connection,
          );
          for (const table of [
            'attachments',
            'jobs',
            'quotes',
            'public_sessions',
            'messages',
            'training_sessions',
            'evaluations',
            'examples',
            'services',
            'users',
          ])
            await mutate(`DELETE FROM ${table} WHERE business_id = ?`, [businessId], connection);
          await mutate('DELETE FROM businesses WHERE id = ?', [businessId], connection);
        });
      }
      await fs.rm(directory, { recursive: true, force: true });
      await closeDatabase();
    }
  },
);
