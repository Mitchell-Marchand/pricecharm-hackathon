import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { mutate, rows, closeDatabase } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
test(
  'tenant isolation, service gates, practice teaching, public review and idempotent delivery persist in MySQL',
  { skip: !enabled },
  async () => {
    assert.equal(
      process.env.AI_PROVIDER,
      'demo',
      'Integration tests must explicitly use demo to prevent live API calls',
    );
    const app = createApp();
    const origin = 'http://localhost:3100';
    const suffix = randomUUID();
    const tenants: string[] = [];
    const ownerA = request.agent(app),
      ownerB = request.agent(app);
    try {
      const registerA = await ownerA
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA Owner A',
          businessName: 'QA Cleaning A',
          email: `qa-a-${suffix}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(registerA.status, 201, JSON.stringify(registerA.body));
      tenants.push(registerA.body.data.business.id);
      assert.match(registerA.headers['set-cookie'][0], /HttpOnly/);
      assert.match(registerA.headers['set-cookie'][0], /SameSite=Lax/);
      const registerB = await ownerB
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA Owner B',
          businessName: 'QA Cleaning B',
          email: `qa-b-${suffix}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(registerB.status, 201);
      tenants.push(registerB.body.data.business.id);
      assert.equal((await ownerA.get('/api/v1/auth/me')).body.data.user.name, 'QA Owner A');
      await ownerA
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({
          description: 'Standard driveway cleaning',
          serviceArea: 'Austin',
          industry: 'Cleaning',
        })
        .expect(200);
      const createService = await ownerA
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Driveway cleaning',
          description: 'Standard concrete surfaces',
          unitLabel: 'square feet',
          unitPriceCents: 25,
          basePriceCents: 2000,
          minimumChargeCents: 10000,
          requiredInputs: ['area', 'surface'],
        });
      assert.equal(createService.status, 201, JSON.stringify(createService.body));
      const serviceId = createService.body.data.id;
      const tenantEscape = await ownerB
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ name: 'Hijacked' });
      assert.equal(tenantEscape.status, 404);
      const exampleEscape = await ownerB.post('/api/v1/examples').set('Origin', origin).send({
        serviceId,
        title: 'Cross tenant',
        description: 'No access',
        quantity: 100,
        finalPriceCents: 10000,
        rationale: 'No access',
      });
      assert.equal(exampleEscape.status, 404);
      assert.deepEqual((await ownerB.get('/api/v1/services')).body.data, []);
      await ownerA
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'automatic', approveAutomatic: true })
        .expect(409);
      for (const quantity of [400, 500, 600]) {
        await ownerA
          .post('/api/v1/examples')
          .set('Origin', origin)
          .send({
            serviceId,
            title: `QA Job ${quantity}`,
            description: 'Standard concrete driveway',
            quantity,
            finalPriceCents: 2000 + quantity * 25,
            rationale: 'Base plus area',
          })
          .expect(201);
      }
      const evaluation = await ownerA
        .post(`/api/v1/services/${serviceId}/evaluate`)
        .set('Origin', origin)
        .send({});
      assert.equal(evaluation.status, 200);
      assert.equal(evaluation.body.data.passed, true);
      await ownerA
        .post(`/api/v1/services/${serviceId}/publish`)
        .set('Origin', origin)
        .send({ mode: 'review' })
        .expect(200);
      const slug = registerA.body.data.business.slug;
      const metadata = await request(app).get(`/api/v1/public/${slug}`);
      assert.equal(metadata.body.data.services.length, 1);
      assert.equal('unitPriceCents' in metadata.body.data.services[0], false);
      const start = await request(app).post(`/api/v1/public/${slug}/sessions`).send({ serviceId });
      assert.equal(start.status, 201);
      const sessionId = start.body.data.session.id,
        token = start.body.data.token;
      const path = `/api/v1/public/${slug}/sessions/${sessionId}`;
      await request(app).get(path).expect(401);
      await request(app)
        .get(path)
        .set('Authorization', `Bearer ${'a'.repeat(43)}`)
        .expect(404);
      const chat = await request(app)
        .post(`${path}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'My concrete driveway is 500 square feet. Is this in your area?' });
      assert.equal(chat.status, 200, JSON.stringify(chat.body));
      assert.deepEqual(
        chat.body.data.session.messages.map((item: { role: string }) => item.role),
        ['assistant', 'user', 'assistant'],
      );
      const payload = {
        customerName: 'QA Customer',
        customerEmail: 'qa-customer@example.test',
        quantity: 500,
        description: '500 sq ft standard concrete driveway in Austin',
        contactConsent: true,
      };
      const quote = await request(app)
        .post(`${path}/quote`)
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      assert.equal(quote.status, 201, JSON.stringify(quote.body));
      assert.equal(quote.body.data.status, 'review');
      assert.equal(quote.body.data.totalCents, 0);
      assert.deepEqual(quote.body.data.lineItems, []);
      const quoteId = quote.body.data.id;
      const duplicate = await request(app)
        .post(`${path}/quote`)
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      assert.equal(duplicate.body.data.id, quoteId);
      assert.equal((await ownerA.get('/api/v1/quotes')).body.data[0].totalCents, 14500);
      await ownerB
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(404);
      const approved = await ownerA
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set('Origin', origin)
        .send({});
      assert.equal(approved.body.data.status, 'issued');
      await ownerA
        .post(`/api/v1/quotes/${quoteId}/approve`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      const usage = await ownerA.get('/api/v1/usage');
      assert.equal(usage.body.data.billableQuotes, 0);
      assert.equal(
        usage.body.data.events.filter((item: { kind: string }) => item.kind === 'quote_delivered')
          .length,
        1,
      );
      const delivered = await request(app).get(path).set('Authorization', `Bearer ${token}`);
      assert.equal(delivered.body.data.quote.totalCents, 14500);
      assert.equal(delivered.body.data.quote.status, 'issued');
      const playground = await ownerA
        .post('/api/v1/playground')
        .set('Origin', origin)
        .send({ serviceId, quantity: 500, description: 'Owner-only test' });
      assert.equal(playground.body.data.quote.totalCents, 14500);
      assert.equal(
        (await ownerA.get('/api/v1/usage')).body.data.events.length,
        usage.body.data.events.length,
      );
      const serviceBeforeTraining = (await ownerA.get('/api/v1/services')).body.data[0];
      const training = await ownerA
        .post('/api/v1/training')
        .set('Origin', origin)
        .send({ serviceId });
      assert.equal(training.status, 201, JSON.stringify(training.body));
      const trainingId = training.body.data.id;
      await ownerB.get(`/api/v1/training/${trainingId}`).expect(404);
      const trainingReply = await ownerA
        .post(`/api/v1/training/${trainingId}/messages`)
        .set('Origin', origin)
        .send({ content: 'How many square feet are there?' });
      assert.equal(trainingReply.status, 200);
      const quantity = Number.parseFloat(training.body.data.scenario.details.quantity);
      const completePayload = {
        finalPriceCents: 2000 + quantity * 50,
        rationale: 'The owner prefers a different rate for this practice scope',
        saveAsExample: true,
      };
      const completed = await ownerA
        .post(`/api/v1/training/${trainingId}/complete`)
        .set('Origin', origin)
        .send(completePayload);
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      assert.equal(completed.body.data.status, 'completed');
      await ownerA
        .post(`/api/v1/training/${trainingId}/complete`)
        .set('Origin', origin)
        .send(completePayload)
        .expect(200);
      const serviceAfterTraining = (await ownerA.get('/api/v1/services')).body.data[0];
      assert.equal(
        serviceAfterTraining.unitPriceCents,
        25,
        'training never silently changes prices',
      );
      assert.equal(
        serviceAfterTraining.publishedAt,
        serviceBeforeTraining.publishedAt,
        'Private evidence preserves owner-reviewed publication',
      );
      assert.equal(serviceAfterTraining.version, serviceBeforeTraining.version + 1);
      assert.equal(serviceAfterTraining.approvedVersion, null);
      assert.equal(serviceAfterTraining.approvedAt, null);
      assert.equal((await ownerA.get('/api/v1/dashboard')).body.data.stats.totalQuotes, 1);
      await ownerA.post('/api/v1/auth/logout').set('Origin', origin).send({}).expect(200);
      await ownerA.get('/api/v1/dashboard').expect(401);
    } finally {
      for (const businessId of tenants) {
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
