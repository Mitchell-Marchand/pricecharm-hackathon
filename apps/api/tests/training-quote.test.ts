import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mutate, rows, transaction, closeDatabase } from '../src/db.js';

process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'isolated-test-key';
process.env.OPENAI_MODEL = 'gpt-4.1-mini';
const { groundTrainingQuote, demoTrainingQuote } = await import('../src/training-quote.js');
const empty = {
  finalPriceCents: null,
  rationale: null,
  evidence: { price: null, rationale: null },
};

test('practice quote drafts recover only exact owner-stated totals and reasons, without rate inference', () => {
  for (const [content, expected] of [
    ['I would charge $275 because it needs extra preparation.', 27500],
    ['My final quote is $1,275.99 because access adds time.', 127599],
    ['The total is USD 150.05 because the surfaces need preparation.', 15005],
    ['I quote 150 dollars because it is a small job.', 15000],
    ['Final quote $0 because this is a warranty repair.', 0],
    ['Materials cost $150; my final quote is $275 because access is difficult.', 27500],
  ] as const) {
    const result = groundTrainingQuote(empty, content);
    assert.equal(result.finalPriceCents, expected, content);
    assert.equal(result.readyToConfirm, true, content);
    assert.match(result.rationale!, /^because /);
    assert.equal('unitPriceCents' in result, false);
  }
});
test('drafts leave rates, costs, tentative totals, ranges, invalid amounts and older prices unknown', () => {
  const model = {
    finalPriceCents: 27500,
    rationale: 'Invented access condition',
    evidence: { price: '$275', rationale: 'Invented access condition' },
  };
  for (const content of [
    'I charge $50 per hour.',
    'My quote is $275 plus materials.',
    'The material cost is $275.',
    '$275 for materials.',
    '$150 materials and $125 labor.',
    'My minimum is $275.',
    'Maybe $275 depending on access.',
    'My quote is between $200 and $300.',
    '$200-$300 because measurements are unknown.',
    '$200 to $300 because measurements are unknown.',
    'I did not quote $275.',
    'Final quote $275.999 because it is a precise number.',
    'Final quote $1000001 because it is a large job.',
    '-275 dollars because it is a discount.',
  ]) {
    const result = groundTrainingQuote(model, content, ['I quoted $275 on a previous job.']);
    assert.equal(result.finalPriceCents, null, content);
    assert.equal(result.readyToConfirm, false, content);
  }
  const reason = 'Because access adds time.';
  for (const [message, evidence, amount] of [
    ['I charged $275 on a previous job.', '$275', 27500],
    ['The customer budget is $275.', '$275', 27500],
    ['My rate is $275 per hour.', '$275', 27500],
    ['Materials cost $275.', '$275', 27500],
    ['My final quote is $650.', '$65', 6500],
    ['My final quote is $65.00.', '$65', 6500],
    ['My final quote is 0.275 USD.', '275 USD', 27500],
    ['My final quote is 12,34 USD.', '34 USD', 3400],
    ['My final quote is 1 500 USD.', '500 USD', 50000],
    ['My final quote is USD 65–70.', 'USD 65', 6500],
    ['My final quote is $65-$70.', '$70', 7000],
    ['My final quote is USD 65 to 70.', 'USD 65', 6500],
    ['My final quote is $275 CAD.', '$275 CAD', 27500],
  ] as const) {
    const result = groundTrainingQuote(
      {
        finalPriceCents: amount,
        rationale: reason,
        evidence: { price: evidence, rationale: reason },
      },
      reason,
      [message],
    );
    assert.equal(result.finalPriceCents, null, message);
    assert.equal(result.readyToConfirm, false, message);
  }
});
test('an exact current inspection decision is confirmable without manufacturing a price', () => {
  for (const content of [
    'I need to visit before I can quote.',
    'I need to inspect before giving a price.',
    'I cannot quote until I inspect the appliance.',
    'This job needs a site visit before pricing.',
    'I need a site visit before I can quote.',
    'I need to take a look on site before I can price the repair.',
    'I have to do an inspection first.',
  ]) {
    const draft = groundTrainingQuote(empty, content);
    assert.equal(draft.outcome, 'inspection_required', content);
    assert.equal(draft.finalPriceCents, null);
    assert.equal(draft.rationale, content);
    assert.equal(draft.readyToConfirm, true);
  }
  for (const content of [
    'Do I need to inspect before I can quote?',
    'I would inspect if the appliance is damaged.',
    'The customer said I need to inspect before quoting.',
    'I do not need a site visit before I can quote.',
    'Send me photos of the leak.',
  ])
    assert.equal(
      groundTrainingQuote(empty, content, ['I need to visit before I can quote.']).readyToConfirm,
      false,
      content,
    );
  const conflicting = groundTrainingQuote(
    empty,
    'I need to visit before I can quote. My final quote is $180 because access is easy.',
  );
  assert.equal(conflicting.readyToConfirm, false);
  assert.equal(conflicting.outcome, null);
  assert.equal(conflicting.finalPriceCents, null);
  const warranty = groundTrainingQuote(empty, 'Final quote $0 because this is a warranty repair.');
  assert.equal(warranty.outcome, 'quote');
  assert.equal(warranty.finalPriceCents, 0);
  assert.equal(warranty.readyToConfirm, true);
});
test('inspection drafts retain the current two-sentence owner decision and reason without prior or customer history', () => {
  const decision =
    'I need to inspect the appliance on site before I can quote. I need to diagnose the fault in person rather than guess at which part needs replacing.';
  const draft = groundTrainingQuote(empty, decision, [
    'I charged $180 on a previous job because it was a quick repair.',
    'The customer asked whether this will cost $100.',
  ]);
  assert.equal(draft.outcome, 'inspection_required');
  assert.equal(draft.rationale, decision);
  assert.equal(draft.finalPriceCents, null);
  assert.equal(draft.readyToConfirm, true);
  const multiline = decision.replace('. I need', '.\nI need');
  assert.equal(groundTrainingQuote(empty, multiline).rationale, multiline);
  const unrelated = groundTrainingQuote(
    empty,
    `The customer said they need a repair. ${decision} A previous job cost $180.`,
  );
  assert.equal(unrelated.rationale, decision);
  assert.equal(unrelated.finalPriceCents, null);
});
test('a current reversal of an inspection decision is ambiguous instead of saving the first clause', () => {
  for (const reversal of [
    'Actually, I can quote without a visit.',
    'I do not need a site visit.',
    'No inspection is needed.',
  ]) {
    const draft = groundTrainingQuote(empty, `I need to inspect first. ${reversal}`);
    assert.equal(draft.outcome, null, reversal);
    assert.equal(draft.rationale, null, reversal);
    assert.equal(draft.finalPriceCents, null, reversal);
    assert.equal(draft.readyToConfirm, false, reversal);
  }
});
test('rationale uses literal owner evidence and never invents a missing reason', () => {
  const absent = groundTrainingQuote(
    {
      finalPriceCents: 27500,
      rationale: 'Difficult access',
      evidence: { price: '$275', rationale: 'Difficult access' },
    },
    'My quote is $275.',
  );
  assert.equal(absent.finalPriceCents, 27500);
  assert.equal(absent.rationale, null);
  assert.match(absent.reply, /right price/);
  const stated = groundTrainingQuote(
    {
      finalPriceCents: 99900,
      rationale: 'Invented extra labor',
      evidence: { price: '$999', rationale: 'quote: "Ground-level access keeps labor down"' },
    },
    'My final quote is $275.',
    ['Ground-level access keeps labor down.'],
  );
  assert.equal(stated.finalPriceCents, 27500, 'The model cannot replace the literal owner amount');
  assert.equal(stated.rationale, 'Ground-level access keeps labor down');
  assert.equal(stated.readyToConfirm, true);
  const question = groundTrainingQuote(
    {
      finalPriceCents: 27500,
      rationale: 'Ground-level access',
      evidence: { price: '$275', rationale: 'Ground-level access' },
    },
    'My quote is $275. Is Ground-level access the reason?',
  );
  assert.equal(question.rationale, null, 'An owner question is not an established rationale');
  const priceTurn = 'My final quote is $275.',
    reasonTurn = 'Because ground-level access keeps labor down.',
    selection = {
      finalPriceCents: 27500,
      rationale: reasonTurn,
      evidence: { price: priceTurn, rationale: reasonTurn },
    };
  const split = groundTrainingQuote(selection, reasonTurn, [priceTurn]);
  assert.equal(split.finalPriceCents, 27500);
  assert.equal(split.rationale, reasonTurn.replace(/\.$/, ''));
  assert.equal(split.readyToConfirm, true, 'Price and reason can be supplied in separate turns');
  const corrected = groundTrainingQuote(
    {
      ...selection,
      finalPriceCents: 30000,
      evidence: { price: 'My corrected final quote is $300.', rationale: reasonTurn },
    },
    reasonTurn,
    [priceTurn, 'My corrected final quote is $300.'],
  );
  assert.equal(corrected.finalPriceCents, 30000, 'The same call selects the current correction');
  assert.equal(corrected.readyToConfirm, true);
  for (const content of [
    'I withdraw that price until I have checked access.',
    'I am undecided between the two prices.',
  ]) {
    const withdrawn = groundTrainingQuote(empty, content, [priceTurn, reasonTurn]);
    assert.equal(withdrawn.finalPriceCents, null, content);
    assert.equal(withdrawn.readyToConfirm, false, 'No automatic last-price fallback exists');
  }
  assert.equal(
    groundTrainingQuote(selection, reasonTurn).readyToConfirm,
    false,
    'A model-selected customer/scenario amount is not an owner statement',
  );
  assert.equal(
    groundTrainingQuote(selection, reasonTurn, [
      priceTurn,
      ...Array.from({ length: 8 }, (_, index) => `Other owner detail ${index}.`),
    ]).readyToConfirm,
    false,
    'A selected price outside the bounded last eight owner turns is not recovered',
  );
  const visit = groundTrainingQuote(selection, 'I need to visit before I can quote.', [priceTurn]);
  assert.equal(visit.outcome, 'inspection_required');
  assert.equal(
    visit.finalPriceCents,
    null,
    'The current inspection decision outranks a prior price',
  );
  const afterVisit = groundTrainingQuote(empty, 'My final quote is $300 because access is clear.', [
    'I need to visit before I can quote.',
  ]);
  assert.equal(afterVisit.finalPriceCents, 30000);
  assert.equal(afterVisit.readyToConfirm, true);
});
test('local practice quote drafts are explicitly labeled and need owner confirmation', () => {
  const result = demoTrainingQuote('I would charge $275 because it needs preparation.');
  assert.equal(result.aiMode, 'demo');
  assert.match(result.reply, /\[Demo quote draft\]/);
  assert.match(result.reply, /confirm/);
  assert.equal(result.readyToConfirm, true);
  assert.equal(
    demoTrainingQuote('Because access adds time.', ['My final quote is $275.']).readyToConfirm,
    false,
    'Demo does not invent a semantic history selection',
  );
});

