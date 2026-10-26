import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';

test(
  'guest edits can recover the exact earlier ready receipt after failed and capped attempts without extra provider calls',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.TRUST_PROXY = '1';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'guest-recovery-fixture-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.MAIL_ENCRYPTION_KEY = Buffer.from(randomUUID()).subarray(0, 32).toString('base64');
    process.env.GUEST_PREVIEW_DAILY_IP_LIMIT = '2';
    const originalFetch = globalThis.fetch,
      sessionIds = new Set<string>(),
      businessIds: string[] = [],
      rateKeys = new Set<string>(),
      ip = '192.0.2.141',
      capacityIp = '192.0.2.142',
      origin = 'http://localhost:3100';
    let providerCalls = 0,
      pendingAttempt: Promise<any> | undefined,
      releaseFailure: () => void = () => {},
      signalProcessing: () => void = () => {};
    const processing = new Promise<void>((resolve) => {
        signalProcessing = resolve;
      }),
      failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
    const questions = [
      'What kind of photography do you need?',
      'Where will the session take place?',
      'What photos would you like?',
    ];
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      providerCalls++;
      if (providerCalls === 2) {
        signalProcessing();
        await failureGate;
        return Response.json({ error: { message: 'Mock provider rejection' } }, { status: 503 });
      }
      assert.equal(providerCalls, 1, 'No automatic retry or recovery call is permitted');
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 10 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  reply: 'Review your photography service and questions.',
                  draft: {
                    name: 'Photographer',
                    description: 'Photography services',
                    unitLabel: 'hour',
                    example: {
                      title: 'Portrait session',
                      description: 'A brief portrait session',
                      quantity: null,
                      finalPriceCents: 18000,
                      rationale: 'because it was a brief shoot',
                    },
                  },
                  evidence: {
                    unitLabel: 'bill by the hour',
                    exampleQuantity: null,
                    examplePrice: '$180 USD',
                    singleProjectFixedTotal: false,
                    singleProject: null,
                  },
                  offeringInterpretation: {
                    classification: 'current',
                    quote: 'I am a photographer',
                  },
                  historicalJobInterpretation: {
                    classification: 'actual_job',
                    quote:
                      'I recently photographed a portrait session and charged $180 USD because it was a brief shoot.',
                  },
                  questions,
                }),
              },
            ],
          },
        ],
      });
    };
    const { createApp } = await import('../src/app.js'),
      { hashToken } = await import('../src/auth.js'),
      { guestIpBudgetKey } = await import('../src/usage.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      guest = request.agent(app),
      other = request.agent(app);
    const bootstrap = async (agent = guest) => {
      const response = await agent.get('/api/v1/guest-preview').expect(200);
      for (const cookie of response.headers['set-cookie'] || []) {
        const token = /quotient_guest_preview=([^;]+)/.exec(cookie)?.[1];
        if (token) {
          const [session] = await rows('SELECT id FROM guest_preview_sessions WHERE proof_hash=?', [
            hashToken(decodeURIComponent(token)),
          ]);
          sessionIds.add(session.id);
        }
      }
      return response.body.data;
    };
    const get = async (query = '', agent = guest) =>
      (await agent.get(`/api/v1/guest-preview${query}`).expect(200)).body.data;
    const post = (
      content: string,
      requestId: string,
      address = ip,
      expectedSessionExpiresAt?: string,
    ) =>
      guest
        .post('/api/v1/guest-preview')
        .set('Origin', origin)
        .set('X-Forwarded-For', address)
        .send({
          content,
          requestId,
          ...(expectedSessionExpiresAt ? { expectedSessionExpiresAt } : {}),
        });
    const register = async (agent: typeof guest) => {
      const result = (
        await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Guest recovery QA',
            businessName: 'Fictional guest recovery',
            email: `qa-guest-recovery-${randomUUID()}@example.test`,
            password: 'recovery-fixture-password123',
          })
          .expect(201)
      ).body.data;
      businessIds.push(result.business.id);
    };
    const claim = (id: string, version: number, agent = guest) =>
      agent
        .post(`/api/v1/guest-preview/${id}/claim`)
        .set('Origin', origin)
        .send({ expectedVersion: version, approveIntake: true });
    let day = '';
    try {
      await mutate(
        'INSERT INTO ai_daily_budgets(budget_day,total_reserved,guest_reserved) VALUES(UTC_DATE(),0,0) ON DUPLICATE KEY UPDATE total_reserved=total_reserved',
      );
      const [baseline] = await rows(
        "SELECT total_reserved,guest_reserved,DATE_FORMAT(budget_day,'%Y-%m-%d') AS day FROM ai_daily_budgets WHERE budget_day=UTC_DATE()",
      );
      day = String(baseline.day);
      process.env.AI_DAILY_APP_LIMIT = String(Number(baseline.total_reserved) + 10);
      process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = String(Number(baseline.guest_reserved) + 10);
      for (const address of [ip, capacityIp])
        rateKeys.add(hashToken(guestIpBudgetKey(address, day)));
      const boot = await bootstrap(),
        proofId = [...sessionIds][0],
        content =
          'I am a photographer in Denver. I recently photographed a portrait session and charged $180 USD because it was a brief shoot. I bill by the hour, but I did not record its hours.',
        requestA = randomUUID();
      assert.equal(boot.preview, null);
      assert.equal(boot.recoverablePreview, null);
      const ready = (await post(content, requestA).expect(201)).body.data.preview;
      assert.equal(ready.status, 'ready');
      assert.equal(ready.readyToSave, true);
      assert.equal(
        ready.receipt.example.description,
        'I recently photographed a portrait session and charged $180 USD because it was a brief shoot.',
      );
      assert.equal(ready.receipt.example.rationale, '');
      const proofBefore = JSON.stringify(
        await rows('SELECT * FROM guest_preview_sessions WHERE id=?', [proofId]),
      );
      const exact = await get(`?previewId=${ready.id}`);
      assert.deepEqual(exact.preview, ready);
      assert.equal(exact.recoverablePreview, null);
      const mismatched = await post(
        content,
        requestA,
        ip,
        new Date(Date.now() + 1000).toISOString(),
      ).expect(409);
      assert.equal(mismatched.body.error.code, 'GUEST_PREVIEW_PROOF_CHANGED');
      const requestB = randomUUID(),
        edited = content + ' I also photograph team events.';
      const pending = post(edited, requestB).then((response) => response);
      pendingAttempt = pending;
      await processing;
      const active = await get(`?requestId=${requestB}`);
      assert.equal(active.preview.status, 'processing');
      assert.equal(active.preview.content, edited);
      assert.equal(
        active.recoverablePreview,
        null,
        'A running edited attempt is never replaced by earlier questions',
      );
      assert.equal((await get()).recoverablePreview, null);
      assert.equal((await get(`?previewId=${ready.id}`)).preview.id, ready.id);
      await post(edited, requestB, ip, boot.expiresAt).expect(202);
      assert.equal(providerCalls, 2, 'Checking a pending result does not dispatch another call');
      releaseFailure();
      const failed = await pending;
      assert.equal(failed.status, 200);
      assert.equal(failed.body.data.preview.status, 'failed');
      assert.equal(failed.body.data.preview.receipt, null);
      assert.equal(
        (await post(edited, requestB, ip, boot.expiresAt).expect(200)).body.data.preview.status,
        'failed',
      );
      assert.equal(
        providerCalls,
        2,
        'A guarded retry of the same failed attempt never calls the provider again',
      );
      const requestC = randomUUID(),
        cappedEdit = edited + ' I offer commercial portraits too.';
      const denied = await post(cappedEdit, requestC).expect(429);
      assert.equal(denied.body.error.code, 'GUEST_PREVIEW_LIMIT');
      assert.equal(
        (
          await rows('SELECT id FROM guest_previews WHERE session_id=? AND request_id=?', [
            proofId,
            requestC,
          ])
        ).length,
        0,
      );
      const restored = await get(`?requestId=${requestC}`);
      assert.equal(
        restored.preview,
        null,
        'A rejected edit is not reported as an analyzed preview',
      );
      assert.deepEqual(restored.recoverablePreview, ready);
      assert.equal(restored.recoverablePreview.content, content);
      assert.notEqual(restored.recoverablePreview.content, cappedEdit);
      const latest = await get();
      assert.equal(latest.preview.id, failed.body.data.preview.id);
      assert.equal(latest.preview.status, 'failed');
      assert.deepEqual(latest.recoverablePreview, ready);
      const failedExact = await get(`?previewId=${latest.preview.id}`);
      assert.equal(failedExact.preview.status, 'failed');
      assert.deepEqual(failedExact.recoverablePreview, ready);

      for (const query of [
        `?previewId=${ready.id}&requestId=${requestA}`,
        '?previewId=not-a-uuid',
        '?requestId=not-a-uuid',
        `?previewId=${ready.id}&previewId=${ready.id}`,
      ]) {
        await guest.get(`/api/v1/guest-preview${query}`).expect(400);
      }
      await bootstrap(other);
      const foreign = await get(`?previewId=${ready.id}`, other);
      assert.equal(foreign.preview, null);
      assert.equal(foreign.recoverablePreview, null);
      assert.equal((await get(`?requestId=${requestA}`, other)).preview, null);

      const [stored] = await rows('SELECT * FROM guest_previews WHERE id=?', [ready.id]);
      const expiredId = randomUUID(),
        unusableId = randomUUID(),
        invalidId = randomUUID();
      const result =
        typeof stored.result_json === 'string'
          ? JSON.parse(stored.result_json)
          : stored.result_json;
      for (const [id, expires, resultJson] of [
        [expiredId, new Date(Date.now() - 1000), result],
        [unusableId, new Date(stored.expires_at), { ...result, readyToSave: false }],
        [invalidId, new Date(stored.expires_at), { ...result, questions: [] }],
      ] as const) {
        await mutate(
          "INSERT INTO guest_previews(id,session_id,request_id,input_hash,source_text,status,result_json,expires_at,created_at) VALUES (?,?,?,?,?,'ready',?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 SECOND))",
          [id, proofId, randomUUID(), hashToken(id), content, JSON.stringify(resultJson), expires],
        );
      }
      const expired = await get(`?previewId=${expiredId}`);
      assert.equal(expired.preview, null);
      assert.deepEqual(expired.recoverablePreview, ready);
      const unusable = await get(`?previewId=${unusableId}`);
      assert.equal(unusable.preview.readyToSave, false);
      assert.deepEqual(unusable.recoverablePreview, ready);
      const invalid = await get(`?previewId=${invalidId}`);
      assert.equal(invalid.preview.receipt, null);
      assert.deepEqual(
        invalid.recoverablePreview,
        ready,
        'A malformed newer receipt cannot hide valid earlier evidence',
      );
      assert.equal(
        JSON.stringify(await rows('SELECT * FROM guest_preview_sessions WHERE id=?', [proofId])),
        proofBefore,
        'Free recovery never renews the proof expiry',
      );
      process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = String(Number(baseline.guest_reserved) + 2);
      const appDeniedId = randomUUID();
      assert.equal(
        (await post(cappedEdit, appDeniedId, capacityIp).expect(429)).body.error.code,
        'GUEST_PREVIEW_CAPACITY',
      );
      assert.deepEqual((await get(`?requestId=${appDeniedId}`)).recoverablePreview, ready);
      assert.equal(providerCalls, 2);
      const budgetBeforeClaim = JSON.stringify(
        await rows('SELECT * FROM ai_daily_budgets WHERE budget_day=?', [day]),
      );
      await register(other);
      await claim(ready.id, ready.version, other).expect(404);
      await register(guest);
      await claim(expiredId, 1).expect(410);
      await claim(ready.id, ready.version + 1).expect(409);
      const saved = (await claim(ready.id, ready.version).expect(200)).body.data;
      assert.equal(saved.session.status, 'confirmed');
      assert.equal(saved.jobNote.sourceNotes, content);
      assert.equal(saved.jobNote.kind, 'historical_job');
      assert.equal(saved.jobNote.description, ready.receipt.example.description);
      assert.equal(saved.jobNote.rationale, '');
      assert.deepEqual(saved.service.requiredInputs, ready.questions);
      await mutate(
        "INSERT INTO guest_previews(id,session_id,request_id,input_hash,source_text,status,result_json,expires_at) VALUES (?,?,?,?,?,'ready',?,?)",
        [
          randomUUID(),
          proofId,
          randomUUID(),
          hashToken(randomUUID()),
          content,
          JSON.stringify(result),
          new Date(stored.expires_at),
        ],
      );
      const claimedExact = await get(`?previewId=${ready.id}`);
      assert.equal(claimedExact.preview.status, 'claimed');
      assert.equal(claimedExact.preview.claim.serviceId, saved.service.id);
      assert.equal(
        claimedExact.recoverablePreview,
        null,
        'Claimed primary state is never replaced by earlier questions',
      );
      assert.equal(
        (await claim(ready.id, ready.version).expect(200)).body.data.service.id,
        saved.service.id,
      );
      assert.equal(
        JSON.stringify(await rows('SELECT * FROM ai_daily_budgets WHERE budget_day=?', [day])),
        budgetBeforeClaim,
      );
      assert.equal(
        providerCalls,
        2,
        'Recovery and exact claim are free even after the allowance is exhausted',
      );
      await mutate(
        'UPDATE guest_preview_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [proofId],
      );
      const expiredProof = await guest
        .get(`/api/v1/guest-preview?previewId=${unusableId}`)
        .expect(200);
      assert.equal(expiredProof.body.data.preview, null);
      assert.equal(expiredProof.body.data.recoverablePreview, null);
      for (const cookie of expiredProof.headers['set-cookie'] || []) {
        const token = /quotient_guest_preview=([^;]+)/.exec(cookie)?.[1];
        if (token)
          sessionIds.add(
            (
              await rows('SELECT id FROM guest_preview_sessions WHERE proof_hash=?', [
                hashToken(decodeURIComponent(token)),
              ])
            )[0].id,
          );
      }
      const changedProof = await post(edited, requestB, ip, boot.expiresAt).expect(409);
      assert.equal(changedProof.body.error.code, 'GUEST_PREVIEW_PROOF_CHANGED');
      assert.equal(providerCalls, 2);
      assert.equal(
        JSON.stringify(await rows('SELECT * FROM ai_daily_budgets WHERE budget_day=?', [day])),
        budgetBeforeClaim,
        'A changed proof rejects a retry before any reservation',
      );
      const renewedProofId = [...sessionIds].find(
        (id) => id !== proofId && id !== [...sessionIds][1],
      )!;
      assert.equal(
        (await rows('SELECT id FROM guest_previews WHERE session_id=?', [renewedProofId])).length,
        0,
      );
      assert.equal(
        (await claim(ready.id, ready.version).expect(200)).body.data.service.id,
        saved.service.id,
        'Existing owned-claim idempotency remains available after proof expiry',
      );
    } finally {
      releaseFailure();
      await pendingAttempt?.catch(() => undefined);
      globalThis.fetch = originalFetch;
      for (const sessionId of sessionIds) {
        await transaction(async (connection) => {
          for (const reservation of await rows(
            'SELECT reservation_day AS day,COUNT(*) AS count FROM guest_previews WHERE session_id=? AND reserved_at IS NOT NULL GROUP BY reservation_day',
            [sessionId],
            connection,
          )) {
            await rows(
              'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day=? FOR UPDATE',
              [reservation.day],
              connection,
            );
            await mutate(
              'UPDATE ai_daily_budgets SET total_reserved=GREATEST(0,total_reserved-?),guest_reserved=GREATEST(0,guest_reserved-?) WHERE budget_day=?',
              [Number(reservation.count), Number(reservation.count), reservation.day],
              connection,
            );
          }
          await mutate('DELETE FROM guest_previews WHERE session_id=?', [sessionId], connection);
          await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [sessionId], connection);
        });
      }
      for (const key of rateKeys)
        await mutate('DELETE FROM auth_rate_limits WHERE bucket_key=?', [key]);
      for (const businessId of businessIds) {
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
      await closeDatabase();
    }
  },
);
