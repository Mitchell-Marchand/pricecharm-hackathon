import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

test(
  'approved unit changes preserve historical and pending-import units and exclude incompatible quantities from pricing checks',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'isolated-test-key';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const realFetch = globalThis.fetch;
    const project = {
      title: 'Whole event job',
      description: 'An entire event photographed for a fixed total',
      quantity: 1,
      unitLabel: 'project',
      finalPriceCents: 22500,
      rationale: 'One fixed total for the entire event',
      currency: 'USD',
      inputs: [],
      issues: [],
    };
    globalThis.fetch = async (input, options) => {
      assert.equal(String(input), 'https://api.openai.com/v1/responses');
      const payload = JSON.parse(String(options?.body));
      const result = payload.text.format.schema.properties.projects
        ? { projects: [project], notes: [] }
        : {
            unitLabel: 'window',
            unitPriceCents: 900,
            basePriceCents: 0,
            minimumChargeCents: 12000,
            requiredInputs: ['number of windows'],
            exclusions: [],
            pricingRules: [
              {
                id: 'tracks-review',
                name: 'Track restoration',
                field: 'window tracks condition',
                operator: 'equals',
                value: 'restoration needed',
                kind: 'review',
                amount: 0,
              },
            ],
            explanation:
              'Use the owner’s explicit per-window price and minimum. Track restoration needs review.',
            uncertainties: [],
          };
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 5 },
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const owner = request.agent(createApp()),
      origin = 'http://localhost:3100';
    let businessId = '';
    try {
      const registered = await owner
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'QA units',
          businessName: 'QA Unit Preservation',
          email: `qa-units-${randomUUID()}@example.test`,
          password: 'qa-unit-preservation123',
        })
        .expect(201);
      businessId = registered.body.data.business.id;
      await owner
        .patch('/api/v1/business')
        .set('Origin', origin)
        .send({
          description: 'Window cleaning and occasional whole-job projects',
          serviceArea: 'Austin, Texas',
        })
        .expect(200);
      const created = await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Window cleaning',
            description: 'Window glass and screens',
            unitLabel: 'project',
          })
          .expect(201),
        serviceId = created.body.data.id;
      const old = await owner
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId,
          title: 'Whole job',
          description: 'A whole job at a fixed total',
          quantity: 1,
          finalPriceCents: 22500,
          rationale: 'Fixed price for this individual job',
        })
        .expect(201);
      assert.equal(old.body.data.unitLabel, 'project');
      const extracted = await owner
        .post('/api/v1/imports/document')
        .set('Origin', origin)
        .field('serviceId', serviceId)
        .attach('file', Buffer.from('An entire event was photographed for a fixed $225 total.'), {
          filename: 'old-project.txt',
          contentType: 'text/plain',
        })
        .expect(201);
      const proposal = await owner
        .post(`/api/v1/services/${serviceId}/learn`)
        .set('Origin', origin)
        .send({
          notes:
            'I normally charge $9 per window with a $120 minimum and no base charge. Window tracks needing restoration must come to me for review.',
        })
        .expect(201);
      assert.equal(proposal.body.data.proposal.proposal.unitLabel, 'window');
      assert.ok(
        proposal.body.data.proposal.proposal.requiredInputs.includes('window tracks condition'),
        'Every suggested rule must have its required customer question',
      );
      const applied = await owner
        .post(`/api/v1/proposals/${proposal.body.data.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      assert.equal(applied.body.data.service.unitLabel, 'window');
      assert.equal(applied.body.data.service.unitPriceCents, 900);
      assert.equal(applied.body.data.service.minimumChargeCents, 12000);
      const { issues, ...confirmedProject } = project;
      const { unitLabel, ...legacyConfirmation } = confirmedProject;
      await owner
        .post(`/api/v1/imports/${extracted.body.data.draft.id}/confirm`)
        .set('Origin', origin)
        .send({ projects: [{ ...legacyConfirmation, inputs: {} }] })
        .expect(200);
      await owner
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId,
          title: 'Measured window job',
          description: '18 windows cleaned',
          quantity: 18,
          unitLabel: 'window',
          finalPriceCents: 16200,
          rationale: '18 windows at the approved rate',
          inputs: { 'number of windows': '18', 'window tracks condition': 'normal' },
        })
        .expect(201);
      const examples = (await owner.get('/api/v1/examples').expect(200)).body.data;
      assert.equal(examples.length, 3);
      assert.equal(examples.filter((item: any) => item.unitLabel === 'project').length, 2);
      assert.equal(examples.find((item: any) => item.id === old.body.data.id).quantity, 1);
      const evaluated = (
        await owner.post(`/api/v1/services/${serviceId}/evaluate`).set('Origin', origin).expect(200)
      ).body.data;
      assert.equal(
        evaluated.cases.length,
        1,
        'Project quantities must not be evaluated as window counts',
      );
      assert.equal(evaluated.configurationPassed, false);
      assert.equal(evaluated.automaticReady, false);
      const [draft] = await rows('SELECT unit_label FROM import_drafts WHERE id=?', [
        extracted.body.data.draft.id,
      ]);
      assert.equal(draft.unit_label, 'project');
    } finally {
      globalThis.fetch = realFetch;
      if (businessId) {
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
