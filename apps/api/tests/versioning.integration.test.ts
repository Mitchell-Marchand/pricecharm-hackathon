import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { mutate, closeDatabase } from '../src/db.js';
import { getMessages, trainingForBusiness } from '../src/models.js';

test(
  'same-millisecond messages retain insertion order and stale pricing proposals cannot overwrite a newer policy',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    assert.equal(
      process.env.AI_PROVIDER,
      'demo',
      'This regression test must not call external providers',
    );
    const owner = request.agent(createApp()),
      origin = 'http://localhost:3100';
    let businessId: string | undefined;
    try {
      const registration = await owner
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA Versioning',
          businessName: 'QA Versioning',
          email: `qa-versioning-${randomUUID()}@example.test`,
          password: 'test password strong123',
        });
      assert.equal(registration.status, 201);
      businessId = registration.body.data.business.id;
      const created = await owner
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Routine cleaning',
          description: 'Standard routine cleaning',
          unitLabel: 'rooms',
          unitPriceCents: 2500,
          requiredInputs: ['room count'],
        });
      assert.equal(created.status, 201);
      const serviceId = created.body.data.id;
      const training = await owner
        .post('/api/v1/training')
        .set('Origin', origin)
        .send({ serviceId });
      assert.equal(training.status, 201);
      const trainingId = training.body.data.id;

      const [firstId, secondId] = [randomUUID(), randomUUID()].sort().reverse();
      const sameTimestamp = new Date();
      await mutate(
        'INSERT INTO messages (id,business_id,conversation_id,conversation_type,role,content,created_at) VALUES (?,?,?,?,?,?,?)',
        [
          firstId,
          businessId!,
          trainingId,
          'training',
          'user',
          'First: what is the scope?',
          sameTimestamp,
        ],
      );
      await mutate(
        'INSERT INTO messages (id,business_id,conversation_id,conversation_type,role,content,created_at) VALUES (?,?,?,?,?,?,?)',
        [
          secondId,
          businessId!,
          trainingId,
          'training',
          'assistant',
          'Second: two rooms.',
          sameTimestamp,
        ],
      );
      // UUID sorting would reverse these two records. Their durable sequence preserves the exchange.
      assert.deepEqual(
        (await getMessages(businessId!, trainingId, 'training'))
          .slice(-2)
          .map((message) => message.id),
        [firstId, secondId],
      );
      assert.deepEqual(
        (await trainingForBusiness(businessId!))[0].messages.slice(-2).map((message) => message.id),
        [firstId, secondId],
      );
      assert.deepEqual(
        (await owner.get(`/api/v1/training/${trainingId}`)).body.data.messages
          .slice(-2)
          .map((message: { role: string }) => message.role),
        ['user', 'assistant'],
      );

      const completed = await owner
        .post(`/api/v1/training/${trainingId}/complete`)
        .set('Origin', origin)
        .send({
          finalPriceCents: 12000,
          rationale: 'This case suggests a revised room rate',
          saveAsExample: true,
        });
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      const proposal = completed.body.data.pricingProposal;
      assert.ok(proposal);
      const current = (await owner.get('/api/v1/services')).body.data[0];
      assert.equal(current.version, 2);
      assert.equal(
        proposal.serviceVersion,
        current.version,
        'The proposal binds the version after saving training evidence',
      );
      assert.equal(
        current.unitPriceCents,
        2500,
        'A proposal does not silently change the current policy',
      );

      const freshEdit = await owner
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ unitPriceCents: 3000, expectedVersion: current.version });
      assert.equal(freshEdit.status, 200);
      assert.equal(freshEdit.body.data.version, 3);
      const staleApply = await owner
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({
          unitPriceCents: proposal.unitPriceCents,
          expectedVersion: proposal.serviceVersion,
        });
      assert.equal(staleApply.status, 409);
      assert.equal(staleApply.body.error.code, 'SERVICE_VERSION_CONFLICT');
      const unchanged = (await owner.get('/api/v1/services')).body.data[0];
      assert.equal(unchanged.unitPriceCents, 3000);
      assert.equal(unchanged.version, 3);
      const accepted = await owner
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ unitPriceCents: proposal.unitPriceCents, expectedVersion: unchanged.version });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.unitPriceCents, proposal.unitPriceCents);
      assert.equal(accepted.body.data.version, 4);
    } finally {
      if (businessId) {
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
