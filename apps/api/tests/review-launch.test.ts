import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate } from '../src/db.js';

test(
  'a scoped quote-intake link can launch with owner approval while automatic pricing retains its gates',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'demo';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100',
      ids: string[] = [];
    try {
      for (const agent of [owner, other]) {
        const registered = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'QA review launch',
            businessName: 'QA Review Launch',
            email: `qa-review-launch-${randomUUID()}@example.test`,
            password: 'qa-review-launch-password123',
          })
          .expect(201);
        ids.push(registered.body.data.business.id);
      }
      const created = await owner
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Custom event photography',
          description: 'Small private events and family celebrations',
          unitLabel: 'project',
          unitPriceCents: 0,
          minimumChargeCents: 0,
          basePriceCents: 0,
          maxAutoQuoteCents: 0,
          requiredInputs: [],
          exclusions: [],
          pricingRules: [],
        })
        .expect(201);
      const id = created.body.data.id;
      const missing = await owner
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(409);
      assert.equal(missing.body.error.code, 'REVIEW_SCOPE_REQUIRED');
      const profile = await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({
          description: 'Photographing small private events and family celebrations',
          serviceArea: 'Austin, Texas',
          onboardingComplete: true,
        })
        .expect(200);
      const published = await owner
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      assert.equal(published.body.data.mode, 'review');
      assert.ok(published.body.data.publishedAt);
      assert.equal(published.body.data.unitPriceCents, 0);
      assert.equal(published.body.data.maxAutoQuoteCents, 0);
      assert.equal(published.body.data.approvedVersion, null);
      const publicProfile = await request(app)
        .get(`/api/v1/public/${profile.body.data.slug}`)
        .expect(200);
      assert.equal(publicProfile.body.data.services.length, 1);
      assert.equal(publicProfile.body.data.services[0].mode, 'review');
      assert.equal(publicProfile.body.data.services[0].unitPriceCents, undefined);
      assert.equal(publicProfile.body.data.services[0].pricingQuantityRequired, false);
      assert.equal(publicProfile.body.data.services[0].pricingRules, undefined);
      const intakeSession = (
        await request(app)
          .post(`/api/v1/public/${profile.body.data.slug}/sessions`)
          .set('Origin', origin)
          .send({ serviceId: id })
          .expect(201)
      ).body.data;
      assert.equal(intakeSession.session.pricingQuantityRequired, false);
      const restoredIntake = (
        await request(app)
          .get(`/api/v1/public/${profile.body.data.slug}/sessions/${intakeSession.session.id}`)
          .set('Authorization', `Bearer ${intakeSession.token}`)
          .expect(200)
      ).body.data;
      assert.equal(restoredIntake.pricingQuantityRequired, false);
      await other
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(404);
      const automatic = await owner
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true })
        .expect(409);
      assert.equal(automatic.body.error.code, 'EVALUATION_REQUIRED');
      await owner
        .patch(`/api/v1/services/${id}`)
        .set('Origin', origin)
        .send({ unitPriceCents: 15000 })
        .expect(200);
      const privateSession = (
        await owner
          .post('/api/v1/playground/sessions')
          .set('Origin', origin)
          .send({ serviceId: id })
          .expect(201)
      ).body.data;
      assert.match(privateSession.session.messages[0].content, /as a customer would\./);
      assert.equal(privateSession.session.serviceId, id);
      assert.equal(privateSession.session.quoteMode, 'review');
      assert.equal(privateSession.session.pricingQuantityRequired, true);
      assert.equal(privateSession.session.source, 'playground');
      assert.deepEqual(privateSession.session.requiredInputs, ['location']);
      assert.ok(privateSession.session.serviceVersion > created.body.data.version);
      assert.ok(Number.isFinite(Date.parse(privateSession.session.expiresAt)));
      assert.doesNotMatch(
        privateSession.session.messages[0].content,
        /automatic|billable|notifications/,
      );
      const payload = {
        customerName: 'Test customer',
        customerEmail: 'preview@example.test',
        quantity: 1,
        description: 'A small private family celebration in Austin',
        inputs: { location: 'Austin, Texas' },
        contactConsent: true,
      };
      const base = `/api/v1/public/${profile.body.data.slug}/sessions`;
      const privateQuote = (
        await request(app)
          .post(`${base}/${privateSession.session.id}/quote`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${privateSession.token}`)
          .send(payload)
          .expect(201)
      ).body.data;
      assert.equal(privateQuote.status, 'review');
      assert.equal(privateQuote.totalCents, 15000, 'An owner test must show its draft calculation');
      const restored = (
        await request(app)
          .get(`${base}/${privateSession.session.id}`)
          .set('Authorization', `Bearer ${privateSession.token}`)
          .expect(200)
      ).body.data;
      assert.equal(restored.quote.totalCents, 15000);
      assert.match(restored.messages.at(-1).content, /private customer test.*No customer request/i);
      assert.doesNotMatch(restored.messages.at(-1).content, /sent to the business owner/i);
      await owner
        .post(`/api/v1/services/${id}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const liveSession = (
        await request(app).post(base).set('Origin', origin).send({ serviceId: id }).expect(201)
      ).body.data;
      assert.match(
        liveSession.session.messages[0].content,
        /business owner will review the details and prepare your quote\./,
      );
      assert.equal(liveSession.session.pricingQuantityRequired, true);
      assert.doesNotMatch(liveSession.session.messages[0].content, /automatic|approved scope/);
      const liveQuote = (
        await request(app)
          .post(`${base}/${liveSession.session.id}/quote`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${liveSession.token}`)
          .send(payload)
          .expect(201)
      ).body.data;
      assert.equal(liveQuote.status, 'review');
      assert.equal(
        liveQuote.totalCents,
        0,
        'Customers must never receive an unapproved pending price',
      );
      assert.deepEqual(liveQuote.lineItems, []);
    } finally {
      for (const businessId of ids) {
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
