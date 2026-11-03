import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase } from '../src/db.js';
import { TRADE_DRIVERS } from '../src/practice/trade-drivers.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
// Its own address, so its setup doesn't use up the suite's shared allowance for 127.0.0.1.
const ADDRESS = '203.0.113.72';
after(() => closeDatabase());

test(
  'after each practice quote the Charm asks one thing about the owner’s prices, and the answer is a note',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-question-'));
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const owner = request.agent(createApp()).set('X-Forwarded-For', ADDRESS);
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ tradeId: 'pressure-washing', services: ['Patios & pavers'], name: 'Asks Co' })
      .expect(200);
    await owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin).expect(200);

    type Question = {
      ask: string;
      answers: string[];
      answer: string | null;
      skipped: boolean;
      note: string | null;
    };
    type Run = { id: string; status: string; outcome: string | null; question: Question | null };
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
    const quote = (id: string, cents: number) =>
      owner
        .post(`/api/v1/onboarding/practice/${id}/quote`)
        .set('Origin', origin)
        .send({ lines: [{ id: 'a', label: 'Patio wash, about 600 sq ft', amountCents: cents }] })
        .expect(200);
    const reply = (id: string, body: object) =>
      owner.post(`/api/v1/onboarding/practice/${id}/question`).set('Origin', origin).send(body);
    const knows = async () => (await owner.get('/api/v1/onboarding/knows')).body.data;

    // The first customer: the question that most moves a price in their trade, asked with the quote.
    const first = await ready(0);
    const sent = (await quote(first.id, 25000)).body.data as Run;
    const driver = TRADE_DRIVERS['pressure-washing'][0];
    assert.equal(sent.question?.ask, driver.ask);
    assert.deepEqual(sent.question?.answers, [...driver.answers, driver.no]);
    const answered = (await reply(first.id, { answer: driver.answers[0] }).expect(200)).body
      .data as Run;
    assert.equal(answered.question?.answer, driver.answers[0]);
    assert.match(answered.question?.note ?? '', new RegExp(`^${driver.label}: `));
    let known = await knows();
    assert.ok(
      known.notes.some((note: { text: string }) => note.text === answered.question?.note),
      'The answer is one of the notes every price follows',
    );
    if (driver.customer)
      assert.ok(
        known.questions.some((item: { text: string }) => item.text === driver.customer),
        'It matters, so the live chat asks customers about it',
      );
    await reply(first.id, { answer: 'Twice' }).expect(409);

    // The second: their minimum, offered at amounts under the cheapest job they've priced.
    const second = await ready(1);
    const minimum = (await quote(second.id, 30000)).body.data as Run;
    assert.equal(minimum.question?.ask, 'What’s the least you’d charge for any job?');
    assert.deepEqual(minimum.question?.answers, ['$100', '$175', '$250', 'No minimum']);
    await reply(second.id, { answer: 'No minimum' }).expect(200);
    known = await knows();
    assert.ok(
      known.notes.some((note: { text: string }) => note.text === 'Minimum charge: No minimum.'),
    );

    // The third is skipped: nothing is saved, and it isn't asked again.
    const third = await ready(2);
    const asked = (await quote(third.id, 28000)).body.data as Run;
    assert.ok(asked.question && asked.question.ask !== driver.ask);
    const notes = (await knows()).notes.length;
    const skipped = (await reply(third.id, { skip: true }).expect(200)).body.data as Run;
    assert.equal(skipped.question?.skipped, true);
    assert.equal((await knows()).notes.length, notes);
    const fourth = await ready(3);
    const next = (await quote(fourth.id, 26000)).body.data as Run;
    assert.ok(next.question);
    assert.ok(![driver.ask, minimum.question?.ask, asked.question.ask].includes(next.question.ask));
  },
);
