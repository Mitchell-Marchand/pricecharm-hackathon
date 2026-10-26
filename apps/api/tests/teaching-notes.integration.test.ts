import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeDatabase, mutate } from '../src/db.js';

test(
  'owner notes survive refresh, explicit corrections retain unrelated facts, stale proposals and concurrent notes fail closed',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.TRUST_PROXY = '1';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'mock-only';
    process.env.OPENAI_MODEL = 'mock-model';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_BUSINESS_LIMIT = '100';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const originalFetch = globalThis.fetch,
      ids: string[] = [],
      bodies: any[] = [];
    let invalid = false,
      fixtureRequest = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = body.input[0].content[0].text;
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  unitLabel: '',
                  unitPriceCents: invalid ? '4000' : 4000,
                  minimumChargeCents: 50000,
                  basePriceCents: 0,
                  requiredInputs: text.includes('allergy') ? ['menu', 'allergies'] : ['menu'],
                  exclusions: [''],
                  pricingRules: text.includes('allergy')
                    ? [
                        {
                          id: 'allergies',
                          name: 'Review allergy requests',
                          field: 'allergies',
                          operator: 'equals',
                          value: 'yes',
                          kind: 'review',
                          amount: 0,
                        },
                      ]
                    : [],
                  explanation: '',
                  uncertainties: [''],
                }),
              },
            ],
          },
        ],
      });
    };
    const { createApp } = await import('../src/app.js');
    const { deleteBusinessAccount } = await import('../src/accounts.js');
    const app = createApp(),
      owner = request.agent(app),
      other = request.agent(app),
      origin = 'http://localhost:3100';
    try {
      for (const agent of [owner, other]) {
        const result = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'Teaching QA',
            businessName: 'Teaching QA Catering',
            email: `qa-teaching-${randomUUID()}@example.test`,
            password: 'fictional-teaching-test123',
          })
          .expect(201);
        ids.push(result.body.data.business.id);
      }
      const service = (
        await owner
          .post('/api/v1/services')
          .set('Origin', origin)
          .send({
            name: 'Private event catering',
            description: 'Buffet catering for private events',
            unitLabel: 'project',
            unitPriceCents: 0,
            minimumChargeCents: 0,
            basePriceCents: 0,
            maxAutoQuoteCents: 0,
            requiredInputs: ['menu'],
            exclusions: [],
          })
          .expect(201)
      ).body.data;
      await owner
        .post('/api/v1/examples')
        .set('Origin', origin)
        .send({
          serviceId: service.id,
          title: 'A past buffet',
          description: 'One catered private event',
          quantity: 1,
          finalPriceCents: 180000,
          rationale: 'The food and buffet setup for one event.',
        })
        .expect(201);
      const base = `/api/v1/services/${service.id}`;
      const firstNote = 'I normally charge $40 per guest, with a $500 minimum and no base charge.';
      const p1 = (
        await owner
          .post(`${base}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
          .set('Origin', origin)
          .send({ notes: firstNote, expectedTeachingRevision: 0 })
          .expect(201)
      ).body.data;
      assert.equal(p1.teaching.revision, 1);
      assert.equal(p1.proposal.proposal.unitPriceCents, 4000);
      assert.equal(p1.proposal.parentProposalId, null);
      const p2 = (
        await owner
          .post(`${base}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
          .set('Origin', origin)
          .send({
            notes: 'All allergy requests must come to me for review.',
            expectedTeachingRevision: 1,
            previousProposalId: p1.proposal.id,
          })
          .expect(201)
      ).body.data;
      assert.equal(p2.proposal.proposal.unitPriceCents, 4000);
      assert.equal(p2.proposal.proposal.minimumChargeCents, 50000);
      assert.equal(p2.proposal.proposal.unitLabel, 'guest');
      assert.equal(p2.proposal.parentProposalId, p1.proposal.id);
      const restored = (await owner.get(`${base}/proposals`).expect(200)).body.data;
      assert.equal(restored.teaching.revision, 2);
      assert.deepEqual(
        restored.teaching.notes.map((note: any) => note.content),
        [firstNote, 'All allergy requests must come to me for review.'],
      );
      assert.ok(bodies.at(-1).input[0].content[0].text.includes(firstNote));
      assert.equal(
        (await owner.get('/api/v1/services').expect(200)).body.data.find(
          (item: any) => item.id === service.id,
        ).unitPriceCents,
        0,
        'A suggestion never silently changes approved service prices',
      );
      const oldApply = await owner
        .post(`/api/v1/proposals/${p1.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      assert.equal(oldApply.body.error.code, 'TEACHING_CHANGED');
      await other
        .post(`/api/v1/proposals/${p2.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(404);
      const calls = bodies.length;
      await owner
        .post(`${base}/learn`)
        .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
        .set('Origin', origin)
        .send({
          notes: 'A stale note.',
          expectedTeachingRevision: 1,
          previousProposalId: p1.proposal.id,
        })
        .expect(409);
      await other
        .post(`${base}/learn`)
        .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
        .set('Origin', origin)
        .send({ notes: 'Cross tenant note.' })
        .expect(404);
      assert.equal(
        bodies.length,
        calls,
        'Stale and foreign notes are rejected before provider spending',
      );
      const p3 = (
        await owner
          .post(`${base}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
          .set('Origin', origin)
          .send({
            notes: 'Actually use $45 per guest instead.',
            expectedTeachingRevision: 2,
            previousProposalId: p2.proposal.id,
          })
          .expect(201)
      ).body.data;
      assert.equal(p3.proposal.proposal.unitPriceCents, 4500);
      assert.equal(p3.proposal.proposal.minimumChargeCents, 50000);
      assert.equal(p3.proposal.proposal.pricingRules[0].field, 'allergies');
      const beforeClarification = bodies.length;
      const clarification = await owner
        .post(`${base}/learn`)
        .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
        .set('Origin', origin)
        .send({
          notes: 'Actually make it $45.',
          expectedTeachingRevision: 3,
          previousProposalId: p3.proposal.id,
        })
        .expect(422);
      assert.equal(clarification.body.error.code, 'OWNER_NOTES_AMBIGUOUS');
      assert.match(clarification.body.error.message, /standard rate.*minimum.*another fee/);
      assert.equal(bodies.length, beforeClarification, 'Clarifying a target never calls AI');
      assert.equal(
        (await owner.get(`${base}/proposals`).expect(200)).body.data.teaching.revision,
        3,
        'An ambiguous correction does not save notes or change their revision',
      );
      await owner
        .post(`${base}/learn`)
        .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
        .set('Origin', origin)
        .send({
          notes: 'My standard rate is $40 per guest. My standard rate is $45 per guest.',
          expectedTeachingRevision: 3,
          previousProposalId: p3.proposal.id,
        })
        .expect(422);
      invalid = true;
      await owner
        .post(`${base}/learn`)
        .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
        .set('Origin', origin)
        .send({
          notes: 'Unsaved after invalid model output.',
          expectedTeachingRevision: 3,
          previousProposalId: p3.proposal.id,
        })
        .expect(503);
      invalid = false;
      assert.equal(
        (await owner.get(`${base}/proposals`).expect(200)).body.data.teaching.revision,
        3,
      );
      const concurrent = await Promise.all(
        ['Confirm the menu before quoting.', 'Confirm venue access before quoting.'].map((notes) =>
          owner
            .post(`${base}/learn`)
            .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
            .set('Origin', origin)
            .send({ notes, expectedTeachingRevision: 3, previousProposalId: p3.proposal.id }),
        ),
      );
      assert.deepEqual(concurrent.map((result) => result.status).sort(), [201, 409]);
      const winner = concurrent.find((result) => result.status === 201)!.body.data;
      assert.equal(winner.teaching.revision, 4);
      assert.equal(winner.teaching.notes.length, 4);
      assert.equal(winner.proposal.proposal.unitPriceCents, 4500);
      await owner
        .post(`/api/v1/proposals/${p3.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(409);
      await owner
        .post(`/api/v1/proposals/${winner.proposal.id}/apply`)
        .set('Origin', origin)
        .send({})
        .expect(200);
      await owner.patch(base).set('Origin', origin).send({ unitPriceCents: 5000 }).expect(200);
      const manual = (
        await owner
          .post(`${base}/learn`)
          .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
          .set('Origin', origin)
          .send({
            notes: 'Keep guest counts confirmed.',
            expectedTeachingRevision: 4,
            previousProposalId: winner.proposal.id,
          })
          .expect(201)
      ).body.data;
      assert.equal(
        manual.proposal.proposal.unitPriceCents,
        5000,
        'Older owner notes cannot overwrite a later manual pricing edit',
      );
      let latest = manual;
      for (const [notes, price] of [
        ['Ask about the serving schedule.', 5000],
        ['Actually use $55 per guest instead.', 5500],
        ['Confirm the serving schedule before quoting.', 5500],
      ] as const) {
        latest = (
          await owner
            .post(`${base}/learn`)
            .set('X-Forwarded-For', `2001:db8::${++fixtureRequest}`)
            .set('Origin', origin)
            .send({
              notes,
              expectedTeachingRevision: latest.teaching.revision,
              previousProposalId: latest.proposal.id,
            })
            .expect(201)
        ).body.data;
        assert.equal(latest.proposal.proposal.unitPriceCents, price);
        assert.equal(latest.proposal.proposal.minimumChargeCents, 50000);
      }
    } finally {
      globalThis.fetch = originalFetch;
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
