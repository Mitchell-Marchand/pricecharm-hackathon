import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'dashboard coverage suggestions use all confirmed owner setup evidence, scoped by tenant and service, without writes or provider calls',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('Dashboard suggestions must not call a provider');
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      agents = [request.agent(app), request.agent(app)],
      businesses: string[] = [],
      users: string[] = [],
      services: string[][] = [[], []],
      origin = 'http://localhost:3100';
    const seed = async (
      serviceId: string,
      content: string,
      options: { tenant?: number; status?: string; assistant?: string; exampleId?: string } = {},
    ) => {
      const tenant = options.tenant || 0;
      await mutate(
        'INSERT INTO service_setup_sessions(id,business_id,user_id,status,messages_json,draft_json,evidence_json,service_id,example_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          businesses[tenant],
          users[tenant],
          options.status || 'confirmed',
          JSON.stringify([
            { role: 'user', content },
            ...(options.assistant ? [{ role: 'assistant', content: options.assistant }] : []),
          ]),
          JSON.stringify({
            name: 'Catering',
            description: 'Office lunch catering',
            unitLabel: null,
            example: null,
          }),
          '{}',
          serviceId,
          options.exampleId || null,
        ],
      );
    };
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          ...[
            'businesses',
            'services',
            'service_setup_sessions',
            'examples',
            'training_sessions',
            'import_drafts',
            'owner_case_notes',
            'usage_events',
            'email_outbox',
            'jobs',
          ].map((table) =>
            rows(
              `SELECT * FROM ${table} WHERE ${table === 'businesses' ? 'id' : 'business_id'} IN (?,?) ORDER BY id`,
              businesses,
            ),
          ),
          rows('SELECT * FROM ai_daily_budgets ORDER BY budget_day'),
        ]),
      );
    try {
      await request(app).get('/api/v1/dashboard').expect(401);
      for (const [tenant, agent] of agents.entries()) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Coverage fixture owner',
              businessName: 'Fictional coverage catering',
              email: `coverage-${randomUUID()}@example.test`,
              password: 'coverage-fixture-password123',
            })
            .expect(201)
        ).body.data;
        businesses.push(registered.business.id);
        users.push(registered.user.id);
        for (let index = 0; index < (tenant === 0 ? 9 : 1); index++) {
          const created = (
            await agent
              .post('/api/v1/services')
              .set('Origin', origin)
              .send({
                name: `Catering service ${index + 1}`,
                description: 'Office lunches with owner-reviewed prices',
                unitLabel: 'guest',
              })
              .expect(201)
          ).body.data;
          services[tenant].push(created.id);
        }
      }
      const example = (
        await agents[0]
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId: services[0][0],
            title: 'Office lunch',
            description: 'A completed catered office lunch',
            quantity: 60,
            finalPriceCents: 90000,
            rationale: 'Dietary preparation',
            unitLabel: 'guest',
          })
          .expect(201)
      ).body.data;
      await seed(
        services[0][0],
        'We cater office lunches throughout Austin. Last week I catered a sixty-person lunch in San Marcos for $900.',
        { exampleId: example.id },
      );
      await seed(services[0][1], 'Last week I catered a lunch in Austin for $900.');
      await seed(services[0][2], 'I catered a lunch in Dallas.', {
        assistant: 'I serve Dallas. I run Assistant Company, a catering service in Dallas.',
      });
      await seed(services[0][3], 'I serve Austin.');
      for (let index = 0; index < 199; index++)
        await seed(services[0][3], 'A past job was completed.');
      await seed(services[0][3], 'I serve Round Rock.');
      await seed(services[0][4], 'I serve Galveston.', { status: 'active' });
      // A damaged legacy record cannot hide a conflict behind an otherwise valid suggestion.
      await seed(services[0][5], 'I serve Austin.');
      await mutate(
        'INSERT INTO service_setup_sessions(id,business_id,user_id,status,messages_json,draft_json,evidence_json,service_id) VALUES (?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          businesses[0],
          users[0],
          'confirmed',
          '[{"role":"user","content":42}]',
          '{}',
          '{}',
          services[0][5],
        ],
      );
      await seed(services[1][0], 'I run Second Company, a catering service in Boston.', {
        tenant: 1,
      });
      await seed(
        services[0][7],
        'I run Porch & Paw, a mobile dog grooming service in Cedar Park and Leander. I do baths, brushing and haircuts at people’s homes.',
      );
      await seed(services[0][8], 'I run First Company, a catering service in Austin.');
      await seed(services[0][8], 'I run First Company, a catering service in Round Rock.');
      // Globally valid foreign keys are not proof of same-tenant service ownership.
      await seed(services[0][0], 'I serve San Marcos.', { tenant: 1 });
      await seed(services[0][7], 'I run Foreign Company, a grooming service in San Marcos.', {
        tenant: 1,
      });
      await mutate(
        'INSERT INTO examples(id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          businesses[0],
          services[0][6],
          'Unlinked history',
          'I serve Houston.',
          1,
          10000,
          'I serve Houston.',
          'historical',
        ],
      );
      const importId = randomUUID(),
        projectId = randomUUID();
      await mutate(
        'INSERT INTO import_drafts(id,business_id,service_id,filename,source_hash,status,draft_json,source_text,source_basis) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          importId,
          businesses[0],
          services[0][6],
          'coverage-note.txt',
          'a'.repeat(64),
          'confirmed',
          '{"projects":[],"issues":[]}',
          'I serve Houston.',
          'exact_owner_text',
        ],
      );
      await mutate(
        'INSERT INTO owner_case_notes(id,business_id,service_id,import_draft_id,source_project_id,reviewed_json) VALUES (?,?,?,?,?,?)',
        [
          randomUUID(),
          businesses[0],
          services[0][6],
          importId,
          projectId,
          JSON.stringify({
            id: projectId,
            title: 'Imported job',
            description: 'I serve Houston.',
            quantity: null,
            finalPriceCents: null,
            rationale: '',
            unitLabel: null,
            sourceCurrency: null,
          }),
        ],
      );
      await mutate(
        'INSERT INTO training_sessions(id,business_id,service_id,service_version,status,scenario_json,rationale) VALUES (?,?,?,?,?,?,?)',
        [
          randomUUID(),
          businesses[0],
          services[0][6],
          1,
          'completed',
          '{"title":"I serve Houston.","description":"I serve Houston."}',
          'I serve Houston.',
        ],
      );
      const before = await snapshot();
      const dashboard = (await agents[0].get('/api/v1/dashboard').expect(200)).body.data;
      assert.deepEqual(dashboard.serviceAreaSuggestions, {
        [services[0][0]]: 'Austin',
        [services[0][7]]: 'Cedar Park and Leander',
      });
      assert.equal(dashboard.business.serviceArea, '');
      assert.ok(dashboard.examples.some((item: any) => item.id === example.id));
      const other = (await agents[1].get('/api/v1/dashboard').expect(200)).body.data;
      assert.deepEqual(other.serviceAreaSuggestions, { [services[1][0]]: 'Boston' });
      assert.ok(other.jobNotes.some((item: any) => item.serviceId === services[1][0]));
      assert.equal(
        await snapshot(),
        before,
        'Suggestions are read-only, including policy, usage, budgets and outbox',
      );
      assert.equal(providerCalls, 0);

      await agents[0]
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ serviceArea: 'Round Rock' })
        .expect(200);
      const withArea = await snapshot();
      const existing = (await agents[0].get('/api/v1/dashboard').expect(200)).body.data;
      assert.equal(existing.business.serviceArea, 'Round Rock');
      assert.deepEqual(existing.serviceAreaSuggestions, {});
      assert.equal(await snapshot(), withArea);
      assert.equal(providerCalls, 0);
    } finally {
      globalThis.fetch = realFetch;
      for (const businessId of businesses) {
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
