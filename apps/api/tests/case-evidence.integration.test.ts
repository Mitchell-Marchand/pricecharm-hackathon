import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { evaluateService } from '../src/domain.js';

test(
  'partial past jobs and inspection decisions are durable scoped cases, never invented numeric examples',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.TRUST_PROXY = '1';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'mock-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_BUSINESS_LIMIT = '100';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const originalFetch = globalThis.fetch,
      businessIds: string[] = [],
      inputs: any[] = [];
    let providerCalls = 0;
    const original =
      'I photograph small events and quote per hour. One recent job was a birthday party. I charged $180 but cannot remember how many hours it took.';
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      providerCalls++;
      const body = JSON.parse(String(init?.body)),
        input = JSON.parse(body.input[0].content[0].text);
      inputs.push(input);
      const setup = body.instructions.includes('introduce ONE service');
      const result = setup
        ? {
            reply: 'Review this past job note.',
            draft: {
              name: 'Event photography',
              description: 'Photographing small private events',
              unitLabel: 'hour',
              example: {
                title: 'Birthday party',
                description: 'Photographing one birthday party',
                quantity: null,
                finalPriceCents: 18000,
                rationale: '',
              },
            },
            evidence: {
              unitLabel: 'quote per hour',
              exampleQuantity: null,
              examplePrice: '$180',
              singleProjectFixedTotal: false,
              singleProject: null,
            },
          }
        : {
            unitLabel: null,
            unitPriceCents: 18000,
            basePriceCents: 18000,
            minimumChargeCents: 18000,
            requiredInputs: input.service.name.includes('photograph')
              ? ['event type', 'event date', 'coverage wanted']
              : ['problem description', 'visible symptoms', 'access'],
            exclusions: [],
            pricingRules: [
              {
                id: 'invented',
                name: 'Needs inspection',
                field: 'site visit',
                operator: 'not_equals',
                value: 'standard',
                kind: 'review',
                amount: 0,
              },
            ],
            explanation: 'Review the useful intake questions.',
            uncertainties: [],
          };
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
      });
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    let business: any,
      requestIndex = 0;
    try {
      for (const agent of [owner, other]) {
        const registration = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Case QA',
            businessName: 'Case QA Services',
            email: `qa-case-${randomUUID()}@example.test`,
            password: 'fictional-case-test123',
          })
          .expect(201);
        businessIds.push(registration.body.data.business.id);
        if (agent === owner) business = registration.body.data.business;
      }
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Photography and repair services', serviceArea: 'Austin' })
        .expect(200);
      const started = (
        await owner.post('/api/v1/service-setup').set('Origin', origin).send({}).expect(201)
      ).body.data;
      const drafted = (
        await owner
          .post(`/api/v1/service-setup/${started.id}/messages`)
          .set('Origin', origin)
          .send({ content: original, expectedVersion: 1 })
          .expect(200)
      ).body.data;
      assert.equal(drafted.draft.example.quantity, null);
      const confirmed = (
        await owner
          .post(`/api/v1/service-setup/${started.id}/confirm`)
          .set('Origin', origin)
          .send({ expectedVersion: 2 })
          .expect(200)
      ).body.data;
      assert.equal(confirmed.evidenceSaved, 'job_note');
      assert.equal(confirmed.example, undefined);
      assert.equal(confirmed.jobNote.quantity, null);
      assert.equal(confirmed.jobNote.unitLabel, 'hour');
      assert.equal(confirmed.jobNote.finalPriceCents, 18000);
      assert.equal(confirmed.jobNote.sourceNotes, original);
      const again = (
        await owner
          .post(`/api/v1/service-setup/${started.id}/confirm`)
          .set('Origin', origin)
          .send({ expectedVersion: 2 })
          .expect(200)
      ).body.data;
      assert.equal(again.evidenceSaved, 'job_note');
      assert.equal(again.jobNote.id, confirmed.jobNote.id);
      const dashboard = (await owner.get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(dashboard.examples.length, 0);
      assert.equal(dashboard.jobNotes.length, 1);
      assert.equal(dashboard.jobNotes[0].sourceNotes, original);
      assert.equal(dashboard.stats.examplesCount, 0);
      assert.deepEqual((await other.get('/api/v1/dashboard').expect(200)).body.data.jobNotes, []);
      await other.get(`/api/v1/service-setup/${started.id}`).expect(404);
      const learned = (
        await owner
          .post(`/api/v1/services/${confirmed.service.id}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++requestIndex}`)
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.deepEqual(learned.sourceExampleIds, []);
      assert.deepEqual(learned.sourceCaseIds, [confirmed.jobNote.id]);
      assert.equal(learned.proposal.unitPriceCents, 0);
      assert.equal(learned.proposal.basePriceCents, 0);
      assert.equal(learned.proposal.minimumChargeCents, 0);
      assert.deepEqual(learned.proposal.pricingRules, []);
      const learningInput = inputs.at(-1);
      assert.equal(learningInput.caseNotes[0].quantity, null);
      assert.equal(learningInput.caseNotes[0].finalPriceCents, 18000);
      assert.equal(learningInput.examples.length, 0);
      const repair = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Appliance repair',
            description: 'Repair appliances after inspection',
            unitLabel: 'project',
            unitPriceCents: 0,
            basePriceCents: 0,
            minimumChargeCents: 0,
            maxAutoQuoteCents: 0,
            requiredInputs: ['problem description'],
            exclusions: [],
          })
          .expect(201)
      ).body.data;
      const prior = (
        await owner
          .post(`/api/v1/services/${repair.id}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++requestIndex}`)
          .set('Origin', origin)
          .send({ notes: 'Difficult leaks need my inspection.' })
          .expect(201)
      ).body.data.proposal;
      const practiceId = randomUUID(),
        scenario = {
          title: 'Fictional appliance leak',
          customerName: 'Fictional Customer',
          description: 'The dishwasher leaks and the cause is unknown.',
          details: { quantity: '1' },
        };
      await mutate(
        'INSERT INTO training_sessions(id,business_id,service_id,service_version,scenario_json,unit_label) VALUES (?,?,?,?,?,?)',
        [practiceId, business.id, repair.id, repair.version, JSON.stringify(scenario), 'project'],
      );
      await mutate(
        "INSERT INTO messages(id,business_id,conversation_id,conversation_type,role,content) VALUES (?,?,?,'training','assistant',?)",
        [randomUUID(), business.id, practiceId, scenario.description],
      );
      const decision =
        'I need to visit before I can quote because I need to check the leak in person.';
      const callsBeforeDecision = providerCalls;
      const draft = (
        await owner
          .post(`/api/v1/training/${practiceId}/quote-draft`)
          .set('Origin', origin)
          .send({ content: decision })
          .expect(200)
      ).body.data;
      assert.equal(draft.outcome, 'inspection_required');
      assert.equal(draft.finalPriceCents, null);
      assert.equal(draft.rationale, decision);
      assert.equal(draft.readyToConfirm, true);
      assert.equal(providerCalls, callsBeforeDecision);
      const complete = {
        outcome: 'inspection_required',
        finalPriceCents: null,
        rationale: decision,
        saveAsExample: false,
      };
      await other
        .post(`/api/v1/training/${practiceId}/complete`)
        .set('Origin', origin)
        .send(complete)
        .expect(404);
      await owner
        .post(`/api/v1/training/${practiceId}/complete`)
        .set('Origin', origin)
        .send({ ...complete, finalPriceCents: 0 })
        .expect(400);
      await owner
        .post(`/api/v1/training/${practiceId}/complete`)
        .set('Origin', origin)
        .send({ ...complete, saveAsExample: true })
        .expect(400);
      const completed = await Promise.all(
        [0, 1].map(() =>
          owner
            .post(`/api/v1/training/${practiceId}/complete`)
            .set('Origin', origin)
            .send(complete),
        ),
      );
      assert.deepEqual(
        completed.map((result) => result.status),
        [200, 200],
      );
      for (const result of completed) {
        assert.equal(result.body.data.status, 'completed');
        assert.equal(result.body.data.outcome, 'inspection_required');
        assert.equal(result.body.data.finalPriceCents, null);
        assert.equal(result.body.data.rationale, decision);
        assert.equal(result.body.data.pricingProposal, undefined);
      }
      await owner
        .post(`/api/v1/training/${practiceId}/complete`)
        .set('Origin', origin)
        .send(complete)
        .expect(200);
      await owner
        .post(`/api/v1/training/${practiceId}/complete`)
        .set('Origin', origin)
        .send({ finalPriceCents: 0, rationale: decision })
        .expect(409);
      const [stored] = await rows('SELECT * FROM training_sessions WHERE id=? AND business_id=?', [
        practiceId,
        business.id,
      ]);
      assert.equal(stored.final_price_cents, null);
      assert.equal(stored.saved_example_id, null);
      assert.equal(stored.pricing_proposal_json, null);
      const [events] = await rows(
        "SELECT COUNT(*) count FROM usage_events WHERE business_id=? AND kind='training_decision_saved'",
        [business.id],
      );
      assert.equal(Number(events.count), 1);
      const [billed] = await rows(
        "SELECT COUNT(*) count FROM usage_events WHERE business_id=? AND kind='quote_delivered'",
        [business.id],
      );
      assert.equal(Number(billed.count), 0);
      const after = (await owner.get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(after.examples.length, 0);
      assert.equal(after.jobNotes.length, 2);
      assert.equal(after.stats.examplesCount, 0);
      const caseNote = after.jobNotes.find((note: any) => note.id === practiceId);
      assert.equal(caseNote.kind, 'inspection_required');
      assert.equal(caseNote.rationale, decision);
      assert.equal(caseNote.finalPriceCents, null);
      assert.equal(caseNote.sourceNotes, decision);
      const currentRepair = after.services.find((service: any) => service.id === repair.id);
      assert.equal(currentRepair.version, repair.version + 1);
      assert.equal(currentRepair.unitPriceCents, 0);
      const evaluation = evaluateService(currentRepair, [], after.business);
      assert.equal(evaluation.automaticReady, false);
      assert.equal(
        evaluation.checks.find((check) => check.name === 'Representative examples')?.passed,
        false,
      );
      await owner
        .post(`/api/v1/proposals/${prior.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      const caseProposal = (
        await owner
          .post(`/api/v1/services/${repair.id}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++requestIndex}`)
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.deepEqual(caseProposal.sourceCaseIds, [practiceId]);
      assert.deepEqual(caseProposal.sourceExampleIds, []);
      assert.equal(caseProposal.proposal.unitPriceCents, 0);
      assert.deepEqual(caseProposal.proposal.pricingRules, []);
      assert.equal(inputs.at(-1).caseNotes[0].rationale, decision);
      assert.equal(
        inputs.at(-1).ownerNotes.includes(decision),
        false,
        'A practice decision never becomes a general owner policy',
      );
      await owner
        .post(`/api/v1/services/${repair.id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic' })
        .expect(409);
      assert.equal((await owner.get('/api/v1/examples').expect(200)).body.data.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
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
