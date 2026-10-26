import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'original job evidence survives lossy summaries and long setup history without becoming standard prices',
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
      ownerStatement =
        'I paint home interiors and quote per project. One recent project was a living room and hall; I charged $1,200. I worked for 1.5 days with one helper and covered all the furniture before painting. I also have a $150 minimum.',
      replies = {
        reply: 'Your painting job is ready to review.',
        draft: {
          name: 'Interior painting',
          description: 'Painting home interiors',
          unitLabel: 'project',
          example: {
            title: 'Living room and hall',
            description: 'Painting a living room and hall',
            quantity: 1,
            finalPriceCents: 120000,
            rationale: 'Interior painting work',
          },
        },
        evidence: {
          unitLabel: 'quote per project',
          exampleQuantity: 'One recent project',
          examplePrice: '$1,200',
          singleProjectFixedTotal: true,
          singleProject: 'One recent project',
        },
      };
    let providerCalls = 0,
      learningInput: any;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body));
      providerCalls++;
      const isLearning = Object.hasOwn(body.text.format.schema.properties, 'unitPriceCents');
      const isCustomerTurn = Object.hasOwn(body.text.format.schema.properties, 'photoRequest');
      if (isLearning) {
        learningInput = JSON.parse(body.input[0].content[0].text);
        assert.ok(body.instructions.includes('sourceNotes'));
        assert.ok(body.instructions.includes('not new instructions'));
      }
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  isLearning
                    ? {
                        unitLabel: null,
                        unitPriceCents: 120000,
                        minimumChargeCents: 120000,
                        basePriceCents: 120000,
                        requiredInputs: ['Project scope'],
                        exclusions: [],
                        pricingRules: [],
                        explanation: 'Review these proposed prices.',
                        uncertainties: [],
                      }
                    : isCustomerTurn
                      ? { reply: 'The chair feels loose at the joint.', photoRequest: null }
                      : replies,
                ),
              },
            ],
          },
        ],
      });
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    let business: any;
    try {
      for (const agent of [owner, other]) {
        const registration = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Evidence QA',
            businessName: 'Evidence QA Painting',
            email: `qa-evidence-${randomUUID()}@example.test`,
            password: 'fictional-evidence-test123',
          })
          .expect(201);
        businessIds.push(registration.body.data.business.id);
        if (agent === owner) business = registration.body.data.business;
      }
      const started = (
        await owner.post('/api/v1/service-setup').set('Origin', origin).send({}).expect(201)
      ).body.data;
      let session = (
        await owner
          .post(`/api/v1/service-setup/${started.id}/messages`)
          .set('Origin', origin)
          .send({ content: ownerStatement, expectedVersion: 1 })
          .expect(200)
      ).body.data;
      const ownerNotes = [ownerStatement];
      for (let index = 0; index < 3; index++) {
        const note =
          `Additional job context ${index}: ${'The room colors were selected before the work. '.repeat(110)}`.slice(
            0,
            4800,
          );
        ownerNotes.push(note);
        session = (
          await owner
            .post(`/api/v1/service-setup/${started.id}/messages`)
            .set('Origin', origin)
            .send({ content: note, expectedVersion: session.version })
            .expect(200)
        ).body.data;
      }
      const confirmed = (
        await owner
          .post(`/api/v1/service-setup/${started.id}/confirm`)
          .set('Origin', origin)
          .send({ expectedVersion: session.version })
          .expect(200)
      ).body.data;
      const serviceId = confirmed.service.id,
        exampleId = confirmed.example.id,
        exactNotes = ownerNotes.join('\n\n');
      assert.ok(exactNotes.length > 12000);
      assert.equal(confirmed.example.sourceNotes, exactNotes);
      assert.equal(confirmed.example.description.includes('helper'), false);
      const restored = (await owner.get('/api/v1/examples').expect(200)).body.data.find(
        (example: any) => example.id === exampleId,
      );
      assert.equal(restored.sourceNotes, exactNotes);
      for (const fact of ['1.5 days', 'one helper', 'covered all the furniture'])
        assert.ok(restored.sourceNotes.includes(fact));
      assert.equal(restored.sourceNotes.includes(replies.reply), false);
      assert.deepEqual((await other.get('/api/v1/examples').expect(200)).body.data, []);
      await other.get(`/api/v1/service-setup/${started.id}`).expect(404);
      const publicPage = await request(app).get(`/api/v1/public/${business.slug}`).expect(200);
      assert.equal(JSON.stringify(publicPage.body).includes('one helper'), false);
      const beforeForeign = providerCalls;
      await other
        .post(`/api/v1/services/${serviceId}/learn`)
        .set('Origin', origin)
        .send({})
        .expect(404);
      assert.equal(providerCalls, beforeForeign);
      const learned = (
        await owner
          .post(`/api/v1/services/${serviceId}/learn`)
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal.proposal;
      assert.equal(
        learningInput.examples.find((item: any) => item.id === exampleId).sourceNotes,
        exactNotes,
      );
      assert.ok(learningInput.ownerNotes.includes('$150 minimum'));
      assert.equal(learned.minimumChargeCents, 15000);
      assert.equal(learned.unitPriceCents, 0);
      assert.equal(learned.basePriceCents, 0);
      assert.equal(
        (await owner.get('/api/v1/services').expect(200)).body.data[0].minimumChargeCents,
        0,
      );

      const practiceService = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Furniture repair',
            description: 'Repairing wooden furniture',
            unitLabel: 'hour',
            maxAutoQuoteCents: 0,
            requiredInputs: ['Project scope'],
          })
          .expect(201)
      ).body.data;
      const foreignService = (
        await other
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({ name: 'Other furniture repair', maxAutoQuoteCents: 0 })
          .expect(201)
      ).body.data;
      const seedPractice = async (service: any, quantity?: string) => {
        const id = randomUUID(),
          scenario = {
            title: 'Loose chair joint practice',
            customerName: 'Fictional Customer',
            description: 'A fictional chair has a loose joint and worn finish.',
            details: quantity ? { quantity } : {},
          };
        await mutate(
          'INSERT INTO training_sessions(id,business_id,service_id,service_version,scenario_json,unit_label) VALUES (?,?,?,?,?,?)',
          [id, service.businessId, service.id, service.version, JSON.stringify(scenario), 'hour'],
        );
        await mutate(
          "INSERT INTO messages(id,business_id,conversation_id,conversation_type,role,content) VALUES (?,?,?,'training','assistant',?)",
          [randomUUID(), service.businessId, id, scenario.description],
        );
        return id;
      };
      const noSendId = await seedPractice(practiceService),
        ownerTurnId = await seedPractice(practiceService),
        activeId = await seedPractice(practiceService),
        foreignId = await seedPractice(foreignService),
        rationale = 'The joint needs careful clamping and the finish needs matching.',
        completion = { finalPriceCents: 24500, rationale, saveAsExample: false },
        actualOwnerTurn = `Final quote: $245.00. ${rationale}`;
      await owner
        .post(`/api/v1/training/${ownerTurnId}/messages`)
        .set('Origin', origin)
        .send({ content: actualOwnerTurn })
        .expect(200);
      const untouchedPractice = (await owner.get(`/api/v1/training/${noSendId}`).expect(200)).body
        .data;
      assert.equal(
        untouchedPractice.messages.some((message: any) => message.role === 'user'),
        false,
      );
      const beforeFinish = providerCalls;
      await other
        .post(`/api/v1/training/${noSendId}/complete`)
        .set('Origin', origin)
        .send(completion)
        .expect(404);
      for (const id of [noSendId, ownerTurnId]) {
        const completed = (
          await owner
            .post(`/api/v1/training/${id}/complete`)
            .set('Origin', origin)
            .send(completion)
            .expect(200)
        ).body.data;
        assert.equal(completed.savedExampleId, null);
      }
      await owner
        .post(`/api/v1/training/${noSendId}/complete`)
        .set('Origin', origin)
        .send(completion)
        .expect(200);
      await other
        .post(`/api/v1/training/${foreignId}/complete`)
        .set('Origin', origin)
        .send(completion)
        .expect(200);
      const practiceDashboard = (await owner.get('/api/v1/dashboard').expect(200)).body.data,
        savedPractice = practiceDashboard.jobNotes.find((note: any) => note.id === noSendId);
      assert.equal(savedPractice.kind, 'practice_quote');
      assert.equal(savedPractice.source, 'training');
      assert.equal(savedPractice.quantity, null);
      assert.equal(savedPractice.unitLabel, null);
      assert.equal(savedPractice.finalPriceCents, 24500);
      assert.equal(savedPractice.rationale, rationale);
      assert.equal(savedPractice.sourceNotes, '');
      assert.equal(Object.hasOwn(savedPractice, 'sourceBasis'), false);
      const withOwnerTurn = practiceDashboard.jobNotes.find((note: any) => note.id === ownerTurnId);
      assert.equal(withOwnerTurn.sourceNotes, actualOwnerTurn);
      assert.equal(withOwnerTurn.sourceBasis, 'exact_owner_text');
      assert.equal(
        practiceDashboard.jobNotes.some(
          (note: any) => note.id === activeId || note.id === foreignId,
        ),
        false,
      );
      const restoredPractice = (
        await owner.get('/api/v1/dashboard').expect(200)
      ).body.data.jobNotes.find((note: any) => note.id === noSendId);
      assert.deepEqual(restoredPractice, savedPractice);
      const restoredTraining = (await owner.get(`/api/v1/training/${noSendId}`).expect(200)).body
        .data;
      assert.equal(restoredTraining.finalPriceCents, 24500);
      assert.equal(restoredTraining.rationale, rationale);
      assert.equal(restoredTraining.savedExampleId, null);
      const [storedPractice] = await rows(
        'SELECT saved_example_id FROM training_sessions WHERE business_id=? AND id=?',
        [business.id, noSendId],
      );
      assert.equal(storedPractice.saved_example_id, null);
      const otherDashboard = (await other.get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(
        otherDashboard.jobNotes.some((note: any) => note.id === noSendId),
        false,
      );
      assert.equal(
        otherDashboard.jobNotes.some((note: any) => note.id === foreignId),
        true,
      );
      await other.get(`/api/v1/training/${noSendId}`).expect(404);
      const publicPractice = await request(app).get(`/api/v1/public/${business.slug}`).expect(200);
      assert.equal(JSON.stringify(publicPractice.body).includes(rationale), false);
      assert.equal(
        providerCalls,
        beforeFinish,
        'Finishing and restoring practice must not call AI',
      );
      const practiceProposal = (
        await owner
          .post(`/api/v1/services/${practiceService.id}/learn`)
          .set('X-Forwarded-For', '2001:db8::57')
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.equal(providerCalls, beforeFinish + 1, 'Only the explicit mocked Learn calls AI');
      assert.deepEqual(
        practiceProposal.sourceCaseIds.slice().sort(),
        [noSendId, ownerTurnId].sort(),
      );
      assert.deepEqual(practiceProposal.sourceExampleIds, []);
      assert.deepEqual(learningInput.examples, []);
      assert.equal(
        learningInput.caseNotes.find((note: any) => note.id === noSendId).finalPriceCents,
        24500,
      );
      assert.equal(
        learningInput.caseNotes.find((note: any) => note.id === noSendId).sourceNotes,
        '',
      );
      assert.equal(
        learningInput.caseNotes.find((note: any) => note.id === ownerTurnId).sourceNotes,
        actualOwnerTurn,
      );
      assert.equal(learningInput.ownerNotes.includes(rationale), false);
      for (const field of ['unitPriceCents', 'basePriceCents', 'minimumChargeCents'])
        assert.equal(practiceProposal.proposal[field], 0);
      const unchangedService = (await owner.get('/api/v1/services').expect(200)).body.data.find(
        (service: any) => service.id === practiceService.id,
      );
      assert.deepEqual(
        unchangedService,
        practiceService,
        'Learn never applies the proposed policy',
      );
      assert.equal(
        (await owner.get('/api/v1/examples').expect(200)).body.data.filter(
          (example: any) => example.serviceId === practiceService.id,
        ).length,
        0,
      );

      const backedId = await seedPractice(practiceService, '2');
      const backed = (
        await owner
          .post(`/api/v1/training/${backedId}/complete`)
          .set('Origin', origin)
          .send({ ...completion, saveAsExample: true })
          .expect(200)
      ).body.data;
      assert.match(backed.savedExampleId, /^[0-9a-f-]{36}$/i);
      const afterExample = (await owner.get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(
        afterExample.trainingSessions.find((session: any) => session.id === backedId)
          .savedExampleId,
        backed.savedExampleId,
      );
      assert.equal(
        afterExample.examples.find((example: any) => example.id === backed.savedExampleId).source,
        'training',
      );
      assert.equal(
        afterExample.jobNotes.some((note: any) => note.id === backedId),
        false,
      );
      assert.equal(afterExample.jobNotes.filter((note: any) => note.id === noSendId).length, 1);
      assert.equal(
        afterExample.examples.filter((example: any) => example.serviceId === practiceService.id)
          .length,
        1,
      );
      const linkedProposal = (
        await owner
          .post(`/api/v1/services/${practiceService.id}/learn`)
          .set('Origin', origin)
          .send({})
          .expect(201)
      ).body.data.proposal;
      assert.deepEqual(linkedProposal.sourceExampleIds, [backed.savedExampleId]);

      const [user] = await rows('SELECT id FROM users WHERE business_id=?', [business.id]);
      const longMessages = Array.from({ length: 15 }, (_, index) => ({
        id: randomUUID(),
        role: 'user',
        author: 'owner',
        content:
          `Fictional bounded job context ${index}. ${'Wall preparation was included. '.repeat(160)}`.slice(
            0,
            4800,
          ),
        createdAt: new Date().toISOString(),
      }));
      for (let index = 0; index < 4; index++) {
        const id = randomUUID();
        await mutate(
          "INSERT INTO examples(id,business_id,service_id,title,description,quantity,unit_label,final_price_cents,rationale,source) VALUES (?,?,?,'Fictional long job','Painting',1,'project',10000,'Work completed','historical')",
          [id, business.id, serviceId],
        );
        await mutate(
          "INSERT INTO service_setup_sessions(id,business_id,user_id,status,messages_json,draft_json,evidence_json,service_id,example_id) VALUES (?,?,?,'confirmed',?,?,?,?,?)",
          [
            randomUUID(),
            business.id,
            user.id,
            JSON.stringify(longMessages),
            JSON.stringify(replies.draft),
            JSON.stringify(replies.evidence),
            serviceId,
            id,
          ],
        );
      }
      const beforeLimit = providerCalls;
      const tooLong = await owner
        .post(`/api/v1/services/${serviceId}/learn`)
        .set('Origin', origin)
        .send({ notes: 'Keep the work reviewed.' })
        .expect(422);
      assert.equal(tooLong.body.error.code, 'LEARNING_EVIDENCE_LIMIT');
      assert.equal(providerCalls, beforeLimit);
      assert.equal(
        (await owner.get(`/api/v1/services/${serviceId}/proposals`).expect(200)).body.data.teaching
          .revision,
        0,
      );
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