test(
  'quote-draft HTTP extraction is tenant scoped, non-completing and rejects completed or concurrently changed practice',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    process.env.NODE_ENV = 'test';
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.AI_DAILY_BUSINESS_LIMIT = '500';
    process.env.AI_DAILY_APP_LIMIT = '999999';
    const originalFetch = globalThis.fetch;
    let providerCalls = 0,
      hold: Promise<void> | undefined,
      onCall: (() => void) | undefined;
    let selectedPrice = '$275';
    const suppliedInputs: { ownerMessages: string[]; ownerStatement: string }[] = [];
    globalThis.fetch = async (input, options) => {
      assert.equal(String(input), 'https://api.openai.com/v1/responses');
      providerCalls++;
      const body = JSON.parse(String(options?.body));
      suppliedInputs.push(JSON.parse(body.input[0].content[0].text));
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      onCall?.();
      if (hold) await hold;
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    finalPriceCents: 27500,
                    rationale: 'Extra preparation',
                    evidence: {
                      price: selectedPrice,
                      rationale: 'because it needs extra preparation',
                    },
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { createApp } = await import('../src/app.js');
    const { addMessage } = await import('../src/models.js');
    const app = createApp(),
      a = request.agent(app),
      b = request.agent(app),
      origin = 'http://localhost:3100',
      businessIds: string[] = [];
    try {
      for (const agent of [a, b]) {
        const registered = await agent
          .post('/api/v1/auth/register')
          .set('Origin', origin)
          .send({
            name: 'QA Practice draft',
            businessName: 'QA Practice draft',
            email: `qa-practice-draft-${randomUUID()}@example.test`,
            password: 'strong test password123',
          });
        assert.equal(registered.status, 201, JSON.stringify(registered.body));
        businessIds.push(registered.body.data.business.id);
      }
      const service = await a.post('/api/v1/services').set('Origin', origin).send({
        name: 'Concrete washing',
        description: 'Pressure washing concrete driveways',
        unitLabel: 'square foot',
      });
      assert.equal(service.status, 201, JSON.stringify(service.body));
      const seed = async () => {
        const id = randomUUID();
        await mutate(
          'INSERT INTO training_sessions(id,business_id,service_id,service_version,scenario_json,unit_label) VALUES (?,?,?,?,?,?)',
          [
            id,
            businessIds[0],
            service.body.data.id,
            1,
            JSON.stringify({
              title: 'Driveway cleaning',
              customerName: 'Practice customer',
              description: 'Please wash a 1000 sqft driveway.',
              details: { quantity: '1000 sqft', location: 'Austin' },
            }),
            service.body.data.unitLabel,
          ],
        );
        await addMessage(
          businessIds[0],
          id,
          'training',
          'assistant',
          'I have a budget of $100. Can you quote my driveway?',
        );
        return id;
      };
      const id = await seed();
      await request(app)
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: '$275' })
        .expect(401);
      await b
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: '$275' })
        .expect(404);
      assert.equal(providerCalls, 0);
      await a
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: '' })
        .expect(400);
      const inspectionDecision =
        'I need to inspect the appliance on site before I can quote. I need to diagnose the fault in person rather than guess at which part needs replacing.';
      const noPrice = await a
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: inspectionDecision });
      assert.equal(noPrice.status, 200, JSON.stringify(noPrice.body));
      assert.equal(
        noPrice.body.data.finalPriceCents,
        null,
        'Customer budget and model claims are never the owner total',
      );
      assert.equal(noPrice.body.data.rationale, inspectionDecision);
      assert.equal(noPrice.body.data.outcome, 'inspection_required');
      assert.equal(noPrice.body.data.readyToConfirm, true);
      assert.equal(providerCalls, 0, 'A literal inspection decision needs no model call');
      const reversal = await a
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: 'I need to inspect first. Actually, I can quote without a visit.' })
        .expect(200);
      assert.equal(reversal.body.data.readyToConfirm, false);
      assert.equal(reversal.body.data.outcome, null);
      assert.equal(reversal.body.data.rationale, null);
      assert.equal(
        providerCalls,
        0,
        'A contradictory inspection decision also needs no model call',
      );
      const drafted = await a
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: 'I would charge $275 because it needs extra preparation.' });
      assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
      assert.equal(drafted.body.data.finalPriceCents, 27500);
      assert.equal(drafted.body.data.rationale, 'because it needs extra preparation');
      assert.equal(drafted.body.data.readyToConfirm, true);
      assert.equal((await a.get(`/api/v1/training/${id}`)).body.data.status, 'active');
      assert.equal((await a.get(`/api/v1/training/${id}`)).body.data.messages.length, 1);
      assert.equal(
        (await a.get('/api/v1/examples')).body.data.length,
        0,
        'Draft extraction never saves history',
      );
      await a
        .post(`/api/v1/training/${id}/complete`)
        .set('Origin', origin)
        .send({
          finalPriceCents: drafted.body.data.finalPriceCents,
          rationale: drafted.body.data.rationale,
          saveAsExample: true,
        })
        .expect(200);
      assert.equal((await a.get('/api/v1/examples')).body.data.length, 1);
      const splitId = await seed(),
        priceTurn = 'My final quote is $275.',
        reasonTurn = 'Because it needs extra preparation.';
      await addMessage(businessIds[0], splitId, 'training', 'user', 'My old quote was $800.');
      for (let index = 0; index < 7; index++)
        await addMessage(businessIds[0], splitId, 'training', 'user', `Owner detail ${index}.`);
      await addMessage(businessIds[0], splitId, 'training', 'user', priceTurn);
      await addMessage(businessIds[0], splitId, 'training', 'assistant', 'Why is that the price?');
      selectedPrice = priceTurn;
      const beforeSplit = providerCalls;
      const splitDraft = await a
        .post(`/api/v1/training/${splitId}/quote-draft`)
        .set('Origin', origin)
        .send({ content: reasonTurn })
        .expect(200);
      assert.equal(providerCalls, beforeSplit + 1, 'Split-turn selection uses one existing call');
      assert.equal(splitDraft.body.data.finalPriceCents, 27500);
      assert.equal(splitDraft.body.data.rationale, 'Because it needs extra preparation');
      assert.equal(splitDraft.body.data.readyToConfirm, true);
      assert.deepEqual(suppliedInputs.at(-1)?.ownerMessages, [
        ...Array.from({ length: 7 }, (_, index) => `Owner detail ${index}.`),
        priceTurn,
      ]);
      assert.equal(suppliedInputs.at(-1)?.ownerStatement, reasonTurn);
      assert.equal((await a.get(`/api/v1/training/${splitId}`)).body.data.status, 'active');
      assert.equal(
        (await a.get('/api/v1/examples')).body.data.length,
        1,
        'Capturing a split decision still does not save it before confirmation',
      );
      selectedPrice = '$275';
      const calls = providerCalls;
      await a
        .post(`/api/v1/training/${id}/quote-draft`)
        .set('Origin', origin)
        .send({ content: '$300' })
        .expect(409);
      assert.equal(providerCalls, calls, 'Completed practice is rejected before any provider call');
      const changingId = await seed();
      let release!: () => void, started!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      onCall = started;
      const pending = a
        .post(`/api/v1/training/${changingId}/quote-draft`)
        .set('Origin', origin)
        .send({ content: 'Final quote $275 because it needs extra preparation.' })
        .then((response) => response);
      await called;
      await addMessage(
        businessIds[0],
        changingId,
        'training',
        'user',
        'The access details changed while drafting.',
      );
      release();
      assert.equal(
        (await pending).status,
        409,
        'An in-flight result cannot silently apply to changed conversation facts',
      );
      hold = undefined;
      onCall = undefined;
      await a
        .patch(`/api/v1/services/${service.body.data.id}`)
        .set('Origin', origin)
        .send({ unitLabel: 'window', unitPriceCents: 900 })
        .expect(200);
      const completedOldUnit = await a
        .post(`/api/v1/training/${changingId}/complete`)
        .set('Origin', origin)
        .send({
          finalPriceCents: 22500,
          rationale: 'An older area-based practice job',
          saveAsExample: true,
        });
      assert.equal(completedOldUnit.status, 200, JSON.stringify(completedOldUnit.body));
      assert.equal(completedOldUnit.body.data.unitLabel, 'square foot');
      assert.equal(
        completedOldUnit.body.data.pricingProposal,
        undefined,
        'An old area scenario cannot suggest a per-window rate',
      );
      const saved = (await a.get('/api/v1/examples')).body.data.find(
        (example: any) => example.finalPriceCents === 22500,
      );
      assert.equal(
        saved.unitLabel,
        'square foot',
        'Historical practice retains the unit captured at session creation',
      );
      const [usage] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='quote_delivered'",
        [businessIds[0]],
      );
      assert.equal(
        Number(usage.count),
        0,
        'Private practice drafts never produce billable deliveries',
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const businessId of businessIds)
        await transaction(async (connection) => {
          const days = await rows(
            "SELECT DATE(created_at) AS day,COUNT(*) AS count FROM usage_events WHERE business_id=? AND kind='ai_reservation' GROUP BY DATE(created_at)",
            [businessId],
            connection,
          );
          for (const day of days) {
            await rows(
              'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day=? FOR UPDATE',
              [day.day],
              connection,
            );
            await mutate(
              'UPDATE ai_daily_budgets SET total_reserved=GREATEST(0,total_reserved-?) WHERE budget_day=?',
              [Number(day.count), day.day],
              connection,
            );
          }
          await mutate(
            'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
            [businessId],
            connection,
          );
          for (const table of [
            'usage_events',
            'jobs',
            'quotes',
            'public_sessions',
            'messages',
            'training_sessions',
            'evaluations',
            'examples',
            'service_test_cases',
            'services',
            'users',
          ])
            await mutate(`DELETE FROM ${table} WHERE business_id=?`, [businessId], connection);
          await mutate('DELETE FROM businesses WHERE id=?', [businessId], connection);
        });
      await closeDatabase();
    }
  },
);
