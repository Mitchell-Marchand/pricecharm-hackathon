import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { closeDatabase, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'the live demo quotes from sample data, and its passes and allowances hold',
  { skip: !enabled },
  async () => {
    assert.equal(process.env.AI_PROVIDER, 'demo');
    process.env.TRUST_PROXY = '1';
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    let address = 0;
    // Each part comes from its own address, so the per-visitor cap is only hit where intended.
    const visitor = () => {
      const ip = `198.51.100.${++address}`;
      const post = (path: string, body: object) =>
        request(app)
          .post(`/api/v1/demo/${path}`)
          .set('Origin', origin)
          .set('X-Forwarded-For', ip)
          .send(body);
      return { post };
    };
    const greeting = { from: 'assistant', text: 'Hi! What do you need done?' } as const;

    // A whole demo chat, ending in a quote priced from the sample business.
    const sam = visitor();
    const started = await sam.post('start', {});
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const pass = started.body.data.pass as string;
    const messages: { from: 'customer' | 'assistant'; text: string }[] = [greeting];
    let serviceName = '';
    for (const text of ['Driveways', 'About 500 sq ft, two cars.', 'Skip photos']) {
      messages.push({ from: 'customer', text });
      const turn = await sam.post('turn', {
        tradeId: 'pressure-washing',
        pass,
        serviceName,
        messages,
      });
      assert.equal(turn.status, 200, JSON.stringify(turn.body));
      messages.push({ from: 'assistant', text: turn.body.data.reply });
      serviceName = turn.body.data.serviceName;
      if (turn.body.data.ready) break;
    }
    assert.equal(serviceName, 'Driveways');
    messages.pop();
    const quoted = await sam.post('quote', {
      tradeId: 'pressure-washing',
      pass,
      serviceName,
      messages,
    });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert.deepEqual(
      quoted.body.data.quote.lines.map((line: { amountCents: number }) => line.amountCents),
      [22000],
      'Priced from the sample prices on the server',
    );
    assert.equal(quoted.body.data.quote.place, 'Portland, OR');

    // Passes can't be made up, edited or reused for another trade's data.
    const bad = visitor();
    const turnWith = (body: object) =>
      bad.post('turn', {
        tradeId: 'pressure-washing',
        serviceName: '',
        messages: [greeting, { from: 'customer', text: 'Driveways' }],
        ...body,
      });
    assert.equal((await turnWith({ pass: 'made-up' })).status, 401);
    const [id, expires, signature] = pass.split('.');
    const edited = `${id}.${Number(expires) + 60_000}.${signature}`;
    assert.equal((await turnWith({ pass: edited })).status, 401, 'A longer expiry breaks the seal');
    assert.equal((await turnWith({ pass, tradeId: 'not-a-trade' })).status, 404);
    assert.equal(
      (await turnWith({ pass, messages: [greeting, { from: 'customer', text: 'x'.repeat(301) }] }))
        .status,
      400,
      'Messages stay short',
    );
    const tooLong = [greeting];
    for (let index = 0; index < 11; index++)
      tooLong.push(
        { from: 'customer', text: `Answer ${index}` } as never,
        { from: 'assistant', text: 'Okay.' } as never,
      );
    tooLong.pop();
    assert.equal((await turnWith({ pass, messages: tooLong })).status, 400, 'Chats stay short');

    // One chat can make only so many AI calls.
    const busy = visitor();
    const busyPass = (await busy.post('start', {})).body.data.pass as string;
    const statuses: number[] = [];
    for (let index = 0; index < 13; index++)
      statuses.push(
        (
          await busy.post('turn', {
            tradeId: 'lawn',
            pass: busyPass,
            serviceName: '',
            messages: [greeting, { from: 'customer', text: 'Mowing' }],
          })
        ).status,
      );
    assert.equal(statuses.filter((status) => status === 200).length, 12);
    assert.equal(statuses.at(-1), 429);

    // Each visitor gets a daily allowance across all their chats.
    process.env.AI_DAILY_DEMO_IP_LIMIT = '3';
    const keen = visitor();
    const codes: string[] = [];
    for (let index = 0; index < 4; index++) {
      const keenPass = (await keen.post('start', {})).body.data.pass as string;
      const turn = await keen.post('turn', {
        tradeId: 'painting',
        pass: keenPass,
        serviceName: '',
        messages: [greeting, { from: 'customer', text: 'Interior' }],
      });
      codes.push(turn.body.error?.code ?? 'ok');
    }
    assert.deepEqual(codes, ['ok', 'ok', 'ok', 'DEMO_DAILY_LIMIT']);
    delete process.env.AI_DAILY_DEMO_IP_LIMIT;

    // And the demo as a whole has a daily pool, so it can never crowd out real customers.
    const [budget] = await rows(
      'SELECT demo_reserved FROM ai_daily_budgets WHERE budget_day = UTC_DATE()',
    );
    process.env.AI_DAILY_DEMO_LIMIT = String(budget.demo_reserved);
    const late = visitor();
    const latePass = (await late.post('start', {})).body.data.pass as string;
    const full = await late.post('turn', {
      tradeId: 'painting',
      pass: latePass,
      serviceName: '',
      messages: [greeting, { from: 'customer', text: 'Interior' }],
    });
    assert.equal(full.body.error?.code, 'DEMO_BUSY');
    delete process.env.AI_DAILY_DEMO_LIMIT;
  },
);
