import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';

test(
  'owner notifications identify the exact request and authenticated reads reach older live requests without side effects',
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
      throw new Error('Owner request links must never contact a provider');
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js'),
      { decryptEmail } = await import('../src/integrations/email.js'),
      { mapQuote } = await import('../src/models.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    let slug = '',
      serviceId = '';
    const get = (id: string, agent = owner) => agent.get(`/api/v1/quotes/${id}`);
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          ...[
            'businesses',
            'services',
            'quotes',
            'public_sessions',
            'messages',
            'email_outbox',
            'jobs',
            'usage_events',
          ].map((table) =>
            rows(
              `SELECT * FROM ${table} WHERE ${table === 'businesses' ? 'id' : 'business_id'}=? ORDER BY id`,
              [businessIds[0]],
            ),
          ),
          rows('SELECT * FROM ai_daily_budgets ORDER BY budget_day'),
        ]),
      );
    try {
      for (const agent of [owner, other]) {
        const registered = (
          await agent
            .post('/api/v1/auth/register')
            .set('Origin', origin)
            .send({
              name: 'Owner request link QA',
              businessName: 'Fictional appliance repair',
              email: `qa-owner-request-${randomUUID()}@example.test`,
              password: 'owner-link-fixture-password123',
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
        .send({ description: 'Household appliance repair', serviceArea: 'Austin' })
        .expect(200);
      serviceId = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Appliance repair',
            description: 'Household appliance repair',
            unitLabel: 'project',
            unitPriceCents: 0,
            requiredInputs: [],
          })
          .expect(201)
      ).body.data.id;
      await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const started = (
          await request(app).post(`/api/v1/public/${slug}/sessions`).send({ serviceId }).expect(201)
        ).body.data,
        path = `/api/v1/public/${slug}/sessions/${started.session.id}`;
      const inquiry = (
        await request(app)
          .post(`${path}/quote`)
          .set('Authorization', `Bearer ${started.token}`)
          .send({
            customerName: 'Fictional Avery',
            customerEmail: 'fictional-avery@example.test',
            quantity: 1,
            quantityUnknown: true,
            description: 'My dishwasher stops before the wash cycle completes',
            inputs: { location: 'Austin' },
            contactConsent: true,
          })
          .expect(201)
      ).body.data;
      await request(app)
        .post(`${path}/messages`)
        .set('Authorization', `Bearer ${started.token}`)
        .send({ content: 'The model label is inside the door.' })
        .expect(200);
      const alerts = await rows(
        'SELECT dedupe_key,payload_encrypted FROM email_outbox WHERE business_id=? AND (dedupe_key=? OR dedupe_key LIKE ?)',
        [businessIds[0], `quote:${inquiry.id}:review`, `quote:${inquiry.id}:customer-message:%`],
      );
      assert.equal(alerts.length, 2, 'Both owner alert paths are durably queued');
      for (const alert of alerts) {
        const payload = decryptEmail(alert.payload_encrypted),
          url = new URL(payload.text.match(/https?:\/\/\S+/)![0]);
        assert.equal(url.origin, origin);
        assert.equal(url.pathname, '/dashboard/quotes');
        assert.equal(url.searchParams.get('quote'), inquiry.id);
        assert.deepEqual([...url.searchParams.keys()], ['quote']);
        assert.equal(url.hash, '');
        assert.equal(
          payload.requestAccess,
          undefined,
          'Owner links use ordinary owner authentication, never customer capabilities',
        );
        assert.equal(payload.text.includes(started.token), false);
      }
      await mutate(
        'UPDATE quotes SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 DAY) WHERE business_id=? AND id=?',
        [businessIds[0], inquiry.id],
      );
      const acceptedId = randomUUID(),
        declinedId = randomUUID(),
        privateId = randomUUID();
      await transaction(async (connection) => {
        for (const [id, status, source, createdAt] of [
          [acceptedId, 'accepted', 'live', new Date(Date.now() - 2 * 86400000)],
          [declinedId, 'declined', 'live', new Date(Date.now() - 2 * 86400000)],
          [privateId, 'review', 'playground', new Date()],
          ...Array.from({ length: 201 }, () => [randomUUID(), 'review', 'live', new Date()]),
        ] as [string, string, string, Date][]) {
          await mutate(
            'INSERT INTO quotes(id,business_id,service_id,service_version,customer_name,customer_email,status,description,quantity,total_cents,currency,assumptions_json,line_items_json,calculation_json,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              businessIds[0],
              serviceId,
              1,
              'Fictional archive fixture',
              'fictional-archive@example.test',
              status,
              'An unrelated appliance request',
              1,
              0,
              'USD',
              '[]',
              '[]',
              '{}',
              source,
              createdAt,
            ],
            connection,
          );
        }
      });
      const before = await snapshot();
      const list = (await owner.get('/api/v1/quotes').expect(200)).body.data;
      assert.equal(list.length, 200, 'The existing recent-list limit is unchanged');
      assert.equal(
        list.some((quote: any) => quote.id === inquiry.id),
        false,
      );
      const [persisted] = await rows('SELECT * FROM quotes WHERE id=? AND business_id=?', [
        inquiry.id,
        businessIds[0],
      ]);
      const exact = (await get(inquiry.id).expect(200)).body.data;
      const { submittedIntake, receiptAfterMessageId, ...legacyExact } = exact;
      assert.deepEqual(legacyExact, mapQuote(persisted));
      assert.deepEqual(submittedIntake, {
        inputs: { location: 'Austin' },
        quantityUnknown: true,
      });
      assert.equal(
        receiptAfterMessageId,
        (
          await rows(
            'SELECT id FROM messages WHERE business_id=? AND conversation_id=? ORDER BY position',
            [businessIds[0], started.session.id],
          )
        )[1].id,
      );
      assert.equal(exact.manualPriceRequired, true);
      assert.equal(exact.customerName, 'Fictional Avery');
      assert.equal(exact.status, 'review');
      for (const [id, status] of [
        [acceptedId, 'accepted'],
        [declinedId, 'declined'],
      ]) {
        assert.equal((await get(id).expect(200)).body.data.status, status);
      }
      const unknown = await get(randomUUID()).expect(404),
        foreign = await get(inquiry.id, other).expect(404),
        privateQuote = await get(privateId).expect(404);
      for (const response of [unknown, foreign, privateQuote]) {
        assert.equal(response.body.error.code, 'QUOTE_NOT_FOUND');
        assert.equal(response.body.error.message, 'Quote not found.');
      }
      await request(app).get(`/api/v1/quotes/${inquiry.id}`).expect(401);
      await get('not-a-uuid').expect(400);
      await get(inquiry.id).expect(200);
      assert.equal(
        await snapshot(),
        before,
        'Exact GET changes no quotes, policy, conversation, notifications, jobs, usage or AI allowance',
      );
      assert.equal(providerCalls, 0);
      await mutate(
        'UPDATE owner_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
        [businessIds[0]],
      );
      await get(inquiry.id).expect(401);
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
