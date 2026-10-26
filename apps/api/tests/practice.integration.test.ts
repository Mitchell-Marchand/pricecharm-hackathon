import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'practice runs three customers end to end: photos, answers, the AI’s guess, quotes and site visits',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'quotefolk-practice-'));
    const { createApp } = await import('../src/app.js');
    const { pricingHistory } = await import('../src/practice/engine.js');
    const app = createApp();
    const owner = request.agent(app),
      stranger = request.agent(app);
    for (const agent of [owner, stranger])
      await agent.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'Patios & pavers'],
        name: 'Moss & Stone Exterior Care',
      })
      .expect(200);
    await owner
      .post('/api/v1/onboarding/jobs')
      .set('Origin', origin)
      .send({
        serviceName: 'Patios & pavers',
        description: 'Back patio and walkway with moss in the joints.',
        priceCents: 27500,
        size: '600 sq ft',
      })
      .expect(201);

    const prepared = await owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.data.runs.length, 3);
    async function practice() {
      for (let attempt = 0; attempt < 60; attempt++) {
        const state = (await owner.get('/api/v1/onboarding/practice')).body.data;
        if (state.runs[state.current]?.status === 'ready') return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The practice customer never became ready.');
    }
    let state = await practice();
    const first = state.runs[0];
    assert.equal(first.customer.name, 'Dana R.');
    assert.equal(first.serviceName, 'Patios & pavers');
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].from, 'customer');
    assert.equal(first.messages[0].photos.length, 2, 'The opener comes with photos');
    assert.equal((await owner.get(first.messages[0].photos[0].url)).status, 200);
    assert.equal(
      (await stranger.get(first.messages[0].photos[0].url)).status,
      404,
      'Practice photos stay private',
    );
    assert.ok(!JSON.stringify(state).includes('Linden Avenue'), 'Unasked facts stay hidden');

    const say = (id: string, text: string) =>
      owner.post(`/api/v1/onboarding/practice/${id}/messages`).set('Origin', origin).send({ text });
    const sized = await say(first.id, 'How big is the patio?');
    assert.equal(sized.status, 200, JSON.stringify(sized.body));
    assert.match(sized.body.data.run.messages.at(-1).text, /550 sq ft/);
    const photo = await say(first.id, 'Could you send me a closer photo by the door?');
    assert.equal(
      photo.body.data.run.messages.at(-1).photos.length,
      1,
      'Asking gets the extra photo',
    );
    const again = await say(first.id, 'Any more pictures?');
    assert.equal(again.body.data.run.messages.at(-1).photos.length, 0);
    const priced = await say(first.id, 'I could do it for $280.');
    assert.equal(priced.body.data.nudge, true, 'A price in chat nudges toward the quote builder');
    assert.equal(
      (
        await stranger
          .post(`/api/v1/onboarding/practice/${first.id}/messages`)
          .set('Origin', origin)
          .send({ text: 'hi' })
      ).status,
      404,
    );

    await owner
      .post(`/api/v1/onboarding/practice/${first.id}/guess`)
      .set('Origin', origin)
      .expect(200);
    const [guessed] = await rows('SELECT shadow_json,quote_json FROM practice_runs WHERE id=?', [
      first.id,
    ]);
    assert.ok(guessed.shadow_json, 'The guess exists before the quote');
    assert.equal(guessed.quote_json, null);
    const emptyQuote = await owner
      .post(`/api/v1/onboarding/practice/${first.id}/quote`)
      .set('Origin', origin)
      .send({ lines: [] });
    assert.equal(emptyQuote.status, 400);
    const quoted = await owner
      .post(`/api/v1/onboarding/practice/${first.id}/quote`)
      .set('Origin', origin)
      .send({
        lines: [
          { id: 'a', label: 'Patio wash, about 550 sq ft', amountCents: 28000 },
          { id: 'b', label: 'Stain pre-treatment', amountCents: 4500 },
        ],
        start: 'Next week',
        duration: '3 hours',
        included: ['Hot-water surface clean'],
        excluded: ['Sealing'],
        validDays: 14,
        note: 'Heavy staining by the door needs a second pass.',
      });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    const done = quoted.body.data;
    assert.equal(done.finished, true);
    assert.equal(done.quote.number, 1001);
    assert.equal(done.quote.customer, 'Dana R.');
    assert.ok(done.shadow.cents > 0);
    assert.deepEqual(
      done.messages
        .slice(-2)
        .map((message: { quote: unknown; from: string }) => [message.from, Boolean(message.quote)]),
      [
        ['owner', true],
        ['customer', false],
      ],
    );
    const insights = done.insights.map((item: { text: string }) => item.text);
    assert.equal(insights[0], 'Asks about size');
    assert.match(insights[1], /^Charges about \$0\.51 per sq ft for patios$/);
    assert.ok(insights.includes('Adds stain pre-treatment for $45'));
    assert.ok(insights.includes('Can usually start next week, about 3 hours on site'));
    assert.ok(insights.some((text: string) => text.startsWith('Remembers why')));
    const again2 = await owner
      .post(`/api/v1/onboarding/practice/${first.id}/quote`)
      .set('Origin', origin)
      .send({ lines: [{ id: 'a', label: 'Patio', amountCents: 100 }] });
    assert.equal(again2.status, 409, 'A finished practice request takes no second quote');

    const fixed = await owner
      .patch(`/api/v1/onboarding/practice/${first.id}/insights/${done.insights[1].id}`)
      .set('Origin', origin)
      .send({ text: 'Charges $0.50 per sq ft, $150 minimum' });
    assert.equal(fixed.status, 200);
    const history = await pricingHistory(
      String(
        (await rows('SELECT business_id FROM practice_runs WHERE id=?', [first.id]))[0].business_id,
      ),
    );
    assert.deepEqual(
      history.notes,
      ['Charges $0.50 per sq ft, $150 minimum'],
      'Corrections teach the AI',
    );
    assert.equal(history.practice[0].lines[0].amountCents, 28000);

    state = await practice();
    assert.equal(state.current, 1);
    const second = state.runs[1];
    assert.equal(second.customer.name, 'Marcus T.');
    const visit = await owner
      .post(`/api/v1/onboarding/practice/${second.id}/site-visit`)
      .set('Origin', origin)
      .send({ reason: 'I want to see how green it is by the planters.' });
    assert.equal(visit.status, 200, JSON.stringify(visit.body));
    assert.equal(visit.body.data.outcome, 'site-visit');
    assert.ok(
      visit.body.data.insights.some((item: { text: string }) =>
        item.text.startsWith('Asks to see jobs like this first'),
      ),
    );

    state = await practice();
    const third = state.runs[2];
    assert.equal(third.customer.name, 'Priya S.');
    await owner
      .post(`/api/v1/onboarding/practice/${third.id}/quote`)
      .set('Origin', origin)
      .send({ lines: [{ id: 'a', label: 'Flagstone wash, about 350 sq ft', amountCents: 17500 }] })
      .expect(200);
    const finished = await owner.post('/api/v1/onboarding/practice/done').set('Origin', origin);
    assert.equal(finished.body.data.finished, 3);
    assert.equal(finished.body.data.results.length, 3);
    assert.equal(finished.body.data.results[1].siteVisit, true);
    assert.equal(
      finished.body.data.results[2].aiFlagged,
      true,
      'It would have asked to see the loose stones',
    );
    assert.equal((await owner.get('/api/v1/onboarding')).body.data.step, 'ready');
  },
);
