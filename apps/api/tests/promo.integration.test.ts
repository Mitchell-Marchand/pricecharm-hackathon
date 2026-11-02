import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';
import { reconcileStripeCustomer, stripeClient } from '../src/billing.js';
import { recordAcceptance, recordLiveDelivery } from '../src/live/billing.js';
import { deleteBusinessAccount } from '../src/accounts.js';
import { json } from '../src/models.js';
import { addCode, endCode, listCodes } from '../src/promo.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
const DAY = 86400;

test(
  'a code goes on once before the first card, and the days after the card are free on every plan',
  { skip: !enabled },
  async () => {
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.TRUST_PROXY = '1';
    delete process.env.BILLING_TRIAL_QUOTES;
    const app = createApp(),
      suffix = randomUUID().slice(0, 8);
    const businesses: string[] = [],
      codes: string[] = [];
    let owners = 0;
    /** A new owner, from an address of their own so signup limits don't add up across tests. */
    async function register(name: string) {
      const agent = request
        .agent(app)
        .set('X-Forwarded-For', `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4)}::${++owners}`);
      const created = await agent
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: `Promo ${name}`,
          businessName: `Promo ${name} ${suffix}`,
          email: `promo-${name}-${suffix}@example.test`,
          password: 'promo test password123',
        })
        .expect(201);
      const id = String(created.body.data.business.id);
      businesses.push(id);
      return { agent, id };
    }
    const enter = (agent: request.Agent, code: string) =>
      agent.post('/api/v1/app/billing/code').set('Origin', origin).send({ code });
    const choose = (agent: request.Agent, plan: string) =>
      agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
    const addCard = (agent: request.Agent) =>
      agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
    const billing = async (agent: request.Agent) =>
      (await agent.get('/api/v1/app/billing').expect(200)).body.data;
    const fees = async (quoteId: string) =>
      (
        await rows(
          'SELECT charge,fee_cents,waived_cents FROM quote_usage WHERE quote_id=? ORDER BY charge',
          [quoteId],
        )
      ).map((row) => [row.charge, Number(row.fee_cents), Number(row.waived_cents)]);
    try {
      // Codes are made with the script: checked, and ended without touching who already has one.
      const free = await addCode({ code: `free-${suffix}`, days: 30, uses: 1, note: 'Test' });
      const ended = await addCode({ code: `ended-${suffix}`, days: 30 });
      const sub = await addCode({ code: `sub ${suffix}`, days: 30 });
      codes.push(free, ended, sub);
      assert.equal(free, `FREE-${suffix.toUpperCase()}`);
      assert.equal(sub, `SUB${suffix.toUpperCase()}`, 'Spaces go, any case is the same');
      await assert.rejects(addCode({ code: free, days: 30 }), /already exists/);
      await assert.rejects(addCode({ code: 'no', days: 30 }), /3 to 40/);
      await assert.rejects(addCode({ code: `days-${suffix}`, days: 0 }), /1 to 365/);
      await endCode(ended);
      await assert.rejects(endCode(ended), /no code/);

      const a = await register('a');
      assert.deepEqual(
        [(await billing(a.agent)).code, (await billing(a.agent)).canAddCode],
        [null, true],
      );
      assert.equal((await enter(a.agent, 'not-a-code')).body.error?.code, 'CODE_NOT_FOUND');
      assert.equal((await enter(a.agent, ended)).body.error?.code, 'CODE_ENDED');
      const applied = await enter(a.agent, ` ${free.toLowerCase()} `).expect(200);
      assert.deepEqual(applied.body.data.code, { code: free, days: 30, endsAt: null });
      assert.equal(applied.body.data.canAddCode, false);
      await enter(a.agent, free).expect(200);
      assert.equal(
        (await enter(a.agent, sub)).body.error?.code,
        'CODE_ALREADY_USED',
        'One code per business',
      );
      const [redeemed] = await rows(
        "SELECT metadata_json FROM usage_events WHERE business_id=? AND kind='promo_redeemed'",
        [a.id],
      );
      assert.equal(json<{ note: string }>(redeemed.metadata_json, { note: '' }).note, 'Test');

      const b = await register('b');
      assert.equal((await enter(b.agent, free)).body.error?.code, 'CODE_USED_UP');
      await choose(b.agent, 'per_quote');
      await addCard(b.agent);
      assert.equal(
        (await enter(b.agent, sub)).body.error?.code,
        'CODE_TOO_LATE',
        'Codes go on before the first card',
      );

      // The days start with the card. Quotes shown in them are free on every plan, with what they
      // would have cost kept, and an accepted quote shown in them stays free after they end.
      const record = (quoteId: string) =>
        transaction((connection) =>
          recordLiveDelivery(connection, {
            businessId: a.id,
            quoteId,
            totalCents: 32000,
            sentBy: 'auto',
          }),
        );
      const accept = (quoteId: string) =>
        transaction((connection) =>
          recordAcceptance(connection, { businessId: a.id, quoteId, totalCents: 32000 }),
        );
      await choose(a.agent, 'per_quote');
      await addCard(a.agent);
      const started = await billing(a.agent);
      const [{ card_added_at: cardAt }] = await rows(
        'SELECT card_added_at FROM billing_accounts WHERE business_id=?',
        [a.id],
      );
      assert.equal(
        new Date(started.code.endsAt).getTime(),
        new Date(cardAt).getTime() + 30 * DAY * 1000,
      );
      const [shown, accepted, lateYes, after] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await record(shown);
      assert.deepEqual(await fees(shown), [['delivered', 0, 200]], '$2 let off');
      await mutate('UPDATE billing_accounts SET spending_cap_cents=0 WHERE business_id=?', [a.id]);
      assert.equal((await billing(a.agent)).canSend, true, 'No spending limit is reached');
      await mutate('UPDATE billing_accounts SET spending_cap_cents=100000 WHERE business_id=?', [
        a.id,
      ]);
      await choose(a.agent, 'per_accepted');
      await record(accepted);
      await record(lateYes);
      assert.deepEqual(await accept(accepted), { recorded: true, feeCents: 0 });
      assert.deepEqual(await fees(accepted), [
        ['accepted', 0, 320],
        ['delivered', 0, 0],
      ]);
      // A month on: the days are over, but the quote shown in them is still free when accepted.
      await mutate(
        'UPDATE billing_accounts SET card_added_at=DATE_SUB(card_added_at,INTERVAL 31 DAY) WHERE business_id=?',
        [a.id],
      );
      await mutate(
        'UPDATE quote_usage SET created_at=DATE_SUB(created_at,INTERVAL 31 DAY) WHERE quote_id=?',
        [lateYes],
      );
      assert.equal((await billing(a.agent)).code, null);
      assert.deepEqual(await accept(lateYes), { recorded: true, feeCents: 0 });
      await record(after);
      assert.deepEqual(await accept(after), { recorded: true, feeCents: 320 }, 'Then fees');

      // On the subscription, the free week becomes the code's days.
      const c = await register('c');
      await enter(c.agent, sub).expect(200);
      await choose(c.agent, 'monthly');
      const terms = await billing(c.agent);
      assert.equal(terms.freeWeek, true);
      await addCard(c.agent);
      const trialing = await billing(c.agent);
      assert.equal(trialing.status, 'trialing');
      const trialDays = (new Date(trialing.periodEnd).getTime() - Date.now()) / (DAY * 1000);
      assert.ok(trialDays > 29.9 && trialDays <= 30, `A 30-day trial, not ${trialDays}`);

      const listed = (await listCodes()).filter((row) => codes.includes(row.code));
      const row = (code: string) => listed.find((entry) => entry.code === code)!;
      assert.deepEqual(
        [row(free).uses, row(free).running, row(free).carded, row(free).quotes],
        ['1 of 1', false, 1, 4],
      );
      assert.equal(row(free).staying, '1 of 1', 'Still on a plan after the free days');
      assert.deepEqual([row(ended).uses, row(ended).running], ['0', false]);
      assert.deepEqual([row(sub).uses, row(sub).running], ['1', true]);
    } finally {
      process.env.BILLING_PROVIDER = 'local';
      for (const id of businesses) await removeBusiness(id);
      if (codes.length)
        await mutate(`DELETE FROM promo_codes WHERE code IN (${codes.map(() => '?').join(',')})`, [
          ...codes,
        ]);
    }
  },
);

