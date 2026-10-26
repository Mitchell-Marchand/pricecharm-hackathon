import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mutate, rows, closeDatabase } from '../src/db.js';
test(
  'historical learning requires explicit current-version approval; reviewed imports are atomic and tenant-scoped',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    assert.equal(process.env.AI_PROVIDER, 'demo');
    const { createApp } = await import('../src/app.js');
    const app = createApp(),
      a = request.agent(app),
      b = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    try {
      for (const [index, agent] of [a, b].entries()) {
        const response = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'QA Knowledge',
            businessName: 'QA Knowledge',
            email: `qa-knowledge-${randomUUID()}-${index}@example.test`,
            password: 'strong test password',
          });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        businessIds.push(response.body.data.business.id);
      }
      const created = await a
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Window cleaning',
          description: 'Ground level exterior windows',
          unitLabel: 'window',
          unitPriceCents: 1000,
          basePriceCents: 0,
          minimumChargeCents: 5000,
          requiredInputs: ['access'],
        });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const serviceId = created.body.data.id;
      await a
        .post(`/api/v1/services/${serviceId}/learn`)
        .set('Origin', origin)
        .send({})
        .expect(422);
      await a
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId,
          title: 'Small home',
          description: 'Easy ground access, ten windows',
          quantity: 10,
          finalPriceCents: 10000,
          rationale: 'Ten windows at ten dollars each',
          inputs: { access: 'easy' },
          source: 'historical',
        })
        .expect(201);
      const learned = await a
        .post(`/api/v1/services/${serviceId}/learn`)
        .set('Origin', origin)
        .send({ notes: 'Keep our established minimum.' });
      assert.equal(learned.status, 201, JSON.stringify(learned.body));
      const proposal = learned.body.data.proposal;
      assert.equal(proposal.status, 'pending');
      assert.equal(proposal.proposal.unitPriceCents, 1000);
      assert.equal((await a.get('/api/v1/services')).body.data[0].version, proposal.serviceVersion);
      await b
        .post(`/api/v1/proposals/${proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(404);
      const applied = await a
        .post(`/api/v1/proposals/${proposal.id}/apply`)
        .set('Origin', origin)
        .send({});
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.equal(applied.body.data.service.version, proposal.serviceVersion);
      assert.equal(applied.body.data.proposal.appliedServiceVersion, proposal.serviceVersion);
      assert.equal(applied.body.data.service.publishedAt, null);
      await a
        .post(`/api/v1/proposals/${proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      assert.equal(
        (await a.get('/api/v1/services')).body.data[0].version,
        proposal.serviceVersion,
        'retry cannot reapply pricing',
      );
      const stale = (
        await a.post(`/api/v1/services/${serviceId}/learn`).set('Origin', origin).send({})
      ).body.data.proposal;
      await a
        .patch(`/api/v1/services/${serviceId}`)
        .set('Origin', origin)
        .send({ unitPriceCents: 1200 })
        .expect(200);
      await a
        .post(`/api/v1/proposals/${stale.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      // A provider extraction is always a draft. Seed its persisted output to test the separate
      // owner confirmation boundary without making an external model call.
      const draftId = randomUUID();
      const project = {
        title: 'Reviewed invoice',
        description: 'Fifteen accessible exterior windows',
        quantity: 15,
        unitLabel: 'window',
        finalPriceCents: 18000,
        rationale: 'Standard rate confirmed from invoice',
        inputs: { access: 'easy' },
        currency: 'USD',
      };
      await mutate(
        'INSERT INTO import_drafts(id,business_id,service_id,filename,source_hash,draft_json) VALUES (?,?,?,?,?,?)',
        [
          draftId,
          businessIds[0],
          serviceId,
          'invoice.pdf',
          randomUUID().replaceAll('-', '').padEnd(64, '0'),
          JSON.stringify({
            projects: [project],
            notes: ['Review quantity and amount before importing.'],
          }),
        ],
      );
      await b.get(`/api/v1/imports/${draftId}`).expect(404);
      await a
        .post(`/api/v1/imports/${draftId}/confirm`)
        .set('Origin', origin)
        .send({ projects: [project, { ...project, quantity: 0 }] })
        .expect(400);
      assert.equal(
        (await a.get('/api/v1/examples')).body.data.length,
        1,
        'invalid batch persisted nothing',
      );
      await a
        .post(`/api/v1/imports/${draftId}/confirm`)
        .set('Origin', origin)
        .send({ projects: [{ ...project, currency: 'EUR' }] })
        .expect(400);
      const imported = await a
        .post(`/api/v1/imports/${draftId}/confirm`)
        .set('Origin', origin)
        .send({ projects: [project] });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.equal(imported.body.data.imported, 1);
      assert.equal((await a.get('/api/v1/examples')).body.data.length, 2);
      assert.equal(
        (
          await a
            .post(`/api/v1/imports/${draftId}/confirm`)
            .set('Origin', origin)
            .send({ projects: [project] })
        ).body.data.imported,
        1,
      );
      assert.equal(
        (await a.get(`/api/v1/imports?serviceId=${serviceId}`)).body.data.drafts[0].status,
        'confirmed',
      );
      const document = await a
        .post('/api/v1/imports/document')
        .set('Origin', origin)
        .field('serviceId', serviceId)
        .attach('file', Buffer.from('%PDF-1.7\n%%EOF'), {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
        });
      assert.equal(document.status, 503);
      assert.equal(document.body.error.code, 'LIVE_AI_REQUIRED');
    } finally {
      // Every table is scoped to these newly created fixture tenants; FK order is deliberate.
      for (const businessId of businessIds) {
        for (const table of [
          'quote_usage',
          'contact_verifications',
          'knowledge_proposals',
          'import_drafts',
          'service_test_cases',
          'email_outbox',
          'identity_tokens',
          'billing_accounts',
          'jobs',
          'usage_events',
          'attachments',
          'quotes',
          'public_sessions',
          'messages',
          'training_sessions',
          'evaluations',
          'examples',
          'services',
          'users',
        ])
          await mutate(`DELETE FROM ${table} WHERE business_id=?`, [businessId]);
        await mutate('DELETE FROM businesses WHERE id=?', [businessId]);
      }
      await closeDatabase();
    }
  },
);
