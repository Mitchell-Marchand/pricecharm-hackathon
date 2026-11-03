import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { json } from '../src/models.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

test(
  'an owner turns practice customers down: the rule or minimum is saved, the score holds and the next customer comes',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-turn-downs-'));
    const { createApp } = await import('../src/app.js');
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
    await owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin).expect(200);
    async function ready(position: number) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = (await owner.get('/api/v1/onboarding/practice')).body.data;
        if (state.runs[position]?.status === 'ready') return state.runs[position];
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('The practice customer never became ready.');
    }
    const post = (url: string, body: object) =>
      owner.post(`/api/v1${url}`).set('Origin', origin).send(body);
    const score = async () =>
      (await owner.get('/api/v1/onboarding/charm')).body.data.readiness.score as number;

    const first = await ready(0);
    const asked = await post(`/onboarding/practice/${first.id}/messages`, {
      text: 'How big is the patio?',
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const before = await score();
    const prefill = await owner.get(`/api/v1/onboarding/practice/${first.id}/decline`);
    assert.equal(prefill.status, 200, JSON.stringify(prefill.body));
    // The size the pricing reads from this customer, shown only now that they're turned down.
    const size = prefill.body.data.size as { quantity: number; unit: string };
    assert.equal(size.unit, 'sq ft');
    assert.ok(size.quantity > 0);
    assert.equal(prefill.body.data.service, first.serviceName);
    assert.ok(prefill.body.data.extras.length > 0, 'The extras on this job, to pick from');

    const both = await post(`/onboarding/practice/${first.id}/decline`, {
      kind: 'too_small',
      size: size.quantity,
      sizeUnit: 'sq ft',
      priceCents: 10000,
    });
    assert.equal(both.body.error?.code, 'TURN_DOWN_LINE', 'A size or a price, not both');
    assert.equal(
      (
        await stranger
          .post(`/api/v1/onboarding/practice/${first.id}/decline`)
          .set('Origin', origin)
          .send({ kind: 'lead_time', days: 7 })
      ).status,
      404,
      'Only the owner’s own customers',
    );
    const declined = await post(`/onboarding/practice/${first.id}/decline`, {
      kind: 'too_small',
      size: size.quantity,
      sizeUnit: 'square feet',
    });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const run = declined.body.data;
    assert.equal(run.outcome, 'declined');
    assert.equal(run.finished, true);
    assert.equal(run.quote, null);
    assert.equal(run.messages.at(-2).from, 'owner');
    assert.equal(run.messages.at(-2).text, 'Sorry, we can’t take this one on.');
    assert.equal(run.messages.at(-1).text, 'No worries, thanks for letting me know.');
    assert.equal(run.turnDown.reason, 'too_small');
    assert.equal(run.turnDown.rule.line, `Jobs of ${size.quantity} sq ft or less`);
    assert.deepEqual(
      run.insights.map((item: { text: string }) => item.text),
      ['Asks about size'],
    );
    const [saved] = await rows('SELECT * FROM turn_down_rules WHERE created_from_run_id=?', [
      first.id,
    ]);
    assert.equal(saved.kind, 'too_small');
    assert.equal(Number(saved.size), size.quantity);
    assert.equal(saved.size_unit, 'sq ft');
    assert.equal(
      (await post(`/onboarding/practice/${first.id}/decline`, { kind: 'lead_time', days: 7 }))
        .status,
      409,
    );

    const state = (await owner.get('/api/v1/onboarding/practice')).body.data;
    assert.equal(state.finished, 1, 'It counts as a finished customer');
    assert.equal(state.results.length, 0, 'With no price, it isn’t a comparison');
    assert.equal(await score(), before, 'Turning one down doesn’t lower the score');
    const [{ outcome }] = await rows('SELECT outcome FROM practice_runs WHERE id=?', [first.id]);
    assert.equal(outcome, 'declined');

    // The owner's minimum raises the practice guess too: it comes through the same pricing as
    // live quotes.
    const second = await ready(1);
    await owner
      .put('/api/v1/onboarding/minimum')
      .set('Origin', origin)
      .send({ minimumCents: 90000 })
      .expect(200);
    await post(`/onboarding/practice/${second.id}/guess`, {}).expect(200);
    const [guessed] = await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [second.id]);
    assert.equal(json<{ cents: number }>(guessed.shadow_json, { cents: 0 }).cents, 90000);
    // Too small, but done at the owner's minimum instead.
    const minimum = await post(`/onboarding/practice/${second.id}/decline`, {
      kind: 'minimum',
      minimumCents: 90000,
    });
    assert.equal(minimum.status, 200, JSON.stringify(minimum.body));
    assert.equal(minimum.body.data.turnDown.minimumCents, 90000);
    assert.equal(minimum.body.data.turnDown.rule, null);
    assert.equal(
      (await owner.get('/api/v1/onboarding/practice')).body.data.results.length,
      0,
      'Its guess isn’t held to anything',
    );

    // The rules, as What it knows and Settings change them.
    let view = (await owner.get('/api/v1/onboarding/turn-downs')).body.data;
    assert.equal(view.minimumCents, 90000);
    assert.equal(view.rules.length, 1);
    for (const body of [
      { kind: 'not_offered', text: 'Gutter repair' },
      { kind: 'too_far', distance: 25, distanceUnit: 'mi' },
      { kind: 'lead_time', days: 7 },
      { kind: 'other', text: 'Jobs with asbestos' },
    ]) {
      const added = await post('/onboarding/turn-downs', body);
      assert.equal(added.status, 201, JSON.stringify(added.body));
      view = added.body.data;
    }
    assert.deepEqual(
      view.rules.map((item: { line: string }) => item.line),
      [
        `Jobs of ${size.quantity} sq ft or less`,
        'Gutter repair',
        'More than about 25 mi away',
        'Anything sooner than 7 days out',
        'Jobs with asbestos',
      ],
    );
    assert.equal((await post('/onboarding/turn-downs', { kind: 'too_far' })).status, 400);
    const small = view.rules[0].id;
    const changed = await owner
      .put(`/api/v1/onboarding/turn-downs/${small}`)
      .set('Origin', origin)
      .send({ kind: 'too_small', size: 300, sizeUnit: 'sq ft' });
    assert.equal(changed.body.data.rules[0].line, 'Jobs of 300 sq ft or less');
    const otherKind = await owner
      .put(`/api/v1/onboarding/turn-downs/${small}`)
      .set('Origin', origin)
      .send({ kind: 'too_big', size: 300, sizeUnit: 'sq ft' });
    assert.equal(otherKind.status, 404, 'A different reason is a different rule');
    assert.equal(
      (await stranger.delete(`/api/v1/onboarding/turn-downs/${small}`).set('Origin', origin))
        .status,
      404,
    );
    await owner.delete(`/api/v1/onboarding/turn-downs/${small}`).set('Origin', origin).expect(200);
    const after = (await owner.get('/api/v1/onboarding/practice')).body.data.runs[0];
    assert.equal(after.turnDown.removed, true, 'The practice card says it was taken out');
    const cleared = await owner
      .put('/api/v1/onboarding/minimum')
      .set('Origin', origin)
      .send({ minimumCents: null });
    assert.equal(cleared.body.data.minimumCents, null);
  },
);