test(
  'with Stripe, a code says so above Checkout’s button and makes the subscription’s trial its days',
  { skip: !enabled },
  async () => {
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_promo';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_promo';
    const prices = {
      STRIPE_PRICE_PER_QUOTE: 'price_per_quote_mock',
      STRIPE_PRICE_PER_ACCEPTED: 'price_per_accepted_mock',
      STRIPE_PRICE_EXTRA_QUOTES: 'price_extra_quotes_mock',
      STRIPE_PRICE_MONTHLY: 'price_monthly_mock',
      STRIPE_PRICE_YEARLY: 'price_yearly_mock',
      STRIPE_METER_EVENT_NAME: 'pricecharm_quotes',
    };
    Object.assign(process.env, prices);
    process.env.TRUST_PROXY = '1';
    const app = createApp(),
      suffix = randomUUID().slice(0, 8);
    const agent = request
      .agent(app)
      .set('X-Forwarded-For', `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4)}::99`);
    let businessId = '',
      code = '';
    try {
      code = await addCode({ code: `stripe-${suffix}`, days: 30 });
      const created = await agent
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Promo Stripe',
          businessName: `Promo Stripe ${suffix}`,
          email: `promo-stripe-${suffix}@example.test`,
          password: 'promo test password123',
        })
        .expect(201);
      businessId = created.body.data.business.id;

      const stripe = stripeClient();
      const price = (unit_amount: number | null, recurring: object, extra: object = {}) => ({
        active: true,
        currency: 'usd',
        unit_amount,
        recurring,
        ...extra,
      });
      const metered = { usage_type: 'metered', interval: 'month', meter: 'meter_quotes' };
      const catalog: Record<string, unknown> = {
        price_per_quote_mock: price(200, metered),
        price_per_accepted_mock: price(0, metered),
        price_extra_quotes_mock: price(100, metered),
        price_monthly_mock: price(4900, { usage_type: 'licensed', interval: 'month' }),
        price_yearly_mock: price(49900, { usage_type: 'licensed', interval: 'year' }),
      };
      stripe.prices.retrieve = (async (id: string) => catalog[id]) as any;
      stripe.billing.meters.retrieve = (async () => ({
        event_name: 'pricecharm_quotes',
        default_aggregation: { formula: 'sum' },
      })) as any;
      stripe.customers.create = (async () => ({ id: `cus_promo_${suffix}` })) as any;
      const sessions: any[] = [];
      let session: any = { status: 'open', mode: 'setup', url: 'https://checkout.stripe.com/x' };
      stripe.checkout.sessions.create = (async (params: any, options: any) => {
        sessions.push({ params, key: options.idempotencyKey });
        return { id: `cs_promo_${sessions.length}`, url: 'https://checkout.stripe.com/x' };
      }) as any;
      stripe.checkout.sessions.retrieve = (async (id: string) => ({
        id,
        ...session,
        metadata: sessions.at(-1)?.params.metadata,
      })) as any;
      let card: { id: string; created: number } | null = null;
      stripe.customers.retrieve = (async (id: string) => ({
        id,
        invoice_settings: { default_payment_method: card },
      })) as any;
      stripe.customers.listPaymentMethods = (async () => ({ data: [] })) as any;
      stripe.customers.update = (async () => ({})) as any;
      const now = Math.floor(Date.now() / 1000);
      let subscriptions: any[] = [];
      const starts: any[] = [],
        moves: any[] = [];
      const item = (id: string) => ({
        id: `si_${id}`,
        price: { id },
        current_period_end: now + 30 * DAY,
      });
      stripe.subscriptions.list = (async () => ({ data: subscriptions })) as any;
      stripe.subscriptions.create = (async (params: any) => {
        starts.push(params);
        const subscription = {
          id: `sub_promo_${starts.length}`,
          status: params.trial_period_days || params.trial_end ? 'trialing' : 'active',
          created: now,
          cancel_at_period_end: false,
          items: { data: params.items.map((entry: any) => item(entry.price)) },
        };
        subscriptions = [subscription, ...subscriptions];
        return subscription;
      }) as any;
      stripe.subscriptions.update = (async (id: string, params: any) => {
        moves.push(params);
        const subscription = subscriptions.find((entry) => entry.id === id);
        let items = subscription.items.data as any[];
        for (const change of params.items) {
          if (change.deleted) items = items.filter((entry) => entry.id !== change.id);
          else if (change.id)
            items = items.map((entry) => (entry.id === change.id ? item(change.price) : entry));
          else items = [...items, item(change.price)];
        }
        subscription.items.data = items;
        if (params.trial_end === 'now') subscription.status = 'active';
        else if (params.trial_end) subscription.status = 'trialing';
        return subscription;
      }) as any;
      const pick = (plan: string) =>
        agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
      const checkout = () =>
        agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);

      // Before the code, Checkout says what it always has. With it, the code's days come first,
      // and the open checkout from before isn't reused.
      await pick('per_quote');
      await checkout();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].params.metadata.code, undefined);
      await agent.post('/api/v1/app/billing/code').set('Origin', origin).send({ code }).expect(200);
      await checkout();
      assert.equal(sessions.length, 2, 'A new checkout that says what the code gives');
      assert.equal(sessions[1].params.metadata.code, code);
      assert.notEqual(sessions[1].key, sessions[0].key);
      assert.equal(
        sessions[1].params.custom_text.submit.message,
        `With code ${code}, your first 30 days are free, starting today. Then $2 for each quote shown to a customer, billed monthly.`,
      );
      await pick('per_accepted');
      await checkout();
      assert.equal(
        sessions.at(-1).params.custom_text.submit.message,
        `With code ${code}, your first 30 days are free, starting today. Then each month, your card is billed 1% of the quotes customers accepted, at least $1 and at most $25 each. No accepted quotes, no bill.`,
      );
      await pick('monthly');
      await checkout();
      assert.equal(
        sessions.at(-1).params.custom_text.submit.message,
        `With code ${code}, your first 30 days are free, starting today. Then $49 a month. Includes 100 quotes a month. Each one past that is $1, billed monthly.`,
      );

      // The card is saved: the subscription starts on a 30-day trial instead of the week.
      session = {
        status: 'complete',
        mode: 'setup',
        setup_intent: { payment_method: 'pm_promo' },
      };
      card = { id: 'pm_promo', created: now };
      await agent.post('/api/v1/app/billing/sync').set('Origin', origin).send({}).expect(200);
      assert.equal(starts.length, 1);
      assert.equal(starts[0].trial_period_days, 30);
      assert.equal(starts[0].trial_end, undefined);

      // Off the subscription and back inside the free days: the trial runs to the end of them,
      // not another week, and not none.
      await pick('per_quote');
      assert.equal(moves.at(-1).trial_end, 'now');
      await pick('monthly');
      assert.equal(moves.at(-1).trial_end, now + 30 * DAY);
      const back = (await agent.get('/api/v1/app/billing').expect(200)).body.data;
      assert.equal(back.code.endsAt, new Date((now + 30 * DAY) * 1000).toISOString());
      await reconcileStripeCustomer(`cus_promo_${suffix}`);
      assert.equal(starts.length, 1, 'Still one subscription');
    } finally {
      process.env.BILLING_PROVIDER = 'local';
      for (const name of Object.keys(prices)) delete process.env[name];
      if (businessId) await removeBusiness(businessId);
      if (code) await mutate('DELETE FROM promo_codes WHERE code=?', [code]);
      await closeDatabase();
    }
  },
);

async function removeBusiness(id: string) {
  if (!(await rows('SELECT id FROM businesses WHERE id=?', [id])).length) return;
  const deletionId = randomUUID();
  await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [id]);
  await mutate(
    "INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,'scheduled')",
    [deletionId, id],
  );
  await deleteBusinessAccount(id, deletionId);
}
