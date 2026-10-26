import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'saved automation checks recover without AI or writes and preparation preserves only owner-review publication',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'readiness-fixture-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('Readiness and preparation must not contact a provider');
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js'),
      { serviceById, businessById, examplesForBusiness, testCasesForService } =
        await import('../src/models.js'),
      { evaluateService, classifierSignature } = await import('../src/domain.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    let serviceId = '',
      slug = '';
    const patch = (body: object) =>
      owner.patch(`/api/v1/services/${serviceId}`).set('Origin', origin).send(body);
    const publish = (mode: 'review' | 'automatic') =>
      owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode, ...(mode === 'automatic' ? { approveAutomatic: true } : {}) });
    const current = () => serviceById(businessIds[0], serviceId);
    const readiness = () => owner.get(`/api/v1/services/${serviceId}/readiness`).expect(200);
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          rows('SELECT * FROM services WHERE business_id=? ORDER BY id', [businessIds[0]]),
          rows('SELECT * FROM evaluations WHERE business_id=? ORDER BY id', [businessIds[0]]),
          rows('SELECT * FROM service_test_cases WHERE business_id=? ORDER BY id', [
            businessIds[0],
          ]),
          rows('SELECT * FROM usage_events WHERE business_id=? ORDER BY id', [businessIds[0]]),
          rows('SELECT * FROM ai_daily_budgets ORDER BY budget_day'),
        ]),
      );
    const addCase = (quantity: number) =>
      owner
        .post(`/api/v1/services/${serviceId}/test-cases`)
        .set('Origin', origin)
        .send({
          title: `Independent driveway ${quantity}`,
          description: `A previously unseen concrete driveway of ${quantity} square feet`,
          quantity,
          expectedCents: quantity * 25,
          expectedOutcome: 'quote',
          inputs: { area: String(quantity), location: 'Austin' },
        });
    const saveEvaluation = async () => {
      const service = await current();
      const result = evaluateService(
        service,
        await examplesForBusiness(businessIds[0], serviceId),
        await businessById(businessIds[0]),
        await testCasesForService(businessIds[0], serviceId),
      );
      assert.equal(result.deterministicReady, true, JSON.stringify(result));
      const evaluation = {
        ...result,
        id: randomUUID(),
        automaticReady: true,
        languageEvaluation: { ...classifierSignature('openai'), passed: true, caseCount: 4 },
      };
      await mutate(
        'INSERT INTO evaluations(id,business_id,service_id,service_version,passed,result_json) VALUES (?,?,?,?,?,?)',
        [
          evaluation.id,
          businessIds[0],
          serviceId,
          service.version,
          true,
          JSON.stringify(evaluation),
        ],
      );
      return evaluation;
    };
    const assertReviewLink = async () => {
      const profile = (await request(app).get(`/api/v1/public/${slug}`).expect(200)).body.data;
      assert.equal(
        profile.services.find((service: any) => service.id === serviceId)?.mode,
        'review',
      );
      const session = await request(app)
        .post(`/api/v1/public/${slug}/sessions`)
        .set('Origin', origin)
        .send({ serviceId })
        .expect(201);
      assert.equal(session.body.data.session.serviceId, serviceId);
    };
    try {
      for (const agent of [owner, other]) {
        const result = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Readiness QA',
              businessName: 'Fictional readiness QA',
              email: `qa-readiness-${randomUUID()}@example.test`,
              password: 'readiness-fixture-password123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(result.business.id);
        if (agent === owner) slug = result.business.slug;
      }
      await mutate('UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE business_id=?', [
        businessIds[0],
      ]);
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Concrete driveway cleaning', serviceArea: 'Austin' })
        .expect(200);
      const created = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Driveway cleaning',
            description: 'Concrete driveway cleaning',
            unitLabel: 'square feet',
            unitPriceCents: 25,
            basePriceCents: 0,
            minimumChargeCents: 10000,
            maxAutoQuoteCents: 30000,
            requiredInputs: ['area'],
            exclusions: ['Roof cleaning'],
          })
          .expect(201)
      ).body.data;
      serviceId = created.id;
      for (const quantity of [400, 600, 800])
        await owner
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId,
            title: `Historical ${quantity}`,
            description: `Previously completed driveway ${quantity}`,
            quantity,
            finalPriceCents: quantity * 25,
            rationale: 'Routine concrete washing',
          })
          .expect(201);
      for (const quantity of [500, 700, 900]) await addCase(quantity).expect(201);
      await owner
        .post(`/api/v1/services/${serviceId}/test-cases`)
        .set('Origin', origin)
        .send({
          title: 'Roof handoff',
          description: 'Customer requests roof cleaning',
          quantity: 500,
          expectedCents: 0,
          expectedOutcome: 'review',
          inputs: { area: '500', location: 'Austin' },
        })
        .expect(201);
      const published = (await publish('review').expect(200)).body.data;
      const initial = (await readiness()).body.data;
      assert.equal(initial.invalidation, 'not_evaluated');
      assert.equal(initial.evaluation, null);
      const evaluation = await saveEvaluation();
      const beforeRead = await snapshot();
      for (let attempt = 0; attempt < 2; attempt++) {
        const recovered = (await readiness()).body.data;
        assert.equal(recovered.evaluation.id, evaluation.id);
        assert.equal(recovered.evaluationCurrent, true);
        assert.equal(recovered.invalidation, null);
        assert.equal(recovered.published, true);
        assert.equal(recovered.approvalCurrent, false);
        assert.equal(recovered.autoQuoteEnabled, false);
      }
      await other.get(`/api/v1/services/${serviceId}/readiness`).expect(404);
      await request(app).get(`/api/v1/services/${serviceId}/readiness`).expect(401);
      assert.equal(
        await snapshot(),
        beforeRead,
        'GET must not mutate policy, results, cases, usage or AI budgets',
      );
      assert.equal(providerCalls, 0);

      process.env.OPENAI_MODEL = 'changed-readiness-model';
      assert.equal((await readiness()).body.data.invalidation, 'model_changed');
      await publish('automatic').expect(409);
      process.env.OPENAI_MODEL = evaluation.languageEvaluation.model;
      await mutate('UPDATE evaluations SET result_json=? WHERE id=?', [
        JSON.stringify({ ...evaluation, engineVersion: 'old-engine' }),
        evaluation.id,
      ]);
      assert.equal((await readiness()).body.data.invalidation, 'engine_changed');
      await publish('automatic').expect(409);
      await mutate('UPDATE evaluations SET result_json=? WHERE id=?', [
        JSON.stringify(evaluation),
        evaluation.id,
      ]);
      const beforeNoOp = await snapshot();
      await patch({
        maxAutoQuoteCents: published.maxAutoQuoteCents,
        expectedVersion: published.version,
      }).expect(200);
      assert.equal(await snapshot(), beforeNoOp, 'Saving the unchanged cap is a true no-op');
      await patch({
        maxAutoQuoteCents: published.maxAutoQuoteCents,
        expectedVersion: published.version - 1,
      }).expect(409);
      const capped = (
        await patch({ maxAutoQuoteCents: 50000, expectedVersion: published.version }).expect(200)
      ).body.data;
      assert.equal(capped.version, published.version + 1);
      assert.equal(capped.publishedAt, published.publishedAt);
      assert.equal(capped.approvedVersion, null);
      const stale = (await readiness()).body.data;
      assert.equal(stale.invalidation, 'policy_changed');
      assert.equal(stale.evaluation.id, evaluation.id);
      assert.equal(stale.evaluationCurrent, false);
      await publish('automatic').expect(409);
      await assertReviewLink();
      const extra = (await addCase(1000).expect(201)).body.data;
      assert.equal((await current()).publishedAt, published.publishedAt);
      await assertReviewLink();
      await owner
        .delete(`/api/v1/services/${serviceId}/test-cases/${extra.id}`)
        .set('Origin', origin)
        .expect(200);
      assert.equal((await current()).publishedAt, published.publishedAt);
      await assertReviewLink();

      await saveEvaluation();
      const activated = (await publish('automatic').expect(200)).body.data;
      assert.equal((await readiness()).body.data.approvalCurrent, true);
      const approvedSnapshot = await snapshot();
      await patch({
        maxAutoQuoteCents: activated.maxAutoQuoteCents,
        expectedVersion: activated.version,
      }).expect(200);
      assert.equal(
        await snapshot(),
        approvedSnapshot,
        'Unchanged cap preserves an existing automatic approval',
      );
      await patch({ maxAutoQuoteCents: 60000, expectedVersion: activated.version }).expect(200);
      assert.equal((await current()).publishedAt, null);
      assert.equal((await current()).approvedVersion, null);
      await saveEvaluation();
      await publish('automatic').expect(200);
      const autoCase = (await addCase(1000).expect(201)).body.data;
      assert.equal((await current()).publishedAt, null);
      await saveEvaluation();
      await publish('automatic').expect(200);
      await owner
        .delete(`/api/v1/services/${serviceId}/test-cases/${autoCase.id}`)
        .set('Origin', origin)
        .expect(200);
      assert.equal((await current()).publishedAt, null);

      await publish('review').expect(200);
      await patch({ unitPriceCents: 30 }).expect(200);
      assert.equal(
        (await current()).publishedAt,
        null,
        'Rate changes retain their publication invalidation',
      );
      await publish('review').expect(200);
      await patch({ description: 'Updated concrete washing scope' }).expect(200);
      assert.equal(
        (await current()).publishedAt,
        null,
        'Scope changes retain their publication invalidation',
      );
      await publish('review').expect(200);
      const beforeHistory = await current();
      await owner
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId,
          title: 'Another historical job',
          description: 'A different completed driveway',
          quantity: 1200,
          finalPriceCents: 36000,
          rationale: 'Routine washing',
        })
        .expect(201);
      assert.equal(
        (await current()).publishedAt,
        beforeHistory.publishedAt,
        'Private history stales automatic readiness without interrupting reviewed intake',
      );
      assert.equal((await current()).version, beforeHistory.version + 1);
      assert.equal(providerCalls, 0);
    } finally {
      globalThis.fetch = realFetch;
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
