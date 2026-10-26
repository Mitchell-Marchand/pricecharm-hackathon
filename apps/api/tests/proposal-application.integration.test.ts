import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';

test(
  'unchanged proposal approval preserves live policy and exact applied version while every real policy change invalidates it',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'proposal-application-fixture-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const policy = {
      unitLabel: 'square feet',
      unitPriceCents: 25,
      basePriceCents: 500,
      minimumChargeCents: 10000,
      requiredInputs: ['area', 'surface', 'access'],
      exclusions: ['Roof work', 'Electrical work'],
      pricingRules: [
        {
          id: 'access',
          name: 'Restricted access',
          field: 'access',
          operator: 'equals',
          value: 'restricted',
          kind: 'review',
          amount: 0,
        },
        {
          id: 'surface',
          name: 'Stain treatment',
          field: 'surface',
          operator: 'equals',
          value: 'stained',
          kind: 'fixed',
          amount: 1000,
        },
      ],
    };
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async (url) => {
      providerCalls++;
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  ...policy,
                  explanation:
                    'The current customer questions and prices already match these jobs.',
                  uncertainties: [],
                }),
              },
            ],
          },
        ],
      });
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js'),
      { serviceById, businessById, examplesForBusiness, testCasesForService, json } =
        await import('../src/models.js'),
      { evaluateService, classifierSignature } = await import('../src/domain.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    let slug = '';
    const createService = async (fields: object = policy) =>
      (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Concrete cleaning',
            description: 'Concrete driveway cleaning',
            maxAutoQuoteCents: 50000,
            ...fields,
          })
          .expect(201)
      ).body.data;
    const current = (id: string) => serviceById(businessIds[0], id);
    const serviceSnapshot = async (id: string) =>
      JSON.stringify(
        await rows('SELECT * FROM services WHERE business_id=? AND id=?', [businessIds[0], id]),
      );
    const publish = (id: string, mode: 'review' | 'automatic' = 'review') =>
      owner
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode, ...(mode === 'automatic' ? { approveAutomatic: true } : {}) })
        .expect(200);
    const apply = (id: string, agent = owner) =>
      agent.post(`/api/v1/proposals/${id}/apply`).set('Origin', origin).send({});
    const seedProposal = async (
      serviceId: string,
      changes: object = {},
      version?: number,
      revision?: number,
    ) => {
      const service = await current(serviceId),
        id = randomUUID();
      const [row] = await rows('SELECT teaching_revision FROM services WHERE id=?', [serviceId]);
      const data = {
        unitLabel: service.unitLabel,
        unitPriceCents: service.unitPriceCents,
        basePriceCents: service.basePriceCents,
        minimumChargeCents: service.minimumChargeCents,
        requiredInputs: service.requiredInputs,
        exclusions: service.exclusions,
        pricingRules: service.pricingRules,
        explanation: 'A separately reviewed proposal',
        uncertainties: ['A private advisory note'],
        ...changes,
      };
      await mutate(
        'INSERT INTO knowledge_proposals(id,business_id,service_id,service_version,teaching_revision,proposal_json,source_ids_json) VALUES (?,?,?,?,?,?,?)',
        [
          id,
          businessIds[0],
          serviceId,
          version ?? service.version,
          revision ?? Number(row.teaching_revision),
          JSON.stringify(data),
          '[]',
        ],
      );
      return id;
    };
    const audit = (id: string) =>
      rows(
        "SELECT metadata_json FROM usage_events WHERE business_id=? AND kind='pricing_proposal_applied' AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.proposalId'))=?",
        [businessIds[0], id],
      );
    try {
      for (const agent of [owner, other]) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Proposal application QA',
              businessName: 'Fictional policy QA',
              email: `qa-proposal-${randomUUID()}@example.test`,
              password: 'proposal-fixture-password123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registered.business.id);
        if (agent === owner) slug = registered.business.slug;
      }
      await mutate('UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE business_id=?', [
        businessIds[0],
      ]);
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Concrete cleaning', serviceArea: 'Austin' })
        .expect(200);
      const review = await createService();
      await publish(review.id);
      await owner
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId: review.id,
          title: 'Private past job',
          description: 'A completed concrete driveway',
          quantity: 400,
          unitLabel: 'square feet',
          finalPriceCents: 10500,
          rationale: 'Routine washing',
          inputs: { area: '400', surface: 'concrete', access: 'easy' },
        })
        .expect(201);
      const before = await serviceSnapshot(review.id),
        beforeService = await current(review.id),
        profile = (await request(app).get(`/api/v1/public/${slug}`).expect(200)).body.data;
      assert.ok(beforeService.publishedAt, 'Private evidence keeps reviewed intake published');
      const learned = (
        await owner
          .post(`/api/v1/services/${review.id}/learn`)
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.equal(learned.appliedServiceVersion, null);
      assert.equal(await serviceSnapshot(review.id), before);
      const approvals = await Promise.all([apply(learned.id), apply(learned.id)]);
      for (const response of approvals) {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.proposal.status, 'applied');
        assert.equal(response.body.data.proposal.appliedServiceVersion, beforeService.version);
        assert.equal(response.body.data.proposal.serviceVersion, beforeService.version);
      }
      assert.equal(
        await serviceSnapshot(review.id),
        before,
        'An unchanged Apply never writes the service row',
      );
      await apply(learned.id).expect(200);
      const savedAudits = await audit(learned.id);
      assert.equal(savedAudits.length, 1, 'Concurrent Apply and retries audit once');
      assert.equal(json(savedAudits[0].metadata_json, {}).policyChanged, false);
      assert.equal(
        json(savedAudits[0].metadata_json, {}).appliedServiceVersion,
        beforeService.version,
      );
      const restored = (
        await owner.get(`/api/v1/services/${review.id}/proposals`).expect(200)
      ).body.data.proposals.find((item: any) => item.id === learned.id);
      assert.equal(restored.appliedServiceVersion, beforeService.version);
      assert.deepEqual(
        (await request(app).get(`/api/v1/public/${slug}`).expect(200)).body.data,
        profile,
      );
      await request(app)
        .post(`/api/v1/public/${slug}/sessions`)
        .send({ serviceId: review.id })
        .expect(201);
      assert.equal(
        providerCalls,
        1,
        'Apply, recovery, public access and retries never run the model',
      );

      const omittedUnit = await seedProposal(review.id, { unitLabel: null });
      await apply(omittedUnit).expect(200);
      assert.equal(
        await serviceSnapshot(review.id),
        before,
        'Missing proposal unit means the current unit',
      );
      const unauthorized = await seedProposal(review.id);
      await apply(unauthorized, other).expect(404);
      await request(app)
        .post(`/api/v1/proposals/${unauthorized}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(401);
      const stale = await seedProposal(review.id, {}, beforeService.version - 1);
      assert.equal((await apply(stale).expect(409)).body.error.code, 'STALE_PROPOSAL');
      const invalid = await seedProposal(review.id, { requiredInputs: ['area'] });
      assert.equal((await apply(invalid).expect(422)).body.error.code, 'MISSING_RULE_INPUT');
      assert.equal(await serviceSnapshot(review.id), before);
      const oldTeaching = await seedProposal(review.id);
      await mutate(
        'INSERT INTO service_teaching_notes(id,business_id,service_id,revision,content,pricing_snapshot_json) VALUES (?,?,?,?,?,?)',
        [
          randomUUID(),
          businessIds[0],
          review.id,
          1,
          'An owner clarification not yet applied',
          '{}',
        ],
      );
      await mutate('UPDATE services SET teaching_revision=1 WHERE id=?', [review.id]);
      assert.equal((await apply(oldTeaching).expect(409)).body.error.code, 'TEACHING_CHANGED');
      assert.equal(
        (await apply(learned.id).expect(409)).body.error.code,
        'TEACHING_CHANGED',
        'Applied retry retains the existing newer-teaching guard',
      );

      const changes: [string, object][] = [
        ['unit', { unitLabel: 'linear feet' }],
        ['rate', { unitPriceCents: 26 }],
        ['base', { basePriceCents: 600 }],
        ['minimum', { minimumChargeCents: 11000 }],
        ['questions', { requiredInputs: [...policy.requiredInputs, 'visible damage'] }],
        ['question order', { requiredInputs: [...policy.requiredInputs].reverse() }],
        ['exclusions', { exclusions: [...policy.exclusions, 'Lead paint'] }],
        ['exclusion order', { exclusions: [...policy.exclusions].reverse() }],
        ['rule order', { pricingRules: [...policy.pricingRules].reverse() }],
        ...Object.entries({
          id: 'different-access-id',
          name: 'Owner review for access',
          field: 'surface',
          operator: 'not_equals',
          value: 'easy',
        }).map(([field, value]): [string, object] => [
          `rule ${field}`,
          { pricingRules: [{ ...policy.pricingRules[0], [field]: value }, policy.pricingRules[1]] },
        ]),
        [
          'rule kind',
          {
            pricingRules: [policy.pricingRules[0], { ...policy.pricingRules[1], kind: 'per_unit' }],
          },
        ],
        [
          'rule amount',
          { pricingRules: [policy.pricingRules[0], { ...policy.pricingRules[1], amount: 1100 }] },
        ],
      ];
      for (const [label, change] of changes) {
        const service = await createService();
        await publish(service.id);
        const proposalId = await seedProposal(service.id, change);
        const response = (await apply(proposalId).expect(200)).body.data;
        assert.equal(response.service.version, service.version + 1, label);
        assert.equal(response.service.publishedAt, null, label);
        assert.equal(response.service.approvedVersion, null, label);
        assert.equal(response.proposal.appliedServiceVersion, response.service.version, label);
        assert.equal(
          json((await audit(proposalId))[0].metadata_json, {}).policyChanged,
          true,
          label,
        );
        const after = await serviceSnapshot(service.id);
        await apply(proposalId).expect(200);
        assert.equal(await serviceSnapshot(service.id), after, `${label}: retry is immutable`);
        assert.equal((await audit(proposalId)).length, 1, label);
      }

      const automatic = await createService({
        ...policy,
        basePriceCents: 0,
        pricingRules: [],
        requiredInputs: ['area'],
        exclusions: ['Roof cleaning'],
      });
      for (const quantity of [400, 600, 800]) {
        await owner
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId: automatic.id,
            title: `Historical ${quantity}`,
            description: 'Routine concrete cleaning',
            quantity,
            finalPriceCents: quantity * 25,
            rationale: 'Approved standard rate',
            inputs: { area: String(quantity), location: 'Austin' },
          })
          .expect(201);
      }
      for (const quantity of [500, 700, 900]) {
        await owner
          .post(`/api/v1/services/${automatic.id}/test-cases`)
          .set('Origin', origin)
          .send({
            title: `Independent ${quantity}`,
            description: `A new concrete driveway of ${quantity} square feet`,
            quantity,
            expectedCents: quantity * 25,
            expectedOutcome: 'quote',
            inputs: { area: String(quantity), location: 'Austin' },
          })
          .expect(201);
      }
      await owner
        .post(`/api/v1/services/${automatic.id}/test-cases`)
        .set('Origin', origin)
        .send({
          title: 'Excluded roof handoff',
          description: 'Roof cleaning requested',
          quantity: 500,
          expectedCents: 0,
          expectedOutcome: 'review',
          inputs: { area: '500', location: 'Austin' },
        })
        .expect(201);
      const automaticPolicy = await current(automatic.id),
        evaluation = evaluateService(
          automaticPolicy,
          await examplesForBusiness(businessIds[0], automatic.id),
          await businessById(businessIds[0]),
          await testCasesForService(businessIds[0], automatic.id),
        );
      assert.equal(evaluation.deterministicReady, true, JSON.stringify(evaluation));
      const result = {
        ...evaluation,
        id: randomUUID(),
        automaticReady: true,
        languageEvaluation: { ...classifierSignature('openai'), passed: true, caseCount: 4 },
      };
      await mutate(
        'INSERT INTO evaluations(id,business_id,service_id,service_version,passed,result_json) VALUES (?,?,?,?,?,?)',
        [
          result.id,
          businessIds[0],
          automatic.id,
          automaticPolicy.version,
          true,
          JSON.stringify(result),
        ],
      );
      await publish(automatic.id, 'automatic');
      const approved = await serviceSnapshot(automatic.id),
        approvedProposal = await seedProposal(automatic.id);
      await apply(approvedProposal).expect(200);
      assert.equal(
        await serviceSnapshot(automatic.id),
        approved,
        'Identical approved automatic policy keeps its exact approval and evaluation binding',
      );
      const realAutomaticChange = await seedProposal(automatic.id, { unitPriceCents: 26 });
      await apply(realAutomaticChange).expect(200);
      const invalidated = await current(automatic.id);
      assert.equal(invalidated.publishedAt, null);
      assert.equal(invalidated.approvedVersion, null);
      assert.equal(invalidated.approvedAt, null);
      const appliedHistory = (
        await owner.get(`/api/v1/services/${automatic.id}/proposals`).expect(200)
      ).body.data.proposals;
      assert.equal(
        appliedHistory.find((item: any) => item.id === approvedProposal).appliedServiceVersion,
        automaticPolicy.version,
        'A later policy edit cannot move an earlier applied-version binding',
      );
      const cleared = await serviceSnapshot(automatic.id),
        clearedProposal = await seedProposal(automatic.id);
      await apply(clearedProposal).expect(200);
      assert.equal(
        await serviceSnapshot(automatic.id),
        cleared,
        'No-op approval never restores an approval cleared by a real policy change',
      );
      assert.equal(providerCalls, 1);
    } finally {
      globalThis.fetch = realFetch;
      for (const businessId of businessIds) {
        await transaction(async (connection) => {
          for (const day of await rows(
            "SELECT DATE(created_at) AS day,COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation' GROUP BY DATE(created_at)",
            [businessId],
            connection,
          )) {
            await rows(
              'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day=? FOR UPDATE',
              [day.day],
              connection,
            );
            await mutate(
              'UPDATE ai_daily_budgets SET total_reserved=GREATEST(0,total_reserved-?) WHERE budget_day=?',
              [Number(day.count), day.day],
              connection,
            );
          }
        });
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
