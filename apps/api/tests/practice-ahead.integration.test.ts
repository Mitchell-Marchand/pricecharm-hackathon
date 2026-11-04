import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

type Run = {
  id: string;
  status: string;
  finished: boolean;
  outcome: string | null;
  focus: string | null;
  serviceName: string | null;
};

/** A setup straight into practice, from an address of its own so it has its own allowance. */
async function practiceSetup(address: string, business: object) {
  process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-ahead-'));
  process.env.TRUST_PROXY = '1';
  const { createApp } = await import('../src/app.js');
  const owner = request.agent(createApp()).set('X-Forwarded-For', address);
  const name = `Ahead Co ${randomUUID()}`;
  await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
  await owner
    .patch('/api/v1/onboarding/business')
    .set('Origin', origin)
    .send({ name, ...business })
    .expect(200);
  const [{ id: businessId }] = await rows('SELECT id FROM businesses WHERE name=?', [name]);

  const prepare = (body: object = {}) =>
    owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin).send(body).expect(200);
  const state = async () => (await owner.get('/api/v1/onboarding/practice')).body.data;
  const runs = async (): Promise<Run[]> => (await state()).runs;
  /** Waits for what the owner would be waiting on. */
  async function until(check: () => Promise<boolean>, what: string) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Never happened: ${what}.`);
  }
  const ready = (id: string) =>
    until(
      async () => (await runs()).find((run) => run.id === id)?.status === 'ready',
      'the customer got ready',
    );
  const say = (id: string, text: string) =>
    owner
      .post(`/api/v1/onboarding/practice/${id}/messages`)
      .set('Origin', origin)
      .send({ text })
      .expect(200);
  const quote = async (id: string) => {
    await owner
      .post(`/api/v1/onboarding/practice/${id}/quote`)
      .set('Origin', origin)
      .send({ lines: [{ id: 'a', label: 'Patio wash, about 500 sq ft', amountCents: 25000 }] })
      .expect(200);
    await until(
      async () => Boolean((await runs()).find((run) => run.id === id)?.finished),
      'the customer finished',
    );
  };
  const more = (body: object = {}) =>
    owner.post('/api/v1/onboarding/practice/more').set('Origin', origin).send(body);
  return { owner, businessId, prepare, state, runs, until, ready, say, quote, more };
}

const started = async (businessId: string) => {
  const [{ count }] = await rows(
    "SELECT COUNT(*) AS count FROM practice_runs WHERE business_id=? AND (status<>'preparing' OR prepare_until IS NOT NULL)",
    [businessId],
  );
  return Number(count);
};

test(
  'a wait makes the customer being answered and the next, however often the page checks',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.80', {
      tradeId: 'pressure-washing',
      services: ['Patios & pavers'],
    });
    await setup.prepare();
    for (let check = 0; check < 6; check++) {
      await setup.state();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const runs = await setup.runs();
    assert.equal(runs.length, 6);
    assert.deepEqual(
      runs.map((run) => run.status),
      ['ready', 'ready', 'preparing', 'preparing', 'preparing', 'preparing'],
    );
    assert.equal(await started(setup.businessId), 2);

    // Answering one starts the one after the next, right then.
    await setup.quote(runs[0].id);
    await setup.ready(runs[2].id);
    assert.equal(await started(setup.businessId), 3);
  },
);

test(
  'early in setup only the first customer starts, and later steps add the next',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.81', {
      customTrade: 'Dog grooming',
      services: ['Full groom'],
    });
    await setup.until(
      async () => (await started(setup.businessId)) === 1,
      'the first customer started',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await started(setup.businessId), 1);
    await setup.prepare();
    await setup.until(
      async () => (await started(setup.businessId)) === 2,
      'the next customer started',
    );
  },
);

test(
  'the first customer goes when its service is turned off, and stays when one is added',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.84', {
      customTrade: 'Dog grooming',
      services: ['Full groom', 'Nail trim'],
    });
    const change = (services: string[]) =>
      setup.owner
        .patch('/api/v1/onboarding/business')
        .set('Origin', origin)
        .send({ services })
        .expect(200);
    await setup.until(
      async () => (await setup.runs())[0]?.status === 'ready',
      'the first customer got ready',
    );
    const [first] = await setup.runs();
    const other = first.serviceName === 'Full groom' ? 'Nail trim' : 'Full groom';

    await change(['Full groom', 'Nail trim', 'Teeth']);
    assert.equal((await setup.runs())[0].id, first.id);

    await change([other, 'Teeth']);
    await setup.until(async () => {
      const [next] = await setup.runs();
      return next?.status === 'ready' && next.id !== first.id;
    }, 'the customer was made again');
    assert.notEqual((await setup.runs())[0].serviceName, first.serviceName);
  },
);

test(
  'going back to change trade drops the customers not started, and keeps the one that was',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.82', {
      customTrade: 'Dog grooming',
      services: ['Full groom'],
    });
    await setup.prepare();
    const [first, second] = await setup.runs();
    await setup.ready(first.id);
    await setup.ready(second.id);
    await setup.say(first.id, 'How big is the dog?');

    await setup.owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ services: ['Full groom', 'Nail trim'] })
      .expect(200);
    assert.equal((await setup.runs()).length, 6, 'Changing services alone keeps them');

    await setup.owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({ customTrade: 'Cat grooming' })
      .expect(200);
    assert.deepEqual(
      (await setup.runs()).map((run) => run.id),
      [first.id],
    );
    await setup.prepare();
    assert.equal((await setup.runs()).length, 6, 'The rest are made again for the new trade');
  },
);

test(
  'past setup’s six the next customer is ready before the owner gets there, and only one',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.83', {
      tradeId: 'pressure-washing',
      services: ['Patios & pavers', 'Driveways'],
    });
    await setup.prepare();
    for (let position = 0; position < 5; position++) {
      const run = (await setup.runs())[position];
      await setup.ready(run.id);
      await setup.quote(run.id);
    }
    const sixth = (await setup.runs())[5];
    assert.equal((await setup.runs()).length, 6, 'Nothing extra while setup’s are still to come');
    await setup.ready(sixth.id);

    // Starting on the last one puts the next behind it, and only once.
    await setup.say(sixth.id, 'How big is it?');
    await setup.say(sixth.id, 'Any stains?');
    const seventh = (await setup.runs())[6];
    assert.ok(seventh, 'The next customer is on the way');
    assert.equal((await setup.runs()).length, 7);
    await setup.ready(seventh.id);

    // What they keep back comes after they open, and the opener never waited on it.
    await setup.until(async () => {
      const [run] = await rows('SELECT scenario_json FROM practice_runs WHERE id=?', [seventh.id]);
      const scenario =
        typeof run.scenario_json === 'string' ? JSON.parse(run.scenario_json) : run.scenario_json;
      return Boolean(scenario.extraPhoto.photoId);
    }, 'the held photo was made');

    // Moving on opens the one that's ready.
    await setup.quote(sixth.id);
    const moved = await setup.more();
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.data.runId, seventh.id);
    assert.equal(moved.body.data.state.runs.length, 7, 'No second spare while one sits unused');

    // A customer for one service goes first, and the spare waits behind it.
    const focused = await setup.more({ service: 'driveways' });
    assert.equal(focused.status, 201, JSON.stringify(focused.body));
    const focusedId = focused.body.data.runId as string;
    assert.notEqual(focusedId, seventh.id);
    await setup.ready(focusedId);
    const state = await setup.state();
    assert.equal(state.runs[state.current].id, focusedId);
    assert.equal(state.runs[state.current].focus, 'Driveways');
    assert.equal(state.runs[state.current + 1].id, seventh.id);

    // Asking again doesn't make another, and neither does a plain "next customer".
    assert.equal((await setup.more({ service: 'Driveways' })).body.data.runId, focusedId);
    assert.equal((await setup.more()).body.data.runId, focusedId);
  },
);

test(
  'a quote sent while the photos are read goes straight in, and only the guess waits for them',
  { skip: !enabled },
  async () => {
    const setup = await practiceSetup('203.0.113.84', {
      tradeId: 'pressure-washing',
      services: ['Patios & pavers'],
    });
    await setup.prepare();
    const [first] = await setup.runs();
    await setup.ready(first.id);
    await mutate(
      'UPDATE practice_runs SET photo_read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 SECOND) WHERE id=?',
      [first.id],
    );
    const sent = Date.now();
    await setup.say(first.id, 'How big is it?');
    await setup.quote(first.id);
    assert.ok(Date.now() - sent >= 1500, 'The customer finishes once the reading is in');
    const [run] = await rows('SELECT outcome FROM practice_runs WHERE id=?', [first.id]);
    assert.equal(run.outcome, 'quote');
  },
);
