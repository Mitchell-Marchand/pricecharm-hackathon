import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'guest business names come from the exact proof-owned source without changing registration or claim identity',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'demo';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const originalFetch = globalThis.fetch,
      sessionIds = new Set<string>(),
      previewIds: string[] = [],
      origin = 'http://localhost:3100';
    let providerCalls = 0,
      businessId: string | undefined;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('This test permits no provider calls');
    };
    const { createApp } = await import('../src/app.js'),
      { hashToken } = await import('../src/auth.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      guest = request.agent(app),
      foreign = request.agent(app);
    const bootstrap = async (agent = guest) => {
      const response = await agent.get('/api/v1/guest-preview').expect(200);
      for (const cookie of response.headers['set-cookie'] || []) {
        const token = /quotient_guest_preview=([^;]+)/.exec(cookie)?.[1];
        if (token) {
          const [session] = await rows('SELECT id FROM guest_preview_sessions WHERE proof_hash=?', [
            hashToken(decodeURIComponent(token)),
          ]);
          sessionIds.add(session.id);
          return session.id as string;
        }
      }
      throw new Error('Expected a new fictional proof session');
    };
    const result = {
      reply: 'Review this service and these questions.',
      draft: {
        name: 'Model service title',
        description: 'Cleaning interior surfaces',
        unitLabel: null,
        example: null,
      },
      evidence: {
        unitLabel: null,
        exampleQuantity: null,
        examplePrice: null,
        singleProjectFixedTotal: false,
        singleProject: null,
      },
      questions: [
        'What work do you need?',
        'What condition is the project in?',
        'What photos can you share?',
      ],
      sourcePriceText: null,
      sourceCurrency: null,
      readyToSave: true,
    };
    const seed = async (
      sessionId: string,
      content: string,
      ageSeconds: number,
      status = 'ready',
      readyToSave = true,
    ) => {
      const id = randomUUID(),
        requestId = randomUUID();
      previewIds.push(id);
      await mutate(
        'INSERT INTO guest_previews(id,session_id,request_id,input_hash,source_text,result_json,status,processing_until,expires_at,created_at) VALUES (?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 20 MINUTE),?)',
        [
          id,
          sessionId,
          requestId,
          hashToken(content),
          content,
          JSON.stringify({ ...result, readyToSave }),
          status,
          new Date(Date.now() - ageSeconds * 1000),
        ],
      );
      return { id, requestId };
    };
    const get = async (selector = '', agent = guest) =>
      (await agent.get(`/api/v1/guest-preview${selector}`).expect(200)).body.data;
    const snapshot = async () =>
      JSON.stringify({
        previews: await rows('SELECT * FROM guest_previews ORDER BY id'),
        sessions: await rows('SELECT * FROM guest_preview_sessions ORDER BY id'),
        budgets: await rows('SELECT * FROM ai_daily_budgets ORDER BY budget_day'),
        usage: await rows('SELECT * FROM usage_events ORDER BY id'),
      });
    try {
      const proofId = await bootstrap();
      await bootstrap(foreign);
      const a = await seed(proofId, 'I run First Brand, a cleaning service.', 10),
        b = await seed(proofId, 'I run Second Brand, a cleaning service.', 0),
        legacy = await seed(proofId, 'I clean homes.', 20),
        processing = await seed(
          proofId,
          'I run Pending Brand, a cleaning service.',
          30,
          'processing',
        ),
        failed = await seed(proofId, 'I run Failed Brand, a cleaning service.', 40, 'failed'),
        unready = await seed(
          proofId,
          'I run Unready Brand, a cleaning service.',
          50,
          'ready',
          false,
        ),
        before = await snapshot();
      assert.equal((await get()).preview.id, b.id);
      assert.equal((await get()).preview.businessNameSuggestion, 'Second Brand');
      const exact = (await get(`?previewId=${a.id}`)).preview;
      assert.equal(exact.id, a.id);
      assert.equal(exact.businessNameSuggestion, 'First Brand');
      assert.equal(exact.receipt.name, 'Model service title', 'The model title is not the brand');
      assert.equal(
        (await get(`?requestId=${a.requestId}`)).preview.businessNameSuggestion,
        'First Brand',
      );
      assert.equal((await get(`?previewId=${a.id}`, foreign)).preview, null);
      assert.equal((await get(`?previewId=${randomUUID()}`)).preview, null);
      for (const fixture of [legacy, processing, failed, unready])
        assert.equal((await get(`?previewId=${fixture.id}`)).preview.businessNameSuggestion, null);
      assert.equal(await snapshot(), before, 'These exact reads do not write or reserve AI budget');
      assert.equal(providerCalls, 0);

      const registration = (
        await guest
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Business name QA',
            businessName: 'Owner entered identity',
            email: `qa-guest-business-name-${randomUUID()}@example.test`,
            password: 'fictional-business-name123',
          })
          .expect(201)
      ).body.data;
      businessId = registration.business.id;
      const identity = async () =>
        (await rows('SELECT name FROM businesses WHERE id=?', [businessId!]))[0].name;
      assert.equal(await identity(), 'Owner entered identity');
      assert.equal((await get(`?previewId=${a.id}`)).preview.businessNameSuggestion, 'First Brand');
      assert.equal(
        await identity(),
        'Owner entered identity',
        'A suggestion never changes identity',
      );
      const claimed = (
        await guest
          .post(`/api/v1/guest-preview/${a.id}/claim`)
          .set('Origin', origin)
          .send({ expectedVersion: 1, approveIntake: true })
          .expect(200)
      ).body.data;
      assert.equal(claimed.service.name, result.draft.name);
      assert.equal(
        await identity(),
        'Owner entered identity',
        'Claim preserves the explicit registration',
      );
      assert.equal((await get(`?previewId=${a.id}`)).preview.businessNameSuggestion, null);
      await mutate(
        'UPDATE guest_previews SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [b.id],
      );
      assert.equal(
        (await get(`?previewId=${b.id}`)).preview,
        null,
        'An expired source is unavailable',
      );
      assert.equal(providerCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      if (businessId) {
        const deletionId = randomUUID();
        await mutate('INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,?)', [
          deletionId,
          businessId,
          'scheduled',
        ]);
        await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [
          businessId,
        ]);
        await deleteBusinessAccount(businessId, deletionId);
      }
      for (const id of previewIds) await mutate('DELETE FROM guest_previews WHERE id=?', [id]);
      for (const id of sessionIds)
        await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [id]);
      await closeDatabase();
    }
  },
);