test(
  'the live chat follows the rules: a turned-down request shows no quote and isn’t billed, and the address stays with the owner',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-turn-downs-'));
    process.env.TRUST_PROXY = '1';
    process.env.AGENT_API_KEYS = 'agent-key-for-turn-down-tests';
    let visitor = 0;
    const { createApp } = await import('../src/app.js');
    const { decryptEmail } = await import('../src/integrations/email.js');
    const app = createApp();
    const customerAgent = () =>
      request.agent(app).set('X-Forwarded-For', `198.51.100.${100 + ++visitor}`);

    const owner = request.agent(app);
    await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    await owner
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .send({
        tradeId: 'pressure-washing',
        services: ['Driveways', 'House wash'],
        name: 'Moss & Stone Exterior Care',
        area: 'Portland, OR',
      })
      .expect(200);
    for (const priceCents of [25000, 27500, 30000])
      await owner
        .post('/api/v1/onboarding/jobs')
        .set('Origin', origin)
        .send({
          serviceName: 'Driveways',
          description: 'Two-car driveway wash.',
          priceCents,
          size: '600 sq ft',
        })
        .expect(201);
    const signup = await owner
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({
        firstName: 'Maya',
        lastName: 'Lopez',
        email: `qa-turn-down-${randomUUID()}@example.test`,
        password: 'test password strong123',
      });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const businessId = String(signup.body.data.business.id);
    const slug = String(signup.body.data.business.slug);
    await owner.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan: 'per_quote' });
    await owner.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    await owner.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
    await owner.patch('/api/v1/app/settings').set('Origin', origin).send({ autoSend: true });
    for (const body of [
      { kind: 'not_offered', text: 'Gutter repair' },
      { kind: 'too_far', distance: 25, distanceUnit: 'mi' },
      { kind: 'too_small', size: 200, sizeUnit: 'sq ft' },
    ])
      await owner
        .post('/api/v1/onboarding/turn-downs')
        .set('Origin', origin)
        .send(body)
        .expect(201);

    async function chat() {
      const agent = customerAgent();
      const started = await agent.post(`/api/v1/chat/${slug}/start`).set('Origin', origin).send({});
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const token = started.body.data.token as string;
      const id = started.body.data.chat.id as string;
      const call = (method: 'get' | 'post', suffix: string, body?: object) =>
        agent[method](`/api/v1/chat/${slug}/${id}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      const say = async (text: string) => {
        const said = await call('post', '/messages', { text });
        assert.equal(said.status, 200, JSON.stringify(said.body));
        return said.body.data;
      };
      return { id, call, say };
    }
    const billed = async (chatId: string) =>
      (
        await rows(
          'SELECT u.id FROM quote_usage u JOIN live_quotes q ON q.id=u.quote_id WHERE q.chat_id=?',
          [chatId],
        )
      ).length;
    const turnedDown = async (chatId: string) => {
      const [quote] = await rows('SELECT status,review_reason FROM live_quotes WHERE chat_id=?', [
        chatId,
      ]);
      const [lead] = await rows('SELECT status,turned_down FROM lead_chats WHERE id=?', [chatId]);
      return { quote, lead };
    };

    // Work the owner doesn't do ends the chat at once, kindly, with no quote and nothing billed.
    const gutters = await chat();
    const no = await gutters.say('Hi, I need gutter repair on my house');
    assert.equal(no.status, 'closed');
    assert.equal(no.quote, null);
    assert.equal(
      no.messages.at(-1).text,
      'Sorry, Moss & Stone Exterior Care doesn’t do gutter repair. Thanks for asking.',
    );
    const down = await turnedDown(gutters.id);
    assert.equal(down.quote.status, 'turned_down');
    assert.match(down.quote.review_reason, /^Turned down: not something you do \(gutter repair\)/);
    assert.equal(down.lead.turned_down, 'not_offered');
    assert.equal(await billed(gutters.id), 0);

    // Too far, from what the customer says. And too small, from the size it learns.
    const far = await chat();
    await far.say('Driveways');
    const away = await far.say('We’re about 40 miles out of town, in 97999');
    assert.equal(away.status, 'closed');
    assert.match(away.messages.at(-1).text, /farther than Moss & Stone Exterior Care travels/);
    assert.equal((await turnedDown(far.id)).lead.turned_down, 'too_far');
    const tiny = await chat();
    await tiny.say('Driveways');
    const small = await tiny.say('It’s only about 150 sq ft');
    assert.equal(small.status, 'closed');
    assert.match(small.messages.at(-1).text, /doesn’t take on jobs this small/);
    assert.equal(await billed(tiny.id), 0);

    // The owner sees each as turned down, with why, and none of them waits for an OK.
    const list = (await owner.get('/api/v1/app/quotes?filter=all')).body.data;
    const shown = list.filter((item: { status: string }) => item.status === 'turned_down');
    assert.equal(shown.length, 3);
    assert.ok(
      shown.every((item: { reviewReason: string }) => /^Turned down: /.test(item.reviewReason)),
    );
    assert.equal((await owner.get('/api/v1/app/home')).body.data.counts.needsOk, 0);

    // An agent asking for gutter repair hears the same.
    const agentAsk = await request(app)
      .post(`/api/v1/agent/businesses/${slug}/requests`)
      .set('X-Agent-Key', 'agent-key-for-turn-down-tests')
      .send({ message: 'Price for gutter repair please' });
    assert.equal(agentAsk.status, 201, JSON.stringify(agentAsk.body));
    assert.equal(agentAsk.body.data.request.status, 'turned_down');
    assert.equal(agentAsk.body.data.request.quote, null);

    // The minimum raises the quote, the lead time sets its start, and the area shows on it.
    await owner
      .put('/api/v1/onboarding/minimum')
      .set('Origin', origin)
      .send({ minimumCents: 50000 });
    await owner
      .post('/api/v1/onboarding/turn-downs')
      .set('Origin', origin)
      .send({ kind: 'lead_time', days: 7 })
      .expect(201);
    const yes = await chat();
    await yes.say('Driveways');
    await yes.say('About 600 sq ft, two cars, in 97214.');
    const quoted = await yes.say('Skip photos');
    assert.equal(quoted.status, 'sent', JSON.stringify(quoted.messages.at(-1)));
    assert.equal(quoted.quote.card.lines[0].amountCents, 50000, 'Raised to the minimum');
    assert.equal(quoted.quote.card.start, 'In 7 days or later');
    assert.equal(quoted.quote.card.place, '97214');
    const [spec] = await rows('SELECT spec_json FROM lead_chats WHERE id=?', [yes.id]);
    assert.equal(json<{ location?: string }>(spec.spec_json, {}).location, '97214');

    // The yes takes the job's street address. Only the owner sees it.
    const long = await yes.call('post', '/accept', {
      name: 'Sam Kim',
      email: `sam-${randomUUID()}@example.test`,
      address: 'x'.repeat(201),
    });
    assert.equal(long.body.error?.code, 'ADDRESS_LONG');
    const accepted = await yes.call('post', '/accept', {
      name: 'Sam Kim',
      email: `sam-${randomUUID()}@example.test`,
      address: '12 Elm Street,\nPortland',
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(!JSON.stringify(accepted.body).includes('Elm'), 'Not in the customer’s view');
    const [lead] = await rows('SELECT job_address,spec_json,summary FROM lead_chats WHERE id=?', [
      yes.id,
    ]);
    assert.equal(lead.job_address, '12 Elm Street, Portland');
    assert.ok(!`${lead.spec_json}${lead.summary}`.includes('Elm'), 'Nor in what the AI reads');
    const kept = await rows('SELECT text FROM lead_messages WHERE chat_id=?', [yes.id]);
    assert.ok(!kept.some((message) => String(message.text).includes('Elm')));
    const [quote] = await rows('SELECT id FROM live_quotes WHERE chat_id=?', [yes.id]);
    const detail = (await owner.get(`/api/v1/app/quotes/${quote.id}`)).body.data;
    assert.equal(detail.jobAddress, '12 Elm Street, Portland');
    const [email] = await rows('SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?', [
      `owner-accepted:${yes.id}:once`,
    ]);
    assert.match(
      decryptEmail(email.payload_encrypted).text,
      /Job address: 12 Elm Street, Portland/,
    );
    const events = await rows('SELECT name,detail,props FROM product_events');
    assert.ok(!JSON.stringify(events).includes('Elm'), 'Events never carry it');

    // A price under the owner's line is turned down once it's drafted, and still isn't billed.
    await owner
      .post('/api/v1/onboarding/turn-downs')
      .set('Origin', origin)
      .send({ kind: 'too_small', priceCents: 60000 })
      .expect(201);
    const cheap = await chat();
    await cheap.say('Driveways');
    await cheap.say('About 600 sq ft, two cars.');
    const priced = await cheap.say('Skip photos');
    assert.equal(priced.status, 'closed');
    assert.equal(priced.quote, null);
    const [held] = await rows('SELECT status,total_cents FROM live_quotes WHERE chat_id=?', [
      cheap.id,
    ]);
    assert.equal(held.status, 'turned_down');
    assert.equal(Number(held.total_cents), 50000, 'The owner can see what it came to');
    assert.equal(await billed(cheap.id), 0);

    // With the address turned off, the form doesn't take it.
    await mutate("DELETE FROM turn_down_rules WHERE business_id=? AND kind='too_small'", [
      businessId,
    ]);
    const page = await owner
      .patch('/api/v1/app/quote-page')
      .set('Origin', origin)
      .send({ askAddress: false });
    assert.equal(page.body.data.askAddress, false);
    assert.equal((await request(app).get(`/api/v1/chat/${slug}`)).body.data.asksAddress, false);
    const off = await chat();
    await off.say('Driveways');
    await off.say('About 600 sq ft, two cars.');
    assert.equal((await off.say('Skip photos')).status, 'sent');
    await off
      .call('post', '/accept', { name: 'Lee Park', phone: '555-0199', address: '9 Oak Road' })
      .expect(200);
    const [unasked] = await rows('SELECT job_address FROM lead_chats WHERE id=?', [off.id]);
    assert.equal(unasked.job_address, null);
  },
);
