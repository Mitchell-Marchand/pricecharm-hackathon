import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mutate, rows, transaction, closeDatabase } from '../src/db.js';

test(
  'guided setup is tenant-scoped, persists unknowns, serializes AI calls and confirms without inferred pricing',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'isolated-test-key';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_BUSINESS_LIMIT = '500';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const realFetch = globalThis.fetch;
    let providerCalls = 0,
      learnedOwnerNotes = '';
    let reply = {
      reply:
        'Your service is ready to review. Would you like to confirm it? What price was that job?',
      draft: {
        name: 'Interior painting',
        description: 'Painting home interiors, walls and ceilings',
        unitLabel: null as string | null,
        example: {
          title: 'A recent home',
          description: 'A home interior I painted',
          quantity: null as number | null,
          finalPriceCents: null as number | null,
          rationale: '',
        },
      },
      evidence: {
        unitLabel: null as string | null,
        exampleQuantity: null as string | null,
        examplePrice: null as string | null,
        singleProjectFixedTotal: false,
        singleProject: null as string | null,
      },
    };
    globalThis.fetch = async (input, options) => {
      assert.equal(
        String(input),
        'https://api.openai.com/v1/responses',
        'No real provider calls are allowed',
      );
      providerCalls++;
      const body = String(options?.body);
      const isLearning = Object.hasOwn(
        JSON.parse(body).text.format.schema.properties,
        'unitPriceCents',
      );
      if (isLearning) learnedOwnerNotes = body;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = isLearning
        ? {
            unitPriceCents: 0,
            basePriceCents: 0,
            minimumChargeCents: 0,
            requiredInputs: ['Project scope'],
            exclusions: [],
            pricingRules: [],
            explanation: 'A reviewable proposal preserving the unknown general rate.',
            uncertainties: ['One example does not establish a general rate.'],
          }
        : reply;
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { createApp } = await import('../src/app.js');
    const app = createApp(),
      a = request.agent(app),
      b = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    try {
      for (const agent of [a, b]) {
        const registered = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'QA Guided setup',
            businessName: 'QA Guided setup',
            email: `qa-setup-${randomUUID()}@example.test`,
            password: 'strong test password123',
          });
        assert.equal(registered.status, 201, JSON.stringify(registered.body));
        businessIds.push(registered.body.data.business.id);
      }
      await a
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Home renovation and maintenance in Austin' })
        .expect(200);
      const started = await a.post('/api/v1/service-setup').set('Origin', origin).send({});
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const id = started.body.data.id;
      assert.equal(started.body.data.version, 1);
      assert.equal(started.body.data.draft.unitLabel, null);
      assert.equal(started.body.data.readyToConfirm, false);
      assert.match(started.body.data.messages[0].content, /overview/);
      assert.equal((started.body.data.messages[0].content.match(/\?/g) || []).length, 1);
      assert.equal(
        (await a.post('/api/v1/service-setup').set('Origin', origin).send({})).body.data.id,
        id,
      );
      await b.get(`/api/v1/service-setup/${id}`).expect(404);
      await request(app).get(`/api/v1/service-setup/${id}`).expect(401);
      await b
        .post(`/api/v1/service-setup/${id}/messages`)
        .set('Origin', origin)
        .send({ content: 'Change somebody else’s service', expectedVersion: 1 })
        .expect(404);
      await a
        .post(`/api/v1/service-setup/${id}/confirm`)
        .set('Origin', origin)
        .send({ expectedVersion: 1 })
        .expect(422);
      const before = providerCalls;
      const sent = await Promise.all(
        [0, 1].map(() =>
          a.post(`/api/v1/service-setup/${id}/messages`).set('Origin', origin).send({
            content:
              'I paint home interiors, walls and ceilings. I painted a home recently but cannot remember the size or the price.',
            expectedVersion: 1,
          }),
        ),
      );
      assert.deepEqual(sent.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        providerCalls - before,
        1,
        'A durable setup lease prevents parallel model spend',
      );
      const session = sent.find((r) => r.status === 200)!.body.data;
      assert.equal(session.version, 2);
      assert.equal(session.messages.length, 3);
      assert.match(session.messages[2].content, /Review the summary to continue/);
      assert.equal(
        session.messages[2].content.includes('?'),
        false,
        'Known scope should lead to practice rather than another interview',
      );
      assert.equal(session.readyToConfirm, true);
      assert.equal(session.draft.example.quantity, null);
      assert.equal(session.draft.example.finalPriceCents, null);
      assert.equal((await a.get(`/api/v1/service-setup/${id}`)).body.data.messages.length, 3);
      const calls = providerCalls;
      const stale = await a
        .post(`/api/v1/service-setup/${id}/messages`)
        .set('Origin', origin)
        .send({ content: 'stale duplicate', expectedVersion: 1 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'SETUP_VERSION_CONFLICT');
      assert.equal(providerCalls, calls);
      await a
        .post(`/api/v1/service-setup/${id}/confirm`)
        .set('Origin', origin)
        .send({ expectedVersion: 1 })
        .expect(409);
      const confirmed = await a
        .post(`/api/v1/service-setup/${id}/confirm`)
        .set('Origin', origin)
        .send({ expectedVersion: 2 });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const service = confirmed.body.data.service;
      for (const key of [
        'unitPriceCents',
        'basePriceCents',
        'minimumChargeCents',
        'maxAutoQuoteCents',
      ])
        assert.equal(service[key], 0, key);
      assert.equal(service.mode, 'review');
      assert.equal(service.unitLabel, 'project');
      assert.equal(service.publishedAt, null);
      assert.deepEqual(service.requiredInputs, []);
      assert.deepEqual(service.pricingRules, []);
      assert.equal(confirmed.body.data.example, undefined);
      assert.equal(
        confirmed.body.data.session.draft.example.description,
        reply.draft.example.description,
        'Partial historical notes survive confirmation',
      );
      assert.equal(
        (
          await a
            .post(`/api/v1/service-setup/${id}/confirm`)
            .set('Origin', origin)
            .send({ expectedVersion: 2 })
        ).body.data.service.id,
        service.id,
        'Confirmation retry is idempotent',
      );
      assert.equal((await a.get('/api/v1/services')).body.data.length, 1);
      const second = (await a.post('/api/v1/service-setup').set('Origin', origin).send({})).body
        .data;
      assert.notEqual(second.id, id);
      const ownerStatement =
        'I wash concrete driveways, and I quote by square foot. Last week I washed a 1000 sqft driveway and charged $275 because it had algae. I also have a $150 minimum.';
      reply = {
        reply:
          'I saved that past job without inferring a general rate. You can review and confirm this service.',
        draft: {
          name: 'Concrete washing',
          description: 'Pressure washing concrete driveways',
          unitLabel: null,
          example: {
            title: 'Algae driveway',
            description: 'A driveway washed last week with algae',
            quantity: null,
            finalPriceCents: null,
            rationale: '',
          },
        },
        evidence: {
          unitLabel: null,
          exampleQuantity: null,
          examplePrice: null,
          singleProjectFixedTotal: false,
          singleProject: null,
        },
      };
      const extracted = await a
        .post(`/api/v1/service-setup/${second.id}/messages`)
        .set('Origin', origin)
        .send({ content: ownerStatement, expectedVersion: 1 });
      assert.equal(extracted.status, 200, JSON.stringify(extracted.body));
      assert.equal(extracted.body.data.draft.example.quantity, 1000);
      assert.equal(extracted.body.data.draft.example.finalPriceCents, 27500);
      assert.equal(extracted.body.data.draft.unitLabel, 'square foot');
      assert.equal(extracted.body.data.draft.example.rationale, 'because it had algae');
      assert.equal(
        (await a.get('/api/v1/examples')).body.data.length,
        0,
        'Nothing enters history before explicit confirmation',
      );
      const complete = await a
        .post(`/api/v1/service-setup/${second.id}/confirm`)
        .set('Origin', origin)
        .send({ expectedVersion: 2 });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      assert.equal(complete.body.data.example.quantity, 1000);
      assert.equal(complete.body.data.example.finalPriceCents, 27500);
      assert.equal(complete.body.data.example.rationale, 'because it had algae');
      assert.equal(
        complete.body.data.service.unitPriceCents,
        0,
        'A single charged job does not create a rate',
      );
      assert.equal(
        complete.body.data.service.minimumChargeCents,
        0,
        'Policy notes need later explicit proposal approval',
      );
      const learned = await a
        .post(`/api/v1/services/${complete.body.data.service.id}/learn`)
        .set('Origin', origin)
        .send({});
      assert.equal(learned.status, 201, JSON.stringify(learned.body));
      assert.ok(
        learnedOwnerNotes.includes('$150 minimum.'),
        'Original setup owner notes are included in later reviewable learning',
      );
      assert.ok(learnedOwnerNotes.includes('charged $275'));
      await a
        .post(`/api/v1/service-setup/${second.id}/messages`)
        .set('Origin', origin)
        .send({ content: 'edit confirmed', expectedVersion: 3 })
        .expect(409);
    } finally {
      globalThis.fetch = realFetch;
      for (const businessId of businessIds)
        await transaction(async (connection) => {
          const days = await rows(
            "SELECT DATE(created_at) AS day,COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation' GROUP BY DATE(created_at)",
            [businessId],
            connection,
          );
          for (const day of days) {
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
          await mutate(
            'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
            [businessId],
            connection,
          );
          for (const table of [
            'service_setup_sessions',
            'knowledge_proposals',
            'import_drafts',
            'attachments',
            'usage_events',
            'jobs',
            'quotes',
            'public_sessions',
            'messages',
            'training_sessions',
            'evaluations',
            'examples',
            'service_test_cases',
            'services',
            'users',
          ])
            await mutate(`DELETE FROM ${table} WHERE business_id=?`, [businessId], connection);
          await mutate('DELETE FROM businesses WHERE id=?', [businessId], connection);
        });
      await closeDatabase();
    }
  },
);

