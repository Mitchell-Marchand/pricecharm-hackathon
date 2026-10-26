import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { mutate, rows, closeDatabase } from '../src/db.js';
import { json } from '../src/models.js';

test(
  'owners can privately revise pending quotes before approval while issued quotes remain immutable',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    assert.equal(process.env.AI_PROVIDER, 'demo', 'This test must not call external AI');
    const app = createApp(),
      ownerA = request.agent(app),
      ownerB = request.agent(app),
      origin = 'http://localhost:3100';
    const tenantIds: string[] = [],
      marker = randomUUID();
    try {
      for (const [agent, label] of [
        [ownerA, 'a'],
        [ownerB, 'b'],
      ] as const) {
        const registration = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: `QA Revision ${label}`,
            businessName: `QA Revision ${label}`,
            email: `qa-revision-${label}-${marker}@example.test`,
            password: 'test password strong123',
          });
        assert.equal(registration.status, 201);
        tenantIds.push(registration.body.data.business.id);
      }
      await ownerA
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({ description: 'Routine cleaning requests', serviceArea: 'Austin' })
        .expect(200);
      const serviceResult = await ownerA
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Room cleaning',
          description: 'Standard rooms',
          unitLabel: 'rooms',
          unitPriceCents: 15000,
          requiredInputs: ['room count'],
        });
      assert.equal(serviceResult.status, 201);
      const serviceId = serviceResult.body.data.id;
      for (const quantity of [1, 2, 3])
        await ownerA
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId,
            title: `QA Example ${quantity}`,
            description: 'Standard rooms',
            quantity,
            finalPriceCents: quantity * 15000,
            rationale: 'Standard per-room price',
          })
          .expect(201);
      await ownerA
        .post(`/api/v1/services/${serviceId}/evaluate`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      await ownerA
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const slug = (await ownerA.get('/api/v1/business')).body.data.slug;
      async function submitRequest(quantityUnknown = false) {
        const started = await request(app)
          .post(`/api/v1/public/${slug}/sessions`)
          .send({ serviceId });
        assert.equal(started.status, 201);
        const path = `/api/v1/public/${slug}/sessions/${started.body.data.session.id}`,
          token = started.body.data.token;
        const submitted = await request(app)
          .post(`${path}/quote`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            customerName: 'QA Customer',
            customerEmail: 'qa-revision-customer@example.test',
            quantity: 1,
            quantityUnknown,
            description: 'One room needs cleaning',
            contactConsent: true,
          });
        assert.equal(submitted.status, 201);
        assert.equal(submitted.body.data.totalCents, 0);
        assert.deepEqual(submitted.body.data.lineItems, []);
        return { path, token, id: submitted.body.data.id as string };
      }
      const inquiry = await submitRequest();
      const privateReason = 'Private: an access gate requires extra labor';
      await ownerB
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: privateReason })
        .expect(404);
      await request(app)
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: privateReason })
        .expect(401);
      await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500.5, reason: privateReason })
        .expect(400);
      await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: -1, reason: privateReason })
        .expect(400);
      await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: '   ' })
        .expect(400);
      const revised = await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: privateReason });
      assert.equal(revised.status, 200);
      assert.equal(revised.body.data.totalCents, 17500);
      assert.equal(revised.body.data.status, 'review');
      assert.deepEqual(revised.body.data.lineItems.at(-1), {
        description: 'Price change',
        quantity: 1,
        unitPriceCents: 2500,
        totalCents: 2500,
      });
      assert.equal(
        revised.body.data.lineItems.reduce(
          (total: number, line: { totalCents: number }) => total + line.totalCents,
          0,
        ),
        17500,
      );
      await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 17500, reason: privateReason })
        .expect(200);
      const audits = await rows(
        "SELECT metadata_json FROM usage_events WHERE business_id = ? AND quote_id = ? AND kind = 'quote_revised'",
        [tenantIds[0], inquiry.id],
      );
      assert.equal(audits.length, 1, 'An identical save must not add another private audit entry');
      const audit = json<Record<string, unknown>>(audits[0].metadata_json, {});
      assert.equal(audit.originalTotalCents, 15000);
      assert.equal(audit.newTotalCents, 17500);
      assert.equal(audit.reason, privateReason);
      assert.equal(audit.billable, false);
      const [persisted] = await rows(
        'SELECT calculation_json FROM quotes WHERE business_id = ? AND id = ?',
        [tenantIds[0], inquiry.id],
      );
      assert.equal(
        json<Record<string, unknown>>(persisted.calculation_json, {}).totalCents,
        15000,
        'The original calculator snapshot is retained',
      );
      const pending = await request(app)
        .get(inquiry.path)
        .set('Authorization', `Bearer ${inquiry.token}`);
      assert.equal(pending.body.data.quote.totalCents, 0);
      assert.deepEqual(pending.body.data.quote.lineItems, []);
      assert.equal(JSON.stringify(pending.body).includes(privateReason), false);
      await ownerA
        .post(`/api/v1/quotes/${inquiry.id}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      const issued = await request(app)
        .get(inquiry.path)
        .set('Authorization', `Bearer ${inquiry.token}`);
      assert.equal(issued.body.data.quote.totalCents, 17500);
      assert.equal(issued.body.data.quote.status, 'issued');
      assert.equal(JSON.stringify(issued.body).includes(privateReason), false);
      const immutable = await ownerA
        .patch(`/api/v1/quotes/${inquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 18000, reason: 'Late change' });
      assert.equal(immutable.status, 409);
      assert.equal(immutable.body.error.code, 'QUOTE_NOT_REVIEWABLE');
      assert.deepEqual(
        (
          await request(app)
            .get(inquiry.path)
            .set('Authorization', `Bearer ${inquiry.token}`)
            .expect(200)
        ).body.data.quote.lineItems,
        issued.body.data.quote.lineItems,
        'An issued price snapshot is never rewritten by later revision attempts',
      );

      const lowerInquiry = await submitRequest();
      const discounted = await ownerA
        .patch(`/api/v1/quotes/${lowerInquiry.id}`)
        .set('Origin', origin)
        .send({ totalCents: 12000, reason: 'Owner-authorized reduction' });
      assert.equal(discounted.status, 200);
      assert.equal(discounted.body.data.lineItems.at(-1).totalCents, -3000);
      assert.equal(discounted.body.data.lineItems.at(-1).unitPriceCents, -3000);
      assert.equal(
        discounted.body.data.lineItems.reduce(
          (total: number, line: { totalCents: number }) => total + line.totalCents,
          0,
        ),
        12000,
      );
      for (const totalCents of [22500, 0]) {
        const manual = await submitRequest(true);
        const priced = (
          await ownerA
            .patch(`/api/v1/quotes/${manual.id}`)
            .set('Origin', origin)
            .send({
              totalCents,
              reason: totalCents ? 'Owner set the project price' : 'A free warranty return visit',
            })
            .expect(200)
        ).body.data;
        assert.deepEqual(priced.lineItems, [
          { description: 'Project price', quantity: 1, unitPriceCents: totalCents, totalCents },
        ]);
        assert.equal(Boolean(priced.manualPriceRequired), false);
        await ownerA
          .post(`/api/v1/quotes/${manual.id}/approve`)
          .set('Origin', origin)
          .send({})
          .expect(200);
        const customer = (
          await request(app)
            .get(manual.path)
            .set('Authorization', `Bearer ${manual.token}`)
            .expect(200)
        ).body.data.quote;
        assert.equal(customer.status, 'issued');
        assert.equal(customer.totalCents, totalCents);
        assert.deepEqual(customer.lineItems, priced.lineItems);
      }
      assert.equal((await ownerA.get('/api/v1/usage')).body.data.billableQuotes, 0);
    } finally {
      for (const businessId of tenantIds) {
        await mutate(
          'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id = ?)',
          [businessId],
        );
        for (const table of [
          'attachments',
          'usage_events',
          'jobs',
          'quotes',
          'public_sessions',
          'messages',
          'training_sessions',
          'evaluations',
          'examples',
          'services',
          'users',
        ])
          await mutate(`DELETE FROM ${table} WHERE business_id = ?`, [businessId]);
        await mutate('DELETE FROM businesses WHERE id = ?', [businessId]);
      }
      await closeDatabase();
    }
  },
);
