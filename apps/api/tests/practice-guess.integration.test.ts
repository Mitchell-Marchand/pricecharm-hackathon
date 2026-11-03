import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
// Its own address, so its setup doesn't use up the suite's shared allowance for 127.0.0.1.
const ADDRESS = '203.0.113.71';
after(() => closeDatabase());

test(
  'a new owner’s first three customers get no guess, the fourth does, and sending never waits on it',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-guess-'));
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const owner = request.agent(createApp()).set('X-Forwarded-For', ADDRESS);
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ tradeId: 'pressure-washing', services: ['Patios & pavers'], name: 'First Guess Co' })
      .expect(200);
    await owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin).expect(200);

    type Run = {
      id: string;
      status: string;
      finished: boolean;
      outcome: string | null;
      shadow: { cents: number; withheld: string | null; toGo: number | null } | null;
      messages: { from: string }[];
    };
    const runs = async (): Promise<Run[]> =>
      (await owner.get('/api/v1/onboarding/practice')).body.data.runs;
    async function ready(position: number) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const run = (await runs())[position];
        if (run?.status === 'ready' && !run.outcome) return run;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The practice customer never became ready.');
    }
    async function finished(id: string) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const run = (await runs()).find((item) => item.id === id);
        if (run?.finished) return run;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The practice customer never finished.');
    }
    const quote = (id: string, size: number, cents: number) =>
      owner
        .post(`/api/v1/onboarding/practice/${id}/quote`)
        .set('Origin', origin)
        .send({
          lines: [{ id: 'a', label: `Patio wash, about ${size} sq ft`, amountCents: cents }],
        });

    for (const [position, toGo] of [
      [0, 3],
      [1, 2],
      [2, 1],
    ]) {
      const run = await ready(position);
      // Asked twice, as the quote form and the quote both ask: one guess, held back.
      await Promise.all(
        [0, 1].map(() =>
          owner.post(`/api/v1/onboarding/practice/${run.id}/guess`).set('Origin', origin),
        ),
      );
      const sent = await quote(run.id, 500 + position * 200, 25000 + position * 8000);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      // The owner's quote and the customer's reply are in at once.
      assert.equal(sent.body.data.outcome, 'quote');
      assert.equal(sent.body.data.messages.at(-1).from, 'customer');
      const done = await finished(run.id);
      assert.deepEqual(
        [done.shadow?.withheld, done.shadow?.toGo, done.shadow?.cents],
        ['learning', toGo, 0],
        `Customer ${position + 1}: no guess yet, ${toGo} priced before it guesses`,
      );
    }

    const fourth = await ready(3);
    await quote(fourth.id, 700, 33000).expect(200);
    const guessed = await finished(fourth.id);
    assert.equal(guessed.shadow?.withheld, null, 'Three prices in: it guesses');
    assert.ok((guessed.shadow?.cents ?? 0) > 0);

    // A held-back guess is no comparison, so the results only hold the one it made.
    const state = (await owner.get('/api/v1/onboarding/practice')).body.data;
    assert.deepEqual(
      state.results.map((result: { guessCents: number | null }) => result.guessCents !== null),
      [false, false, false, true],
    );
  },
);