test(
  'saved setup omissions recover on read and explicit confirmation without provider calls or read writes',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const realFetch = globalThis.fetch,
      businessIds: string[] = [];
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('Saved setup recovery must never contact a provider');
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      agent = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    let ownerId = '';
    try {
      for (const current of [agent, other]) {
        const registration = (
          await current
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Saved setup QA',
              businessName: 'Fictional Saved Setup QA',
              email: `qa-setup-recovery-${randomUUID()}@example.test`,
              password: 'fictional-recovery-test123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registration.business.id);
        if (current === agent) ownerId = registration.user.id;
      }
      const repair =
        'I repair household appliances in Austin. Before I quote any repair, I always need to inspect the appliance on site and diagnose the fault. I ask customers for the appliance make and model, what it is doing wrong, and photos if they have them. I do not have a standard repair rate or a call-out price yet.';
      const evidence = {
        unitLabel: null,
        exampleQuantity: null,
        examplePrice: null,
        singleProjectFixedTotal: false,
        singleProject: null,
      };
      const begin = async () =>
        (await agent.post('/api/v1/service-setup').set('Origin', origin).send({}).expect(201)).body
          .data;
      const seed = async (id: string, content: string, draft: object) => {
        await mutate(
          'UPDATE service_setup_sessions SET messages_json=?,draft_json=?,evidence_json=?,version=2 WHERE business_id=? AND user_id=? AND id=?',
          [
            JSON.stringify([
              {
                id: randomUUID(),
                role: 'user',
                author: 'owner',
                content,
                createdAt: new Date().toISOString(),
              },
              {
                id: randomUUID(),
                role: 'assistant',
                author: 'ai',
                content: 'Tell me about a specific past job and what you charged.',
                createdAt: new Date().toISOString(),
              },
            ]),
            JSON.stringify(draft),
            JSON.stringify(evidence),
            businessIds[0],
            ownerId,
            id,
          ],
        );
      };
      const stored = async (id: string) =>
        (
          await rows(
            'SELECT draft_json,version,updated_at FROM service_setup_sessions WHERE business_id=? AND id=?',
            [businessIds[0], id],
          )
        )[0];
      const first = await begin();
      await seed(first.id, repair, {
        name: null,
        description: 'On-site household appliance diagnosis and repair',
        unitLabel: null,
        example: null,
      });
      const before = await stored(first.id);
      const read = (await agent.get(`/api/v1/service-setup/${first.id}`).expect(200)).body.data;
      assert.equal(read.readyToConfirm, true);
      assert.equal(read.draft.name, 'Repair household appliances');
      assert.equal(read.draft.unitLabel, null);
      assert.equal(read.draft.example, null);
      assert.equal(read.version, 2);
      assert.deepEqual(
        await stored(first.id),
        before,
        'GET recovery does not write or bump the version',
      );
      await other.get(`/api/v1/service-setup/${first.id}`).expect(404);
      const confirmed = (
        await agent
          .post(`/api/v1/service-setup/${first.id}/confirm`)
          .set('Origin', origin)
          .send({ expectedVersion: 2 })
          .expect(200)
      ).body.data;
      assert.equal(confirmed.evidenceSaved, 'service_only');
      assert.equal(confirmed.service.name, 'Repair household appliances');
      assert.equal(confirmed.service.unitPriceCents, 0);
      assert.equal(confirmed.service.basePriceCents, 0);
      assert.equal(confirmed.service.minimumChargeCents, 0);
      const persistedRepair = await stored(first.id);
      const repairDraft =
        typeof persistedRepair.draft_json === 'string'
          ? JSON.parse(persistedRepair.draft_json)
          : persistedRepair.draft_json;
      assert.equal(
        repairDraft.name,
        read.draft.name,
        'Explicit confirmation persists the recovered name',
      );
      const photographer =
        'I’m a photographer in Denver. I recently photographed a birthday portrait session and charged $180 because it was a brief shoot and included edited photos. I bill by the hour, but I didn’t record how many hours that job took. I price each job individually and don’t have a standard hourly rate.';
      const second = await begin();
      const photoDraft = {
        name: 'Portrait photography',
        description: 'Birthday portrait sessions',
        unitLabel: 'hour',
        example: {
          title: 'Birthday portrait session',
          description: 'A brief birthday portrait shoot with edited photos',
          quantity: null,
          finalPriceCents: 18000,
          rationale: '',
        },
      };
      await seed(second.id, photographer, photoDraft);
      const photo = (
        await agent
          .post(`/api/v1/service-setup/${second.id}/confirm`)
          .set('Origin', origin)
          .send({ expectedVersion: 2 })
          .expect(200)
      ).body.data;
      const reason = 'because it was a brief shoot and included edited photos';
      assert.equal(photo.evidenceSaved, 'job_note');
      assert.equal(photo.jobNote.quantity, null);
      assert.equal(photo.jobNote.finalPriceCents, 18000);
      assert.equal(photo.jobNote.rationale, reason);
      assert.equal(photo.jobNote.sourceNotes, photographer);
      const persistedPhoto = await stored(second.id);
      const savedPhotoDraft =
        typeof persistedPhoto.draft_json === 'string'
          ? JSON.parse(persistedPhoto.draft_json)
          : persistedPhoto.draft_json;
      assert.equal(savedPhotoDraft.example.rationale, reason);
      // Simulate the already-confirmed legacy omission from before this fix.
      await mutate('UPDATE service_setup_sessions SET draft_json=? WHERE business_id=? AND id=?', [
        JSON.stringify(photoDraft),
        businessIds[0],
        second.id,
      ]);
      const legacy = await stored(second.id);
      const dashboard = (await agent.get('/api/v1/dashboard').expect(200)).body.data;
      const note = dashboard.jobNotes.find((item: { id: string }) => item.id === second.id);
      assert.equal(note.rationale, reason);
      assert.equal(note.quantity, null);
      assert.equal(note.finalPriceCents, 18000);
      assert.equal(dashboard.examples.length, 0);
      assert.equal((await other.get('/api/v1/dashboard').expect(200)).body.data.jobNotes.length, 0);
      assert.deepEqual(await stored(second.id), legacy, 'Legacy case recovery is also read-only');
      assert.equal(providerCalls, 0);
      assert.equal(
        Number(
          (
            await rows(
              "SELECT COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation'",
              [businessIds[0]],
            )
          )[0].count,
        ),
        0,
      );
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
