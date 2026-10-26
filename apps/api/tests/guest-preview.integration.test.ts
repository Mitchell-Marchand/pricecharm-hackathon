import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';

test(
  'guest previews bind proof, one paid result and atomic owner approval without repeating AI or losing raw prices',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.TRUST_PROXY = '1';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'mock-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 0xab).toString('base64');
    process.env.AI_DAILY_APP_LIMIT = '999999';
    process.env.GUEST_PREVIEW_DAILY_APP_LIMIT = '99999';
    process.env.GUEST_PREVIEW_DAILY_IP_LIMIT = '99';
    const originalFetch = globalThis.fetch,
      businessIds: string[] = [],
      sessionIds = new Set<string>(),
      previewIds = new Set<string>(),
      ipAddresses = new Set<string>();
    let providerCalls = 0,
      failProvider = false,
      requestIndex = 0;
    const questions = [
      'What occasion is this for?',
      'What coverage do you want?',
      'What photos or examples can you share?',
    ];
    const historicalQuote =
      'I recently photographed a birthday portrait session and charged $180 because it was a brief shoot and included edited photos.';
    let answer: any = {
      reply: 'Review your portrait service and customer questions.',
      draft: {
        name: 'Photographer',
        description: 'Photography services.',
        unitLabel: 'hour',
        example: {
          title: 'Birthday portrait session',
          description:
            'Birthday portrait sessions. Charged $180 for Alice because of a private discount.',
          quantity: null,
          finalPriceCents: 18000,
          rationale: '',
        },
      },
      evidence: {
        unitLabel: 'bill by the hour',
        exampleQuantity: null,
        examplePrice: '$180',
        singleProjectFixedTotal: true,
        singleProject: 'a birthday portrait session',
      },
      offeringInterpretation: { classification: 'current', quote: 'I’m a photographer' },
      historicalJobInterpretation: { classification: 'actual_job', quote: historicalQuote },
      questions,
    };
    const portraitAnswer = structuredClone(answer);
    globalThis.fetch = async (url, init) => {
      assert.equal(
        String(url),
        'https://api.openai.com/v1/responses',
        'No actual provider traffic is allowed',
      );
      providerCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens <= 1800 && body.max_output_tokens >= 256, true);
      assert.ok(body.text.format.schema.required.includes('offeringInterpretation'));
      assert.ok(body.text.format.schema.required.includes('historicalJobInterpretation'));
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (failProvider)
        return Response.json(
          { error: { message: 'Fictional transient failure' } },
          { status: 503 },
        );
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 100 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
      });
    };
    // Auth also loads the AI module; keep every AI-dependent import after the test environment.
    const { hashToken } = await import('../src/auth.js'),
      { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js'),
      { guestIpBudgetKey } = await import('../src/usage.js'),
      { publicService } = await import('../src/domain.js');
    const app = createApp(),
      guest = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    const ip = () => {
      const value = `2001:db8:${randomUUID().slice(0, 4)}::${++requestIndex}`;
      ipAddresses.add(value);
      return value;
    };
    const bootstrap = async (agent: any = guest) => {
      const result = await agent.get('/api/v1/guest-preview').expect(200);
      for (const cookie of result.headers['set-cookie'] || []) {
        const match = /quotient_guest_preview=([^;]+)/.exec(cookie);
        if (match) {
          assert.match(cookie, /HttpOnly/);
          assert.match(cookie, /SameSite=Strict/);
          assert.match(cookie, /Path=\/api\/v1\/guest-preview/);
          const [row] = await rows('SELECT id FROM guest_preview_sessions WHERE proof_hash=?', [
            hashToken(decodeURIComponent(match[1])),
          ]);
          sessionIds.add(row.id);
          assert.equal(JSON.stringify(result.body).includes(match[1]), false);
        }
      }
      return result.body.data;
    };
    const post = async (content: string, requestId = randomUUID(), agent: any = guest) => {
      const response = await agent
        .post('/api/v1/guest-preview')
        .set('Origin', origin)
        .set('X-Forwarded-For', ip())
        .send({ content, requestId });
      if (response.body.data?.preview?.id) previewIds.add(response.body.data.preview.id);
      return response;
    };
    const claim = (id: string, version = 1, agent: any = guest) =>
      agent
        .post(`/api/v1/guest-preview/${id}/claim`)
        .set('Origin', origin)
        .send({ expectedVersion: version, approveIntake: true });
    try {
      await request(app)
        .post('/api/v1/guest-preview')
        .set('Origin', origin)
        .send({ content: 'I repair appliances.', requestId: randomUUID() })
        .expect(403);
      await request(app)
        .post('/api/v1/guest-preview')
        .set('Origin', 'https://untrusted.example')
        .send({ content: 'I repair appliances.', requestId: randomUUID() })
        .expect(403);
      await request(app)
        .post('/api/v1/guest-preview')
        .set('Origin', origin)
        .set('Cookie', `quotient_guest_preview=${'A'.repeat(43)}`)
        .send({ content: 'I repair appliances.', requestId: randomUUID() })
        .expect(403);
      assert.equal(providerCalls, 0);
      assert.equal((await bootstrap()).preview, null);
      const content =
        'I’m a photographer in Denver. I recently photographed a birthday portrait session and charged $180 because it was a brief shoot and included edited photos. I bill by the hour, but I did not record its hours.';
      answer = structuredClone(portraitAnswer);
      delete answer.offeringInterpretation;
      const missingOffering = (await post(content)).body.data.preview;
      assert.equal(missingOffering.readyToSave, false);
      assert.equal(
        missingOffering.receipt.name,
        null,
        'A missing live offering field never selects legacy scope',
      );
      answer = structuredClone(portraitAnswer);
      delete answer.historicalJobInterpretation;
      const missingHistory = (await post(content)).body.data.preview;
      assert.equal(missingHistory.readyToSave, true);
      assert.equal(
        missingHistory.receipt.example,
        null,
        'A missing live history field never rescues the old charge grammar',
      );
      assert.equal(missingHistory.receipt.sourcePriceText, null);
      assert.equal(providerCalls, 2, 'Two explicit mocked malformed-wire attempts only');
      answer = structuredClone(portraitAnswer);
      const requestId = randomUUID();
      const concurrent = await Promise.all([post(content, requestId), post(content, requestId)]);
      assert.deepEqual(concurrent.map((item) => item.status).sort(), [201, 202]);
      assert.equal(providerCalls, 3);
      const preview = concurrent.find((item) => item.status === 201)!.body.data.preview;
      assert.equal(preview.readyToSave, true);
      assert.equal(preview.version, 1);
      assert.equal(preview.receipt.sourcePriceText, '$180');
      assert.equal(preview.receipt.sourceCurrency, null);
      assert.equal(preview.receipt.example.finalPriceCents, null);
      assert.equal(preview.receipt.example.quantity, null);
      assert.equal(preview.receipt.example.description, historicalQuote);
      assert.equal(preview.receipt.example.rationale, '');
      assert.deepEqual(preview.questions, questions);
      const resumed = (await guest.get(`/api/v1/guest-preview?requestId=${requestId}`).expect(200))
        .body.data.preview;
      assert.equal(resumed.id, preview.id);
      assert.equal(resumed.content, content);
      assert.equal(providerCalls, 3);
      assert.equal((await post(content, requestId)).body.data.preview.id, preview.id);
      await post(content + ' changed', requestId).then((response) =>
        assert.equal(response.status, 409),
      );
      await claim(preview.id).expect(401);
      for (const agent of [guest, other]) {
        const registration = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Guest claim QA',
              businessName: 'Fictional Guest Claim QA',
              email: `qa-guest-claim-${randomUUID()}@example.test`,
              password: 'fictional-guest-claim123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registration.business.id);
      }
      const unrelated = (
        await guest.post('/api/v1/service-setup').set('Origin', origin).send({}).expect(201)
      ).body.data;
      await claim(preview.id, 2).expect(409);
      await guest
        .post(`/api/v1/guest-preview/${preview.id}/claim`)
        .set('Origin', origin)
        .send({ expectedVersion: 1, approveIntake: false })
        .expect(400);
      await guest
        .post(`/api/v1/guest-preview/${preview.id}/claim`)
        .set('Origin', origin)
        .send({ expectedVersion: 1, approveIntake: true, questions: ['Hidden replacement'] })
        .expect(400);
      assert.equal((await guest.get('/api/v1/services').expect(200)).body.data.length, 0);
      const claimed = await Promise.all([claim(preview.id), claim(preview.id)]);
      for (const result of claimed) assert.equal(result.status, 200, JSON.stringify(result.body));
      const saved = claimed[0].body.data;
      assert.deepEqual(claimed.map((item) => item.body.data.alreadyClaimed).sort(), [false, true]);
      assert.equal(claimed[1].body.data.service.id, saved.service.id);
      assert.equal(claimed[1].body.data.proposal.id, saved.proposal.id);
      assert.equal(saved.evidenceSaved, 'job_note');
      assert.equal(saved.service.version, 2);
      assert.equal(saved.service.name, 'Photographer');
      assert.equal(saved.service.description, 'Photography services.');
      assert.doesNotMatch(
        JSON.stringify(publicService(saved.service)),
        /birthday|Alice|\$180|discount|standard hourly rate/i,
        'Approved public scope excludes private historical example details',
      );
      assert.equal(saved.proposal.serviceVersion, 1);
      assert.equal(saved.proposal.appliedServiceVersion, saved.service.version);
      assert.equal(saved.proposal.status, 'applied');
      assert.deepEqual(saved.service.requiredInputs, questions);
      assert.deepEqual(saved.proposal.proposal.requiredInputs, questions);
      for (const field of [
        'unitPriceCents',
        'basePriceCents',
        'minimumChargeCents',
        'maxAutoQuoteCents',
      ])
        assert.equal(saved.service[field], 0);
      assert.equal(saved.service.mode, 'review');
      assert.equal(saved.service.publishedAt, null);
      assert.deepEqual(saved.service.pricingRules, []);
      assert.equal(saved.service.approvedVersion, null);
      assert.equal(saved.jobNote.sourcePriceText, '$180');
      assert.equal(saved.jobNote.sourceCurrency, null);
      assert.equal(saved.jobNote.finalPriceCents, null);
      assert.equal(saved.jobNote.sourceNotes, content);
      assert.equal(saved.jobNote.kind, 'historical_job');
      assert.equal(saved.jobNote.description, historicalQuote);
      assert.equal(saved.jobNote.rationale, '');
      assert.equal(providerCalls, 3);
      assert.deepEqual(saved.proposal.sourceExampleIds, []);
      assert.deepEqual(saved.proposal.sourceCaseIds, [saved.jobNote.id]);
      assert.equal(
        (await guest.get(`/api/v1/service-setup/${unrelated.id}`).expect(200)).body.data.status,
        'active',
        'Claim never overwrites an unrelated active setup',
      );
      const ownerDashboard = (await guest.get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(ownerDashboard.services.length, 1);
      assert.equal(ownerDashboard.examples.length, 0);
      assert.equal(ownerDashboard.jobNotes[0].sourcePriceText, '$180');
      const [scrubbed] = await rows('SELECT * FROM guest_previews WHERE id=?', [preview.id]);
      for (const field of [
        'source_text',
        'result_json',
        'usage_json',
        'error_json',
        'processing_token',
      ])
        assert.equal(scrubbed[field], null);
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM service_teaching_notes WHERE business_id=?', [
              businessIds[0],
            ])
          )[0].count,
        ),
        0,
        'Model questions never become owner-written policy notes',
      );
      const claimedGet = (
        await guest.get(`/api/v1/guest-preview?requestId=${requestId}`).expect(200)
      ).body.data.preview;
      assert.equal(claimedGet.status, 'claimed');
      assert.equal(claimedGet.version, 1);
      assert.equal(claimedGet.receipt, null);
      assert.equal(claimedGet.content, '');
      assert.equal(claimedGet.claim.serviceId, saved.service.id);
      await claim(preview.id, 1, other).expect(404);
      await claim(preview.id, 2, other).expect(404);
      const exported = (await guest.get('/api/v1/account/export').expect(200)).body.data;
      assert.equal(exported.records.guest_previews[0].id, preview.id);
      assert.equal('proof_hash' in exported.records.guest_previews[0], false);
      assert.equal('session_id' in exported.records.guest_previews[0], false);
      assert.equal('source_text' in exported.records.guest_previews[0], false);
      assert.equal(
        exported.records.usage_events.filter((item: any) => item.kind === 'ai_call').length,
        1,
        'Claim transfers usage without spending again',
      );
      assert.deepEqual(
        (await other.get('/api/v1/account/export').expect(200)).body.data.records.guest_previews,
        [],
      );
      await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [scrubbed.session_id]);
      const ownedRetry = (await claim(preview.id).expect(200)).body.data;
      assert.equal(ownedRetry.alreadyClaimed, true);
      assert.equal(
        ownedRetry.service.id,
        saved.service.id,
        'Owned receipt survives anonymous proof expiry',
      );
      await bootstrap();
      answer = {
        ...answer,
        draft: { ...answer.draft, example: { ...answer.draft.example, finalPriceCents: 18000 } },
        evidence: { ...answer.evidence, examplePrice: '$180 CAD' },
        historicalJobInterpretation: {
          ...answer.historicalJobInterpretation,
          quote: historicalQuote.replace('$180', '$180 CAD'),
        },
      };
      const foreign = (await post(content.replace('$180', '$180 CAD'))).body.data.preview;
      assert.equal(foreign.receipt.sourceCurrency, 'CAD');
      assert.equal(foreign.receipt.sourcePriceText, '$180 CAD');
      assert.equal(foreign.receipt.example.finalPriceCents, null);
      const foreignClaim = (await claim(foreign.id).expect(200)).body.data;
      assert.equal(foreignClaim.jobNote.sourceCurrency, 'CAD');
      assert.equal(foreignClaim.jobNote.sourcePriceText, '$180 CAD');
      assert.equal(foreignClaim.jobNote.finalPriceCents, null);
      answer = {
        reply: 'Review this driveway job and the customer questions.',
        draft: {
          name: 'Driveway cleaning',
          description: 'Cleaning concrete driveways',
          unitLabel: 'square foot',
          example: {
            title: 'Concrete driveway',
            description: 'A concrete driveway requiring extra preparation',
            quantity: 1000,
            finalPriceCents: 27500,
            rationale: 'because it needed extra preparation',
          },
        },
        evidence: {
          unitLabel: 'square foot',
          exampleQuantity: '1000 square foot',
          examplePrice: '$275 USD',
          singleProjectFixedTotal: false,
          singleProject: null,
        },
        offeringInterpretation: {
          classification: 'current',
          quote: 'I clean concrete driveways and quote by square foot.',
        },
        historicalJobInterpretation: {
          classification: 'actual_job',
          quote:
            'I cleaned a 1000 square foot driveway and charged $275 USD because it needed extra preparation.',
        },
        questions: [
          'Which surfaces need cleaning?',
          'What visible conditions should we know?',
          'What photos can you share?',
        ],
      };
      const usdContent =
        'I clean concrete driveways and quote by square foot. I cleaned a 1000 square foot driveway and charged $275 USD because it needed extra preparation.';
      const usdPreview = (await post(usdContent)).body.data.preview;
      assert.equal(usdPreview.receipt.sourceCurrency, 'USD');
      assert.equal(usdPreview.receipt.example.quantity, 1000);
      assert.equal(usdPreview.receipt.example.finalPriceCents, 27500);
      assert.equal(
        usdPreview.receipt.example.description,
        answer.historicalJobInterpretation.quote,
      );
      assert.equal(usdPreview.receipt.example.rationale, '');
      const usdClaim = (await claim(usdPreview.id).expect(200)).body.data;
      assert.equal(usdClaim.evidenceSaved, 'price_example');
      assert.equal(usdClaim.example.quantity, 1000);
      assert.equal(usdClaim.example.finalPriceCents, 27500);
      assert.equal(usdClaim.example.sourceNotes, usdContent);
      assert.equal(usdClaim.example.description, usdPreview.receipt.example.description);
      assert.equal(usdClaim.example.rationale, '');
      assert.equal(
        usdClaim.service.unitPriceCents,
        0,
        'One explicit historical total never becomes a reusable rate',
      );
      assert.equal(usdClaim.service.minimumChargeCents, 0);
      assert.equal(usdClaim.service.basePriceCents, 0);
      assert.deepEqual(usdClaim.service.requiredInputs, answer.questions);
      // A failed claim transaction preserves the same paid preview for explicit retry.
      await bootstrap(other);
      answer = structuredClone(portraitAnswer);
      const cappedPreview = (await post(content, randomUUID(), other)).body.data.preview;
      const fillers: string[] = [],
        values: string[] = [],
        parameters: (string | number)[] = [];
      for (let index = 0; index < 50; index++) {
        const serviceId = randomUUID();
        fillers.push(serviceId);
        values.push("(?,?,?,?,?,0,'[]','[]')");
        parameters.push(
          serviceId,
          businessIds[1],
          `Disposable limit ${index}`,
          'Fictional limit fixture',
          'project',
        );
      }
      await mutate(
        `INSERT INTO services(id,business_id,name,description,unit_label,max_auto_quote_cents,required_inputs_json,exclusions_json) VALUES ${values.join(',')}`,
        parameters,
      );
      const capped = await claim(cappedPreview.id, 1, other);
      assert.equal(capped.status, 422);
      assert.equal(capped.body.error.code, 'SERVICE_LIMIT');
      assert.equal(
        (await rows('SELECT status FROM guest_previews WHERE id=?', [cappedPreview.id]))[0].status,
        'ready',
      );
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM service_setup_sessions WHERE business_id=?', [
              businessIds[1],
            ])
          )[0].count,
        ),
        0,
        'A failed claim leaves no half-created setup',
      );
      assert.equal(
        Number(
          (
            await rows('SELECT COUNT(*) AS count FROM knowledge_proposals WHERE business_id=?', [
              businessIds[1],
            ])
          )[0].count,
        ),
        0,
      );
      await mutate('DELETE FROM services WHERE business_id=? AND id=?', [
        businessIds[1],
        fillers[0],
      ]);
      const callsBeforeClaimRetry = providerCalls;
      const cappedSaved = (await claim(cappedPreview.id, 1, other).expect(200)).body.data;
      assert.equal(cappedSaved.alreadyClaimed, false);
      assert.equal(
        providerCalls,
        callsBeforeClaimRetry,
        'Retrying a rolled-back claim uses its original result',
      );
      failProvider = true;
      const failedRequest = randomUUID(),
        beforeFailure = providerCalls;
      const failed = (
        await post(
          'I repair household appliances and need to inspect them before quoting.',
          failedRequest,
        )
      ).body.data.preview;
      assert.equal(failed.status, 'failed');
      assert.equal(
        providerCalls,
        beforeFailure + 1,
        'A transient failure is one paid attempt, not an automatic retry',
      );
      assert.equal(
        (
          await post(
            'I repair household appliances and need to inspect them before quoting.',
            failedRequest,
          )
        ).body.data.preview.status,
        'failed',
      );
      assert.equal(providerCalls, beforeFailure + 1);
      failProvider = false;
      const leaseId = randomUUID();
      await mutate(
        "INSERT INTO guest_previews(id,session_id,request_id,input_hash,source_text,status,processing_until,expires_at) VALUES (?,?,?,?,?,'processing',DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 20 MINUTE))",
        [
          leaseId,
          (await rows('SELECT session_id FROM guest_previews WHERE id=?', [failed.id]))[0]
            .session_id,
          randomUUID(),
          hashToken('I repair appliances.'),
          'I repair appliances.',
        ],
      );
      previewIds.add(leaseId);
      const interrupted = (await guest.get('/api/v1/guest-preview').expect(200)).body.data.preview;
      assert.equal(interrupted.id, leaseId);
      assert.equal(interrupted.status, 'failed');
      assert.equal(interrupted.content, 'I repair appliances.');
      assert.equal(providerCalls, beforeFailure + 1);
      await claim(leaseId).expect(409);
      const [expiredRow] = await rows('SELECT session_id FROM guest_previews WHERE id=?', [
        failed.id,
      ]);
      await mutate(
        'UPDATE guest_preview_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [expiredRow.session_id],
      );
      await claim(failed.id).expect(403);
      assert.equal(providerCalls, beforeFailure + 1);
    } finally {
      globalThis.fetch = originalFetch;
      const ids = [...previewIds];
      const reservations = ids.length
        ? await rows(
            `SELECT DATE_FORMAT(reservation_day,'%Y-%m-%d') AS day,COUNT(*) AS count FROM guest_previews WHERE id IN (${ids.map(() => '?').join(',')}) AND reserved_at IS NOT NULL GROUP BY reservation_day`,
            ids,
          )
        : [];
      await transaction(async (connection) => {
        for (const reservation of reservations) {
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
          for (const address of ipAddresses)
            await mutate(
              'DELETE FROM auth_rate_limits WHERE bucket_key=?',
              [hashToken(guestIpBudgetKey(address, String(reservation.day)))],
              connection,
            );
        }
      });
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
        assert.equal(
          (await rows('SELECT id FROM guest_previews WHERE claimed_business_id=?', [businessId]))
            .length,
          0,
          'Owned guest tombstones follow account deletion',
        );
      }
      for (const id of previewIds) await mutate('DELETE FROM guest_previews WHERE id=?', [id]);
      for (const id of sessionIds)
        await mutate('DELETE FROM guest_preview_sessions WHERE id=?', [id]);
      await closeDatabase();
    }
  },
);
