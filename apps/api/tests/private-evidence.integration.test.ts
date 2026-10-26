import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';

test(
  'private jobs, imports and practice preserve reviewed intake while invalidating automatic approval; pending teaching stays separate from applied policy',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'private-evidence-fixture-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      providerCalls++;
      const body = JSON.parse(String(init?.body));
      assert.ok(
        body.text.format.schema.properties.unitPriceCents,
        'Only pending Learn may call the mock',
      );
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  unitLabel: 'square feet',
                  unitPriceCents: 25,
                  basePriceCents: 0,
                  minimumChargeCents: 10000,
                  requiredInputs: ['area', 'surface'],
                  pricingRules: [],
                  exclusions: [],
                  explanation: 'Ask about the area and surface before preparing the price.',
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
      { serviceById } = await import('../src/models.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    let slug = '';
    const current = (id: string) => serviceById(businessIds[0], id);
    const policy = (service: Awaited<ReturnType<typeof current>>) => {
      const {
        version: _version,
        publishedAt: _published,
        approvedAt: _approvedAt,
        approvedVersion: _approvedVersion,
        ...fields
      } = service;
      return fields;
    };
    const publicService = async (id: string) => {
      const data = (await request(app).get(`/api/v1/public/${slug}`).expect(200)).body.data;
      return data.services.find((service: any) => service.id === id);
    };
    const evidenceCounts = async (id: string) =>
      JSON.stringify(
        await Promise.all([
          rows('SELECT COUNT(*) AS count FROM examples WHERE business_id=? AND service_id=?', [
            businessIds[0],
            id,
          ]),
          rows(
            'SELECT COUNT(*) AS count FROM owner_case_notes WHERE business_id=? AND service_id=?',
            [businessIds[0], id],
          ),
          rows(
            "SELECT COUNT(*) AS count FROM training_sessions WHERE business_id=? AND service_id=? AND status='completed'",
            [businessIds[0], id],
          ),
          rows(
            "SELECT COUNT(*) AS count FROM messages WHERE business_id=? AND conversation_type='training'",
            [businessIds[0]],
          ),
        ]),
      );
    const example = (id: string) => ({
      serviceId: id,
      title: 'Private driveway job',
      description: 'A previously completed concrete driveway',
      quantity: 400,
      finalPriceCents: 10000,
      rationale: 'Routine washing',
      unitLabel: 'square feet',
    });
    const confirm = (agent: any, id: string, projects: any[]) =>
      agent.post(`/api/v1/imports/${id}/confirm`).set('Origin', origin).send({ projects });
    const complete = (agent: any, id: string, decision: object) =>
      agent.post(`/api/v1/training/${id}/complete`).set('Origin', origin).send(decision);
    type Action = {
      name: string;
      prepare: (serviceId: string) => Promise<{
        run: () => Promise<unknown>;
        retry?: () => Promise<unknown>;
        denied: () => Promise<unknown>;
      }>;
    };
    const importAction = (mixed: boolean): Action => ({
      name: mixed ? 'mixed document confirmation' : 'partial-note document confirmation',
      prepare: async (serviceId) => {
        const id = randomUUID(),
          unit = 'square feet';
        const projects = [
          ...(mixed
            ? [
                {
                  id: randomUUID(),
                  title: 'Priced driveway',
                  description: 'A routine concrete driveway washing job',
                  quantity: 400,
                  finalPriceCents: 10000,
                  rationale: 'Routine washing',
                  unitLabel: unit,
                  currency: 'USD',
                  inputs: {},
                  issues: [],
                },
              ]
            : []),
          {
            id: randomUUID(),
            title: 'Inspection visit',
            description: 'A concrete driveway inspection with unrecorded area',
            quantity: null,
            finalPriceCents: 18000,
            rationale: 'Area was not recorded',
            unitLabel: null,
            currency: 'USD',
            inputs: {},
            issues: ['Area unknown'],
          },
        ];
        await mutate(
          'INSERT INTO import_drafts(id,business_id,service_id,filename,source_hash,draft_json,unit_label,source_text,source_basis) VALUES (?,?,?,?,?,?,?,?,?)',
          [
            id,
            businessIds[0],
            serviceId,
            'fictional-past-jobs.txt',
            createHash('sha256').update(id).digest('hex'),
            JSON.stringify({ projects, notes: [] }),
            unit,
            'Private fixture source: inspected a driveway and charged $180 USD; area was not recorded.',
            'exact_owner_text',
          ],
        );
        const reviewed = projects.map(({ id: projectId, issues: _issues, ...fields }) => ({
          ...fields,
          projectId,
          saveAsNote: fields.quantity === null,
        }));
        return {
          run: () => confirm(owner, id, reviewed).expect(200),
          retry: () => confirm(owner, id, reviewed).expect(200),
          denied: () => confirm(other, id, reviewed).expect(404),
        };
      },
    });
    const practiceAction = (inspection: boolean): Action => ({
      name: inspection ? 'inspection practice completion' : 'numeric practice example completion',
      prepare: async (serviceId) => {
        const service = await current(serviceId),
          id = randomUUID();
        await mutate(
          'INSERT INTO training_sessions(id,business_id,service_id,service_version,scenario_json,unit_label) VALUES (?,?,?,?,?,?)',
          [
            id,
            businessIds[0],
            serviceId,
            service.version,
            JSON.stringify({
              title: 'Fictional driveway',
              customerName: 'Fictional customer',
              description: 'A concrete driveway with surface conditions to check',
              details: { quantity: '400 square feet', area: '400', location: 'Austin' },
            }),
            service.unitLabel,
          ],
        );
        const decision = inspection
          ? {
              outcome: 'inspection_required',
              finalPriceCents: null,
              rationale:
                'I need to inspect the surface before I can quote. I need to check the damage in person.',
              saveAsExample: false,
            }
          : {
              outcome: 'quote',
              finalPriceCents: 10000,
              rationale: 'Routine washing for the confirmed area',
              saveAsExample: true,
            };
        return {
          run: () => complete(owner, id, decision).expect(200),
          retry: () => complete(owner, id, decision).expect(200),
          denied: () => complete(other, id, decision).expect(404),
        };
      },
    });
    const actions: Action[] = [
      {
        name: 'priced example addition',
        prepare: async (id) => ({
          run: () =>
            owner.post('/api/v1/examples').set('Origin', origin).send(example(id)).expect(201),
          denied: () =>
            other.post('/api/v1/examples').set('Origin', origin).send(example(id)).expect(404),
        }),
      },
      {
        name: 'priced example deletion',
        prepare: async (serviceId) => {
          const id = randomUUID(),
            fields = example(serviceId);
          await mutate(
            "INSERT INTO examples(id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source,unit_label) VALUES (?,?,?,?,?,?,?,?,'historical',?)",
            [
              id,
              businessIds[0],
              serviceId,
              fields.title,
              fields.description,
              fields.quantity,
              fields.finalPriceCents,
              fields.rationale,
              fields.unitLabel,
            ],
          );
          return {
            run: () => owner.delete(`/api/v1/examples/${id}`).set('Origin', origin).expect(200),
            retry: () => owner.delete(`/api/v1/examples/${id}`).set('Origin', origin).expect(404),
            denied: () => other.delete(`/api/v1/examples/${id}`).set('Origin', origin).expect(404),
          };
        },
      },
      {
        name: 'CSV import',
        prepare: async (id) => {
          const csv =
            'title,description,quantity,finalPrice,rationale\nPrivate CSV job,A completed concrete driveway,400,100,Routine washing';
          const submit = (agent: any) =>
            agent
              .post(`/api/v1/examples/import?serviceId=${id}`)
              .set('Origin', origin)
              .type('text/csv')
              .send(csv);
          return { run: () => submit(owner).expect(201), denied: () => submit(other).expect(404) };
        },
      },
      importAction(true),
      importAction(false),
      practiceAction(false),
      practiceAction(true),
    ];
    try {
      for (const agent of [owner, other]) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Private evidence QA',
              businessName: 'Fictional private evidence QA',
              email: `qa-private-evidence-${randomUUID()}@example.test`,
              password: 'private-evidence-fixture123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registered.business.id);
        if (agent === owner) slug = registered.business.slug;
      }
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Concrete driveway cleaning', serviceArea: 'Austin' })
        .expect(200);
      const create = async (name: string) =>
        (
          await owner
            .post('/api/v1/services')
            .set('Origin', origin)
            .send({
              name,
              description: 'Concrete driveway cleaning',
              unitLabel: 'square feet',
              unitPriceCents: 25,
              basePriceCents: 0,
              minimumChargeCents: 10000,
              maxAutoQuoteCents: 50000,
              requiredInputs: ['area'],
              exclusions: [],
            })
            .expect(201)
        ).body.data;
      const reviewService = await create('Reviewed driveway requests'),
        automaticService = await create('Automatic control fixture');
      await owner
        .post(`/api/v1/services/${reviewService.id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      for (const action of actions) {
        for (const mode of ['review', 'automatic'] as const) {
          const id = mode === 'review' ? reviewService.id : automaticService.id;
          const prepared = await action.prepare(id);
          if (mode === 'automatic') {
            // A controlled approved-state fixture verifies invalidation; no customer issuance occurs.
            await mutate(
              "UPDATE services SET mode='automatic',published_at=UTC_TIMESTAMP(3),approved_version=version,approved_at=UTC_TIMESTAMP(3),approved_evaluation_id=? WHERE business_id=? AND id=?",
              [randomUUID(), businessIds[0], id],
            );
          }
          const before = await current(id),
            publicBefore = await publicService(id);
          await prepared.denied();
          assert.deepEqual(
            await current(id),
            before,
            `${action.name}: another tenant cannot change publication`,
          );
          await prepared.run();
          const after = await current(id);
          assert.deepEqual(
            policy(after),
            policy(before),
            `${action.name}: private evidence cannot change live policy`,
          );
          assert.equal(after.version, before.version + 1, action.name);
          assert.equal(after.approvedVersion, null, action.name);
          const [raw] = await rows(
            'SELECT approved_at,approved_evaluation_id FROM services WHERE business_id=? AND id=?',
            [businessIds[0], id],
          );
          assert.equal(raw.approved_at, null, action.name);
          assert.equal(raw.approved_evaluation_id, null, action.name);
          if (mode === 'review') {
            assert.equal(after.publishedAt, before.publishedAt, action.name);
            assert.deepEqual(
              await publicService(id),
              publicBefore,
              `${action.name}: customer-visible scope and intake remain unchanged`,
            );
            const inquiry = await request(app)
              .post(`/api/v1/public/${slug}/sessions`)
              .set('Origin', origin)
              .send({ serviceId: id })
              .expect(201);
            assert.equal(inquiry.body.data.session.quoteMode, 'review');
            assert.equal(inquiry.body.data.session.serviceId, id);
          } else {
            assert.equal(after.publishedAt, null, action.name);
            assert.equal(await publicService(id), undefined, action.name);
            await request(app)
              .post(`/api/v1/public/${slug}/sessions`)
              .set('Origin', origin)
              .send({ serviceId: id })
              .expect(404);
          }
          if (prepared.retry) {
            const savedCounts = await evidenceCounts(id);
            await prepared.retry();
            assert.deepEqual(
              await current(id),
              after,
              `${action.name}: exact retry must not bump version again`,
            );
            assert.equal(
              await evidenceCounts(id),
              savedCounts,
              `${action.name}: exact retry must not duplicate evidence`,
            );
          }
        }
      }
      assert.equal(
        providerCalls,
        0,
        'Saving reviewed evidence and its retries never needs model calls',
      );
      const beforeLearn = await current(reviewService.id),
        publicBeforeLearn = await publicService(reviewService.id);
      const learned = (
        await owner
          .post(`/api/v1/services/${reviewService.id}/learn`)
          .set('Origin', origin)
          .send({
            notes: 'Ask customers whether the driveway is concrete or asphalt.',
            expectedTeachingRevision: 0,
          })
          .expect(201)
      ).body.data;
      assert.equal(providerCalls, 1);
      assert.equal(learned.proposal.status, 'pending');
      assert.equal(learned.teaching.revision, 1);
      assert.deepEqual(
        await current(reviewService.id),
        beforeLearn,
        'Pending teaching must not change current policy, version or publication',
      );
      assert.deepEqual(await publicService(reviewService.id), publicBeforeLearn);
      await request(app)
        .post(`/api/v1/public/${slug}/sessions`)
        .set('Origin', origin)
        .send({ serviceId: reviewService.id })
        .expect(201);
      const applied = (
        await owner
          .post(`/api/v1/proposals/${learned.proposal.id}/apply`)
          .set('Origin', origin)
          .send({})
          .expect(200)
      ).body.data;
      assert.ok(applied.service.requiredInputs.includes('surface'));
      assert.equal(
        applied.service.publishedAt,
        null,
        'Applying an actual intake change still pauses publication',
      );
      assert.equal(applied.service.version, beforeLearn.version + 1);
      await owner
        .post(`/api/v1/proposals/${learned.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      assert.equal((await current(reviewService.id)).version, applied.service.version);
      assert.equal(providerCalls, 1, 'Applying and retrying never reruns learning');
    } finally {
      globalThis.fetch = realFetch;
      for (const businessId of businessIds) {
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
