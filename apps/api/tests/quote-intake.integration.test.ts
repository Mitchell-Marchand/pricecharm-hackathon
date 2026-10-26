import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, getPool, mutate, rows } from '../src/db.js';

test(
  'owner and bearer quote details retain the submitted intake through corrections, retries and decisions without exposing calculator internals',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error('Submitted intake must not call a provider');
    };
    const { createApp } = await import('../src/app.js'),
      { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      businessIds: string[] = [],
      origin = 'http://localhost:3100',
      privateMarker = 'Private calculator and review marker';
    let serviceId = '',
      slug = '';
    const inputs = {
      location: 'Round Rock',
      Vehicle: 'SUV',
      Condition: 'unknown',
      'Pet hair': 'false',
      Passengers: '0',
      Notes: '',
    };
    const expected = { inputs, quantityUnknown: true };
    const payload = {
      customerName: 'Fictional detailing customer',
      customerEmail: 'fictional-intake@example.test',
      description: 'Please detail my compact car in Austin.',
      quantity: 1,
      quantityUnknown: true,
      contactConsent: true,
      inputs,
    };
    const start = async (privatePreview = false) => {
      const created = privatePreview
        ? await owner
            .post('/api/v1/playground/sessions')
            .set('Origin', origin)
            .send({ serviceId })
            .expect(201)
        : await request(app)
            .post(`/api/v1/public/${slug}/sessions`)
            .send({ serviceId })
            .expect(201);
      const value = created.body.data;
      return {
        id: value.session.id as string,
        token: value.token as string,
        path: `/api/v1/public/${slug}/sessions/${value.session.id}`,
      };
    };
    const get = (access: Awaited<ReturnType<typeof start>>) =>
      request(app).get(access.path).set('Authorization', `Bearer ${access.token}`);
    const submit = (access: Awaited<ReturnType<typeof start>>, body: object = payload) =>
      request(app)
        .post(`${access.path}/quote`)
        .set('Authorization', `Bearer ${access.token}`)
        .send(body);
    const boundaries = new Map<string, string>();
    const boundary = (quote: any) => {
      assert.match(quote.receiptAfterMessageId, /^[0-9a-f-]{36}$/i);
      if (boundaries.has(quote.id))
        assert.equal(quote.receiptAfterMessageId, boundaries.get(quote.id));
      else boundaries.set(quote.id, quote.receiptAfterMessageId);
    };
    const pending = (quote: any, intake: unknown) => {
      assert.equal(quote.status, 'review');
      assert.equal(quote.totalCents, 0);
      assert.deepEqual(quote.lineItems, []);
      assert.equal(quote.reviewReason, undefined);
      assert.deepEqual(quote.submittedIntake, intake);
      boundary(quote);
      assert.equal(JSON.stringify(quote).includes(privateMarker), false);
      assert.equal(JSON.stringify(quote).includes('98765000'), false);
      assert.equal(quote.calculation, undefined);
      assert.equal(quote.calculation_json, undefined);
    };
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          ...['quotes', 'public_sessions', 'messages', 'usage_events', 'email_outbox', 'jobs'].map(
            (table) =>
              rows(`SELECT * FROM ${table} WHERE business_id=? ORDER BY id`, [businessIds[0]]),
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
              name: 'Submitted intake fixture',
              businessName: 'Fictional mobile detailing',
              email: `intake-${randomUUID()}@example.test`,
              password: 'intake-fixture-password123',
            })
            .expect(201)
        ).body.data;
        businessIds.push(registered.business.id);
        if (agent === owner) slug = registered.business.slug;
      }
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Mobile vehicle detailing', serviceArea: 'Austin, Round Rock' })
        .expect(200);
      serviceId = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Mobile detailing',
            description: 'Vehicle detailing with owner-reviewed prices',
            unitLabel: 'vehicle',
            maxAutoQuoteCents: 0,
            requiredInputs: [
              'Vehicle',
              'Condition',
              'Pet hair',
              'Passengers',
              'Notes',
              'Obstacles',
              'Access',
              'Depth',
            ],
          })
          .expect(201)
      ).body.data.id;
      await owner
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const factAccess = await start();
      await mutate('UPDATE public_sessions SET facts_json=? WHERE business_id=? AND id=?', [
        JSON.stringify({ location: 'Austin', Vehicle: 'SUV' }),
        businessIds[0],
        factAccess.id,
      ]);
      const noProvider = globalThis.fetch;
      globalThis.fetch = async (url) => {
        assert.equal(String(url), 'https://api.openai.com/v1/responses');
        providerCalls++;
        return Response.json({
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    reply: 'You can send the project details for review.',
                    extractedInputs: [
                      { name: 'Obstacles', value: 'heavy planters around the edges' },
                      { name: 'Access', value: 'level access through a side gate' },
                      { name: 'Depth', value: '2.5' },
                      { name: 'Passengers', value: '2' },
                      { name: 'Vehicle', value: 'Sedan' },
                    ],
                    missingInputs: [],
                    needsReview: false,
                    reviewReason: '',
                  }),
                },
              ],
            },
          ],
        });
      };
      const collected = (
        await request(app)
          .post(`${factAccess.path}/messages`)
          .set('Authorization', `Bearer ${factAccess.token}`)
          .send({
            content:
              'There are heavy planters around the edges. There is level access through a side gate. The depth is 2.5 meters.',
          })
          .expect(200)
      ).body.data.session;
      globalThis.fetch = noProvider;
      assert.deepEqual(collected.collectedInputs, {
        location: 'Austin',
        Vehicle: 'SUV',
        Obstacles: 'heavy planters around the edges',
        Access: 'level access through a side gate',
        Depth: '2.5',
      });
      assert.ok(collected.missingInputs.includes('Passengers'), '2 cannot match 2.5');
      assert.ok(!collected.missingInputs.includes('Obstacles'));
      assert.ok(!collected.missingInputs.includes('Access'));
      assert.deepEqual(
        (await get(factAccess).expect(200)).body.data.collectedInputs,
        collected.collectedInputs,
        'Sentence-final facts and prior known values survive a free session reload',
      );
      const access = await start();
      await mutate('UPDATE public_sessions SET facts_json=? WHERE business_id=? AND id=?', [
        JSON.stringify({ location: 'Austin', Vehicle: 'compact car', Condition: 'Clean' }),
        businessIds[0],
        access.id,
      ]);
      await mutate(
        'INSERT INTO messages(id,business_id,conversation_id,conversation_type,role,content) VALUES (?,?,?,?,?,?)',
        [randomUUID(), businessIds[0], access.id, 'public', 'user', payload.description],
      );
      const posted = (await submit(access).expect(201)).body.data;
      pending(posted, expected);
      const quoteId = posted.id;
      const receiptId = posted.receiptAfterMessageId;
      const [completion] = await rows(
        'SELECT * FROM messages WHERE business_id=? AND conversation_id=? AND id=?',
        [businessIds[0], access.id, receiptId],
      );
      assert.equal(completion.role, 'assistant');
      assert.equal(Boolean(completion.owner_authored), false);
      assert.equal(
        completion.content,
        'Your request has been sent to the business owner for review. You can continue this conversation to clarify the project.',
      );
      await owner
        .post(`/api/v1/quotes/${quoteId}/messages`)
        .set('Origin', origin)
        .send({ content: 'Can you leave the passenger seat clear?' })
        .expect(200);
      await request(app)
        .post(`${access.path}/messages`)
        .set('Authorization', `Bearer ${access.token}`)
        .send({ content: 'Yes, I will leave the passenger seat clear.' })
        .expect(200);
      await mutate(
        'UPDATE messages m JOIN quotes q ON m.business_id=q.business_id AND m.conversation_id=q.public_session_id SET m.created_at=q.created_at WHERE q.business_id=? AND q.id=?',
        [businessIds[0], quoteId],
      );
      const tied = (await get(access).expect(200)).body.data;
      assert.equal(new Set(tied.messages.map((message: any) => message.createdAt)).size, 1);
      assert.equal(tied.quote.receiptAfterMessageId, receiptId);
      const receiptIndex = tied.messages.findIndex((message: any) => message.id === receiptId);
      assert.ok(receiptIndex > 0, 'The original customer note precedes the exact receipt event');
      assert.deepEqual(
        tied.messages.slice(receiptIndex + 1).map((message: any) => message.author),
        ['owner', 'customer'],
        'Equal timestamps never replace the durable ordered message boundary',
      );
      const [stored] = await rows(
        'SELECT calculation_json FROM quotes WHERE business_id=? AND id=?',
        [businessIds[0], quoteId],
      );
      const calculation =
        typeof stored.calculation_json === 'string'
          ? JSON.parse(stored.calculation_json)
          : stored.calculation_json;
      assert.equal(calculation.receiptAfterMessageId, receiptId);
      calculation.unitPriceCents = 98765000;
      calculation.privateMarker = privateMarker;
      await mutate(
        'UPDATE quotes SET calculation_json=?,review_reason=? WHERE business_id=? AND id=?',
        [JSON.stringify(calculation), privateMarker, businessIds[0], quoteId],
      );
      const beforeReads = await snapshot();
      const exact = (await owner.get(`/api/v1/quotes/${quoteId}`).expect(200)).body.data;
      assert.deepEqual(exact.submittedIntake, expected);
      boundary(exact);
      assert.equal(
        exact.quantity,
        1,
        'The existing numeric field is a sentinel, explicitly identified by the snapshot flag',
      );
      pending((await get(access).expect(200)).body.data.quote, expected);
      pending(
        (
          await submit(access, {
            ...payload,
            inputs: { location: 'Dallas', Vehicle: 'Motorcycle' },
            quantity: 9,
            quantityUnknown: false,
          }).expect(200)
        ).body.data,
        expected,
      );
      await other.get(`/api/v1/quotes/${quoteId}`).expect(404);
      await request(app).get(`/api/v1/quotes/${quoteId}`).expect(401);
      await request(app).get(access.path).expect(401);
      await request(app)
        .get(access.path)
        .set('Authorization', `Bearer ${'z'.repeat(43)}`)
        .expect(404);
      assert.equal(
        await snapshot(),
        beforeReads,
        'Reads and duplicate submission do not rewrite intake, messages, budget or delivery',
      );
      const profile = (await request(app).get(`/api/v1/public/${slug}`).expect(200)).body.data;
      assert.equal(JSON.stringify(profile).includes('submittedIntake'), false);
      assert.equal(JSON.stringify(profile).includes('receiptAfterMessageId'), false);
      const listed = (await owner.get('/api/v1/quotes').expect(200)).body.data;
      assert.ok(listed.every((quote: any) => !Object.hasOwn(quote, 'submittedIntake')));
      assert.ok(listed.every((quote: any) => !Object.hasOwn(quote, 'receiptAfterMessageId')));
      const page = (await owner.get('/api/v1/quotes/page').expect(200)).body.data;
      assert.ok(page.quotes.every((quote: any) => !Object.hasOwn(quote, 'submittedIntake')));
      assert.ok(page.quotes.every((quote: any) => !Object.hasOwn(quote, 'receiptAfterMessageId')));
      const dashboard = (await owner.get('/api/v1/dashboard').expect(200)).body.data;
      assert.ok(dashboard.recentQuotes.some((quote: any) => quote.id === quoteId));
      assert.ok(
        dashboard.recentQuotes.every((quote: any) => !Object.hasOwn(quote, 'submittedIntake')),
      );
      assert.ok(
        dashboard.recentQuotes.every(
          (quote: any) => !Object.hasOwn(quote, 'receiptAfterMessageId'),
        ),
      );

      const rollbackAccess = await start();
      assert.match(rollbackAccess.id, /^[0-9a-f-]{36}$/i);
      const beforeRejectedMarker = await snapshot();
      await getPool().query(`CREATE TRIGGER reject_fixture_receipt BEFORE UPDATE ON quotes
        FOR EACH ROW BEGIN
          IF NEW.public_session_id='${rollbackAccess.id}' AND
             JSON_EXTRACT(NEW.calculation_json,'$.receiptAfterMessageId') IS NOT NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fictional receipt marker rejected';
          END IF;
        END`);
      try {
        await submit(rollbackAccess).expect(500);
      } finally {
        await getPool().query('DROP TRIGGER reject_fixture_receipt');
      }
      assert.equal(
        await snapshot(),
        beforeRejectedMarker,
        'A failed marker write rolls back its quote, completion message, session and notification',
      );
      pending((await submit(rollbackAccess).expect(201)).body.data, expected);

      await mutate('UPDATE public_sessions SET facts_json=? WHERE business_id=? AND id=?', [
        '{"location":"Dallas","Vehicle":"Motorcycle"}',
        businessIds[0],
        access.id,
      ]);
      await mutate(
        'UPDATE services SET unit_label=?,required_inputs_json=? WHERE business_id=? AND id=?',
        ['boat', '["A newer question"]', businessIds[0], serviceId],
      );
      const changed = (await get(access).expect(200)).body.data;
      assert.equal(changed.collectedInputs.Vehicle, 'Motorcycle');
      pending(changed.quote, expected);
      for (let attempt = 0; attempt < 2; attempt++) {
        const revised = (
          await owner
            .patch(`/api/v1/quotes/${quoteId}`)
            .set('Origin', origin)
            .send({ totalCents: 25000, reason: privateMarker })
            .expect(200)
        ).body.data;
        assert.deepEqual(revised.submittedIntake, expected);
        boundary(revised);
        assert.equal(Boolean(revised.manualPriceRequired), false);
      }
      pending((await get(access).expect(200)).body.data.quote, expected);
      for (let attempt = 0; attempt < 2; attempt++) {
        const issued = (
          await owner
            .post(`/api/v1/quotes/${quoteId}/approve`)
            .set('Origin', origin)
            .send({})
            .expect(200)
        ).body.data;
        assert.deepEqual(issued.submittedIntake, expected);
        boundary(issued);
        assert.equal(issued.status, 'issued');
      }
      const issuedView = (await get(access).expect(200)).body.data.quote;
      assert.equal(issuedView.totalCents, 25000);
      assert.deepEqual(issuedView.submittedIntake, expected);
      boundary(issuedView);
      assert.equal(issuedView.reviewReason, undefined);
      assert.equal(JSON.stringify(issuedView).includes(privateMarker), false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const accepted = (
          await request(app)
            .post(`${access.path}/decision`)
            .set('Authorization', `Bearer ${access.token}`)
            .send({ decision: 'accepted' })
            .expect(200)
        ).body.data;
        assert.deepEqual(accepted.submittedIntake, expected);
        boundary(accepted);
        assert.equal(accepted.status, 'accepted');
        assert.equal(accepted.reviewReason, undefined);
      }
      assert.deepEqual(
        (await owner.get(`/api/v1/quotes/${quoteId}`).expect(200)).body.data.submittedIntake,
        expected,
      );
      assert.deepEqual((await get(access).expect(200)).body.data.quote.submittedIntake, expected);
      boundary((await get(access).expect(200)).body.data.quote);
      const conversation = (await owner.get(`/api/v1/quotes/${quoteId}/conversation`).expect(200))
        .body.data;
      assert.ok(conversation.some((message: any) => message.content === payload.description));
      const [preserved] = await rows(
        'SELECT calculation_json FROM quotes WHERE business_id=? AND id=?',
        [businessIds[0], quoteId],
      );
      assert.deepEqual(
        typeof preserved.calculation_json === 'string'
          ? JSON.parse(preserved.calculation_json)
          : preserved.calculation_json,
        calculation,
      );

      const knownAccess = await start();
      const knownPayload = {
        ...payload,
        inputs: { location: 'Austin', Vehicle: 'SUV' },
        quantity: 3,
        quantityUnknown: false,
      };
      const known = (await submit(knownAccess, knownPayload).expect(201)).body.data;
      const knownExpected = { inputs: knownPayload.inputs, quantityUnknown: false };
      assert.deepEqual(known.submittedIntake, knownExpected);
      boundary(known);
      assert.equal(known.quantity, 3);
      await owner
        .patch(`/api/v1/quotes/${known.id}`)
        .set('Origin', origin)
        .send({ totalCents: 15000, reason: 'Owner-reviewed scope' })
        .expect(200);
      await owner
        .post(`/api/v1/quotes/${known.id}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      for (let attempt = 0; attempt < 2; attempt++) {
        const declined = (
          await request(app)
            .post(`${knownAccess.path}/decision`)
            .set('Authorization', `Bearer ${knownAccess.token}`)
            .send({ decision: 'declined' })
            .expect(200)
        ).body.data;
        assert.deepEqual(declined.submittedIntake, knownExpected);
        boundary(declined);
        assert.equal(declined.status, 'declined');
        assert.equal(declined.quantity, 3);
      }
      assert.deepEqual(
        (await owner.get(`/api/v1/quotes/${known.id}`).expect(200)).body.data.submittedIntake,
        knownExpected,
      );

      for (const [legacy, intake] of [
        [{}, null],
        [{ inputs: [], quantityUnknown: true }, null],
        [
          { inputs: {}, quantityUnknown: false },
          { inputs: {}, quantityUnknown: false },
        ],
        [{ inputs: { Notes: '' } }, { inputs: { Notes: '' }, quantityUnknown: null }],
        [
          { inputs: { Notes: '' }, receiptAfterMessageId: 'not-a-message-id' },
          { inputs: { Notes: '' }, quantityUnknown: null },
        ],
      ] as const) {
        const legacyAccess = await start();
        const legacyId = randomUUID();
        await mutate(
          'INSERT INTO quotes(id,business_id,service_id,public_session_id,service_version,customer_name,customer_email,status,description,quantity,total_cents,currency,assumptions_json,line_items_json,calculation_json,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            legacyId,
            businessIds[0],
            serviceId,
            legacyAccess.id,
            1,
            'Legacy customer',
            'legacy@example.test',
            'issued',
            'Archived request',
            1,
            0,
            'USD',
            '[]',
            '[]',
            JSON.stringify(legacy),
            'live',
          ],
        );
        await mutate("UPDATE public_sessions SET status='issued' WHERE business_id=? AND id=?", [
          businessIds[0],
          legacyAccess.id,
        ]);
        const legacyOwner = (await owner.get(`/api/v1/quotes/${legacyId}`).expect(200)).body.data;
        const legacyCustomer = (await get(legacyAccess).expect(200)).body.data.quote;
        assert.deepEqual(legacyOwner.submittedIntake, intake);
        assert.deepEqual(legacyCustomer.submittedIntake, intake);
        assert.equal(legacyOwner.receiptAfterMessageId, null);
        assert.equal(legacyCustomer.receiptAfterMessageId, null);
      }
      const raceAccess = await start();
      const raced = await Promise.all([submit(raceAccess), submit(raceAccess)]);
      assert.ok(raced.some((response) => response.status === 201));
      assert.ok(raced.every((response) => [200, 201, 409].includes(response.status)));
      for (const response of raced.filter((value) => value.status !== 409))
        pending(response.body.data, expected);
      pending((await get(raceAccess).expect(200)).body.data.quote, expected);
      assert.equal(
        (
          await rows('SELECT id FROM quotes WHERE business_id=? AND public_session_id=?', [
            businessIds[0],
            raceAccess.id,
          ])
        ).length,
        1,
      );
      const preview = await start(true);
      const previewQuote = (await submit(preview).expect(201)).body.data;
      assert.equal(Object.hasOwn(previewQuote, 'submittedIntake'), false);
      assert.equal(Object.hasOwn(previewQuote, 'receiptAfterMessageId'), false);
      assert.equal(
        Object.hasOwn((await get(preview).expect(200)).body.data.quote, 'submittedIntake'),
        false,
      );
      assert.equal(
        Object.hasOwn((await get(preview).expect(200)).body.data.quote, 'receiptAfterMessageId'),
        false,
      );
      await owner.get(`/api/v1/quotes/${previewQuote.id}`).expect(404);
      await mutate(
        'UPDATE public_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE business_id=? AND id=?',
        [businessIds[0], raceAccess.id],
      );
      await get(raceAccess).expect(404);
      assert.equal(providerCalls, 1, 'Only the explicit fact-collection turn uses a provider');
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
