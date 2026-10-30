import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';
import { hashToken } from '../src/auth.js';
import {
  dispatchFee,
  ensureBillingAccount,
  reconcileStripeCustomer,
  stripeClient,
} from '../src/billing.js';
import {
  liveBillingAccess,
  liveBillingSummary,
  recordAcceptance,
  recordLiveDelivery,
} from '../src/live/billing.js';
import {
  decryptEmail,
  deliverEmail,
  encryptEmail,
  ownerReplyTo,
  queueEmail,
  validateEmailConfiguration,
} from '../src/integrations/email.js';
import { deleteBusinessAccount } from '../src/accounts.js';
import { runOneJob } from '../src/worker.js';
import { getPhoto, putPhoto } from '../src/storage.js';
import { json } from '../src/models.js';

const enabled = process.env.RUN_DB_TESTS === '1';
/** Mocked Stripe settings: a price for each plan, and the meter that counts billed quotes. */
const stripeSettings = {
  STRIPE_PRICE_PER_QUOTE: 'price_per_quote_mock',
  STRIPE_PRICE_PER_ACCEPTED: 'price_per_accepted_mock',
  STRIPE_PRICE_EXTRA_QUOTES: 'price_extra_quotes_mock',
  STRIPE_PRICE_MONTHLY: 'price_monthly_mock',
  STRIPE_PRICE_YEARLY: 'price_yearly_mock',
  STRIPE_METER_EVENT_NAME: 'pricecharm_quotes',
};
const setStripePrices = () => Object.assign(process.env, stripeSettings);
const clearStripePrices = () => {
  for (const name of Object.keys(stripeSettings)) delete process.env[name];
};
test(
  'identity, customer email codes, durable mail, the fee ledger, signed Stripe events and tenant deletion',
  { skip: !enabled },
  async () => {
    assert.equal(process.env.AI_PROVIDER, 'demo');
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    process.env.BILLING_TRIAL_QUOTES = '2';
    process.env.TRUST_PROXY = '1';
    const app = createApp(),
      origin = 'http://localhost:3100',
      suffix = randomUUID();
    const guest = request
      .agent(app)
      .set('X-Forwarded-For', `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(9, 13)}::1`);
    const a = request.agent(app),
      b = request.agent(app),
      businesses: string[] = [];
    const password = 'commerce test password123',
      newPassword = 'new commerce password456';
    let businessId = '',
      slug = '';
    /** A customer chat on business A's quote link, leaving their name and this email. */
    async function chatWithContact(email = 'Customer@Example.Test') {
      const started = await guest
        .post(`/api/v1/chat/${slug}/start`)
        .set('Origin', origin)
        .send({})
        .expect(201);
      const token = started.body.data.token as string;
      const base = `/api/v1/chat/${slug}/${started.body.data.chat.id}`;
      const call = (suffix: string, body: object, at = base) =>
        guest
          .post(`${at}${suffix}`)
          .set('Origin', origin)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      const contact = await call('/contact', { name: 'Test Customer', email });
      assert.equal(contact.status, 200, JSON.stringify(contact.body));
      return { id: String(started.body.data.chat.id), call, chat: contact.body.data.chat };
    }
    /** A quote a customer received, recorded in the fee ledger once. */
    async function record(quoteId: string, totalCents = 10000) {
      return transaction(
        async (connection) =>
          (
            await recordLiveDelivery(connection, {
              businessId,
              quoteId,
              totalCents,
              sentBy: 'auto',
            })
          ).recorded,
      );
    }
    const canSend = (totalCents = 10000) =>
      transaction(
        async (connection) => (await liveBillingAccess(businessId, connection, totalCents)).canSend,
      );
    try {
      const registered = await a
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Commerce A',
          businessName: 'Commerce Test A',
          email: `commerce-a-${suffix}@example.test`,
          password,
        })
        .expect(201);
      businessId = registered.body.data.business.id;
      slug = registered.body.data.business.slug;
      businesses.push(businessId);
      const other = await b
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Commerce B',
          businessName: 'Commerce Test B',
          email: `commerce-b-${suffix}@example.test`,
          password,
        })
        .expect(201);
      businesses.push(other.body.data.business.id);
      assert.equal(registered.body.data.user.emailVerified, false);

      // The confirmation email has a code too, typed on the page the owner signed up on.
      const signupCode = other.body.data.devCode as string;
      assert.match(signupCode, /^\d{6}$/, 'Signup sends a code along with the link');
      const confirm = (agent: typeof b, code: string) =>
        agent.post('/api/v1/auth/verify-email-code').set('Origin', origin).send({ code });
      const wrongCode = signupCode === '000000' ? '111111' : '000000';
      assert.equal((await confirm(guest, signupCode)).status, 401, 'Only the signed-in owner');
      assert.equal(
        (await confirm(a, signupCode)).body.error?.code,
        'CODE_INVALID',
        'Codes are per owner',
      );
      assert.equal((await confirm(b, wrongCode)).body.error?.code, 'CODE_INVALID');
      assert.equal((await confirm(b, '12345')).status, 400);
      await confirm(b, signupCode).expect(200);
      assert.equal((await b.get('/api/v1/auth/me')).body.data.user.emailVerified, true);
      await confirm(b, signupCode).expect(200);
      const resent = await a
        .post('/api/v1/auth/request-verification')
        .set('Origin', origin)
        .send({})
        .expect(200);
      const retired = resent.body.data.devCode as string;
      const fresh = await a
        .post('/api/v1/auth/request-verification')
        .set('Origin', origin)
        .send({})
        .expect(200);
      if (retired !== fresh.body.data.devCode)
        assert.equal((await confirm(a, retired)).status, 400, 'A new code retires the old one');
      const freshWrong = fresh.body.data.devCode === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < 5; attempt++) await confirm(a, freshWrong).expect(400);
      assert.equal(
        (await confirm(a, fresh.body.data.devCode)).status,
        400,
        'Five wrong guesses use up a code',
      );
      assert.equal((await a.get('/api/v1/auth/me')).body.data.user.emailVerified, false);
      const verification = await a
        .post('/api/v1/auth/request-verification')
        .set('Origin', origin)
        .send({})
        .expect(200);
      const ownerToken = verification.body.data.devToken;
      assert.ok(ownerToken);
      const [storedToken] = await rows(
        'SELECT token_hash FROM identity_tokens WHERE token_hash=?',
        [hashToken(ownerToken)],
      );
      assert.equal(storedToken.token_hash.length, 64);
      assert.notEqual(storedToken.token_hash, ownerToken);
      await guest
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin)
        .send({ token: ownerToken, password: newPassword })
        .expect(400);
      await guest
        .post('/api/v1/auth/verify-email')
        .set('Origin', origin)
        .send({ token: ownerToken })
        .expect(200);
      await guest
        .post('/api/v1/auth/verify-email')
        .set('Origin', origin)
        .send({ token: ownerToken })
        .expect(400);
      assert.equal((await a.get('/api/v1/auth/me')).body.data.user.emailVerified, true);
      const expired = await guest
        .post('/api/v1/auth/forgot-password')
        .set('Origin', origin)
        .send({ email: `commerce-a-${suffix}@example.test` })
        .expect(200);
      await mutate(
        'UPDATE identity_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE token_hash=?',
        [hashToken(expired.body.data.devToken)],
      );
      await guest
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin)
        .send({ token: expired.body.data.devToken, password: newPassword })
        .expect(400);
      const reset = await guest
        .post('/api/v1/auth/forgot-password')
        .set('Origin', origin)
        .send({ email: `commerce-a-${suffix}@example.test` })
        .expect(200);
      await guest
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin)
        .send({ token: reset.body.data.devToken, password: newPassword })
        .expect(200);
      await a.get('/api/v1/auth/me').expect(401);
      await a
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ email: `commerce-a-${suffix}@example.test`, password: newPassword })
        .expect(200);
      await guest
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin)
        .send({ token: reset.body.data.devToken, password: newPassword })
        .expect(400);
      const unknown = await guest
        .post('/api/v1/auth/forgot-password')
        .set('Origin', origin)
        .send({ email: `unknown-${suffix}@example.test` })
        .expect(200);
      assert.deepEqual(unknown.body.data, { ok: true });

      // The quote link takes requests once the owner deploys it. Their own test chat works before.
      const startOn = (agent: typeof a, slugToTry: string) =>
        agent.post(`/api/v1/chat/${slugToTry}/start`).set('Origin', origin).send({});
      assert.equal((await startOn(guest, slug)).body.error?.code, 'NOT_TAKING_REQUESTS');
      assert.equal((await startOn(a, slug)).status, 201, 'The owner can always test');
      assert.equal((await guest.get(`/api/v1/chat/${slug}/viewer`)).body.data.owner, false);
      assert.equal((await a.get(`/api/v1/chat/${slug}/viewer`)).body.data.owner, true);
      assert.equal((await guest.get(`/api/v1/chat/${slug}`)).body.data.taking, false);
      // Free quotes are enough to deploy; so is a plan and a card, as below.
      const deployed = await a.post('/api/v1/app/deploy').set('Origin', origin).send({});
      assert.equal(deployed.status, 200, JSON.stringify(deployed.body));
      assert.equal(deployed.body.data.linkOn, true);
      assert.equal((await guest.get(`/api/v1/chat/${slug}`)).body.data.taking, true);

      // Customers' details are taken as they type them, with no code, and only on their own chat.
      const contact = await chatWithContact();
      assert.equal(contact.chat.contact.email, 'customer@example.test');
      assert.equal(contact.chat.status, 'chatting', 'Still describing the job');
      const otherSlug = String(other.body.data.business.slug);
      const elsewhere = await contact.call(
        '/contact',
        { name: 'Test Customer', email: 'customer@example.test' },
        `/api/v1/chat/${otherSlug}/${contact.id}`,
      );
      assert.equal(elsewhere.status, 404, 'A chat token only works on its own business');

      const payload = {
        to: 'customer@example.test',
        subject: 'Test delivery',
        text: 'A private one-time token 123456',
      };
      const encrypted = encryptEmail(payload);
      assert.ok(!encrypted.includes('123456'));
      assert.deepEqual(decryptEmail(encrypted), payload);
      const emailId = await queueEmail({
        ...payload,
        businessId,
        dedupeKey: `commerce-mail:${suffix}`,
      });
      assert.equal(
        await queueEmail({ ...payload, businessId, dedupeKey: `commerce-mail:${suffix}` }),
        emailId,
      );
      // Customers' replies reach the owner once the owner has confirmed their address.
      const replyTo = await ownerReplyTo(businessId);
      assert.equal(replyTo, `commerce-a-${suffix}@example.test`);
      const toOwner = await queueEmail({
        ...payload,
        replyTo,
        businessId,
        dedupeKey: `commerce-mail-reply:${suffix}`,
      });
      process.env.MAIL_PROVIDER = 'ses';
      process.env.SES_EMAIL_FROM = 'sender@example.test';
      process.env.AWS_REGION = 'us-east-1';
      const savedSupport = process.env.SUPPORT_EMAIL;
      process.env.SUPPORT_EMAIL = 'hello@example.test';
      const originalSend = SESv2Client.prototype.send;
      const replies: string[][] = [];
      (SESv2Client.prototype as any).send = async (command: any) => {
        replies.push(command.input.ReplyToAddresses);
        assert.equal(command.input.Destination.ToAddresses[0], payload.to);
        assert.equal(command.input.FromEmailAddress, '"PriceCharm" <sender@example.test>');
        return { MessageId: 'mock-ses-message' };
      };
      try {
        await deliverEmail(emailId);
        await deliverEmail(emailId);
        await deliverEmail(toOwner);
        assert.deepEqual(replies, [['hello@example.test'], [replyTo]]);
      } finally {
        SESv2Client.prototype.send = originalSend;
        process.env.MAIL_PROVIDER = 'local';
        if (savedSupport === undefined) delete process.env.SUPPORT_EMAIL;
        else process.env.SUPPORT_EMAIL = savedSupport;
      }

      // The first quotes are free; after that a plan and a card, and each plan charges its way.
      assert.equal(await canSend(), true);
      const first = randomUUID();
      assert.equal(await record(first), true);
      assert.equal(await record(first), false, 'A quote is billed once');
      await record(randomUUID());
      assert.equal((await liveBillingSummary(businessId)).trial.remainingQuotes, 0);
      assert.equal(await canSend(), false, 'No plan or card after the free quotes');
      const checkoutFirst = await a.post('/api/v1/billing/checkout').set('Origin', origin).send({});
      assert.equal(checkoutFirst.body.error?.code, 'PLAN_REQUIRED', 'A card is for a chosen plan');
      const choose = (agent: typeof a, plan: string) =>
        agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan });
      assert.equal((await choose(a, 'free')).status, 400);
      const shown = (await a.get('/api/v1/app/billing')).body.data.planOrder;
      assert.deepEqual([...shown].sort(), ['per_accepted', 'per_quote', 'subscription']);
      assert.deepEqual(
        (await a.get('/api/v1/app/billing')).body.data.planOrder,
        shown,
        'Each business keeps the order it was shown',
      );
      assert.equal((await choose(a, 'per_quote')).body.data.plan, 'per_quote');
      const checkout = await a
        .post('/api/v1/billing/checkout')
        .set('Origin', origin)
        .send({})
        .expect(200);
      assert.match(checkout.body.data.url, /\/app\/settings\?billing=active$/);
      await a
        .patch('/api/v1/billing')
        .set('Origin', origin)
        .send({ spendingCapCents: 200 })
        .expect(200);
      const paid = randomUUID();
      await record(paid);
      assert.equal((await liveBillingSummary(businessId)).usage.feesCents, 200);
      assert.equal(await canSend(), false, 'The monthly cap stops the next quote');
      const [fee] = await rows(
        "SELECT * FROM quote_usage WHERE quote_id=? AND charge='delivered'",
        [paid],
      );
      assert.equal(Number(fee.fee_cents), 200, '$2 for each quote a customer receives');
      assert.deepEqual([fee.tariff_version, fee.plan], ['per-quote-v1', 'per_quote']);
      await a
        .patch('/api/v1/billing')
        .set('Origin', origin)
        .send({ spendingCapCents: 100000 })
        .expect(200);
      const accept = (quoteId: string, totalCents: number) =>
        transaction(async (connection) =>
          recordAcceptance(connection, { businessId, quoteId, totalCents }),
        );
      assert.equal((await accept(paid, 10000)).recorded, false, 'Already paid for on delivery');

      // 1% when the customer accepts, at least $1 and at most $25, charged then and only once.
      assert.equal((await choose(a, 'per_accepted')).body.data.plan, 'per_accepted');
      const [small, usual, huge, unanswered, capped] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      for (const quoteId of [small, usual, huge, unanswered, capped]) await record(quoteId);
      const fees = async (quoteId: string) =>
        (
          await rows('SELECT charge,fee_cents FROM quote_usage WHERE quote_id=? ORDER BY charge', [
            quoteId,
          ])
        ).map((row) => [row.charge, Number(row.fee_cents)]);
      assert.deepEqual(await fees(usual), [['delivered', 0]], 'Nothing when it goes out');
      assert.deepEqual(await accept(usual, 32000), { recorded: true, feeCents: 320 });
      assert.deepEqual(await accept(usual, 32000), { recorded: false, feeCents: 0 });
      assert.equal((await accept(small, 5000)).feeCents, 100);
      // Past the spending limit, a yes still goes through but isn't charged.
      const cap = (cents: number) =>
        a
          .patch('/api/v1/billing')
          .set('Origin', origin)
          .send({ spendingCapCents: cents })
          .expect(200);
      await cap(600);
      assert.deepEqual(await accept(capped, 32000), { recorded: true, feeCents: 0 });
      await cap(100000);
      // Moving plans after it went out doesn't change how it's charged.
      assert.equal((await choose(a, 'per_quote')).body.data.plan, 'per_quote');
      assert.equal((await accept(huge, 400000)).feeCents, 2500);
      assert.deepEqual(await fees(unanswered), [['delivered', 0]]);

      // The subscription covers a set number of quotes a month, then $1 each.
      process.env.BILLING_INCLUDED_QUOTES = '2';
      assert.equal((await choose(a, 'monthly')).body.data.plan, 'monthly');
      const covered = [randomUUID(), randomUUID(), randomUUID()];
      for (const quoteId of covered) await record(quoteId);
      assert.deepEqual(
        (await Promise.all(covered.map(fees))).map((rowsFor) => rowsFor[0][1]),
        [0, 0, 100],
      );
      assert.equal((await liveBillingSummary(businessId)).coveredThisMonth, 3);
      delete process.env.BILLING_INCLUDED_QUOTES;

      // Off a paid subscription, mid-period, it switches now like any other switch.
      await mutate(
        'UPDATE billing_accounts SET period_end=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 DAY) WHERE business_id=?',
        [businessId],
      );
      assert.equal((await choose(a, 'per_quote')).body.data.plan, 'per_quote');
      const switched = (await a.get('/api/v1/app/billing')).body.data;
      assert.deepEqual([switched.plan, switched.nextPlan], ['per_quote', undefined]);
      const [{ choices }] = await rows(
        "SELECT COUNT(*) choices FROM usage_events WHERE business_id=? AND kind='plan_chosen'",
        [businessId],
      );
      assert.equal(Number(choices), 5, 'Every pick is recorded, for seeing what owners choose');

      // For 30 days after the first card, quote fees stop at the first-month max, and quotes past
      // it still go out. A $2 fee is charged whole or not at all; an accepted quote's fee is cut.
      const started = (await a.get('/api/v1/app/billing')).body.data.firstMonth;
      assert.ok(started.endsAt, 'The 30 days run from the card');
      process.env.BILLING_FIRST_MONTH_MAX_CENTS = String(started.feesCents + 300);
      const [underMax, pastMax, cutShort] = [randomUUID(), randomUUID(), randomUUID()];
      await record(underMax);
      await record(pastMax);
      assert.deepEqual(await fees(underMax), [['delivered', 200]]);
      assert.deepEqual(await fees(pastMax), [['delivered', 0]], 'Only $1 was left');
      assert.equal(await canSend(), true, 'Quotes past the max still go out');
      await choose(a, 'per_accepted');
      await record(cutShort);
      assert.deepEqual(await accept(cutShort, 32000), { recorded: true, feeCents: 100 });
      const ended = (await a.get('/api/v1/app/billing')).body.data.firstMonth;
      assert.deepEqual(
        [ended.feesCents - started.feesCents, ended.waivedCents - started.waivedCents],
        [300, 420],
        'What the max let off is kept with each fee',
      );
      await mutate(
        'UPDATE billing_accounts SET card_added_at=DATE_SUB(card_added_at,INTERVAL 30 DAY) WHERE business_id=?',
        [businessId],
      );
      assert.equal((await a.get('/api/v1/app/billing')).body.data.firstMonth, null);
      const afterMax = randomUUID();
      await record(afterMax);
      assert.equal((await accept(afterMax, 32000)).feeCents, 320, 'After 30 days, fees are back');
      delete process.env.BILLING_FIRST_MONTH_MAX_CENTS;
      await choose(a, 'per_quote');

      // From setup: the subscription's free week starts with the card, then they deploy.
      assert.deepEqual(
        (await b.get('/api/v1/app/billing').expect(200)).body.data.firstMonth,
        { endsAt: null, feesCents: 0, waivedCents: 0 },
        'The first-month max is ahead of them until a card',
      );
      await mutate('UPDATE billing_accounts SET trial_quote_limit=0 WHERE business_id=?', [
        other.body.data.business.id,
      ]);
      assert.equal(
        (await b.post('/api/v1/app/deploy').set('Origin', origin).send({})).body.error?.code,
        'NOT_READY_TO_DEPLOY',
        'Deploying needs a plan and a card',
      );
      await choose(b, 'yearly').expect(200);
      const fromSetup = await b
        .post('/api/v1/billing/checkout')
        .set('Origin', origin)
        .send({ from: 'setup' })
        .expect(200);
      assert.match(fromSetup.body.data.url, /\/start\/live\?billing=active$/, 'Back to setup');
      const synced = await b.post('/api/v1/app/billing/sync').set('Origin', origin).send({});
      assert.equal(synced.status, 200, JSON.stringify(synced.body));
      assert.equal(synced.body.data.canSend, true, 'Setup can deploy straight away');
      assert.deepEqual([synced.body.data.status, synced.body.data.freeWeek], ['trialing', false]);
      assert.equal(synced.body.data.linkOn, false, 'Not taking requests until they deploy');
      await b.post('/api/v1/app/deploy').set('Origin', origin).send({}).expect(200);
      const paused = await b.patch('/api/v1/app/link').set('Origin', origin).send({ on: false });
      assert.deepEqual([paused.body.data.linkOn, paused.body.data.deployed], [false, true]);
      await b.patch('/api/v1/app/link').set('Origin', origin).send({ on: true }).expect(200);

      process.env.BILLING_PROVIDER = 'stripe';
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_commerce';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_commerce';
      setStripePrices();
      await mutate(
        "UPDATE billing_accounts SET stripe_customer_id='cus_mock_commerce',subscription_status='active',last_reconciled_at=UTC_TIMESTAMP(3) WHERE business_id=?",
        [businessId],
      );
      const stripe = stripeClient();
      // A delivered quote counts one on the meter; the subscription's price makes it $2 or $1.
      let meterCalls = 0;
      stripe.billing.meterEvents.create = (async (params: any, options: any) => {
        meterCalls++;
        assert.equal(params.event_name, 'pricecharm_quotes');
        assert.equal(params.identifier, `quotient:${fee.id}`);
        assert.equal(params.payload.value, '1');
        assert.equal(options.idempotencyKey, `quotient-meter:${fee.id}`);
        return { identifier: params.identifier };
      }) as any;
      await dispatchFee(fee.id);
      await dispatchFee(fee.id);
      assert.equal(meterCalls, 1);
      // An accepted quote's fee is a line of its own on the next invoice.
      const [acceptedFee] = await rows(
        "SELECT id FROM quote_usage WHERE quote_id=? AND charge='accepted'",
        [usual],
      );
      const invoiceLines: any[] = [];
      stripe.invoiceItems.create = (async (params: any, options: any) => {
        invoiceLines.push({ ...params, key: options.idempotencyKey });
        return { id: 'ii_mock' };
      }) as any;
      await dispatchFee(acceptedFee.id);
      await dispatchFee(acceptedFee.id);
      assert.deepEqual(invoiceLines, [
        {
          customer: 'cus_mock_commerce',
          amount: 320,
          currency: 'usd',
          description: 'Accepted quote for $320.00',
          metadata: { usageId: acceptedFee.id, quoteId: usual },
          key: `quotient-fee:${acceptedFee.id}`,
        },
      ]);
      const [cutFee] = await rows(
        "SELECT id FROM quote_usage WHERE quote_id=? AND charge='accepted'",
        [cutShort],
      );
      await dispatchFee(cutFee.id);
      assert.deepEqual(
        [invoiceLines[1].amount, invoiceLines[1].description],
        [100, 'Accepted quote for $320.00, up to your first-month max'],
      );
      assert.equal(meterCalls, 1, 'Accepted fees never go on the meter');
      stripe.subscriptions.list = (async () => ({
        data: [
          {
            id: 'sub_mock',
            status: 'active',
            created: 100,
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  price: { id: 'price_per_quote_mock' },
                  current_period_end: Math.floor(Date.now() / 1000) + 86400,
                },
              ],
            },
          },
        ],
      })) as any;
      await reconcileStripeCustomer('cus_mock_commerce');
      const event = {
        id: `evt_${suffix}`,
        type: 'customer.subscription.deleted',
        object: 'event',
        created: 1,
        data: { object: { customer: 'cus_mock_commerce' } },
      };
      const raw = JSON.stringify(event),
        signature = stripe.webhooks.generateTestHeaderString({
          payload: raw,
          secret: process.env.STRIPE_WEBHOOK_SECRET,
        });
      await guest
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'invalid')
        .send(raw)
        .expect(400);
      await guest
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(raw)
        .expect(200);
      await guest
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(raw)
        .expect(200);
      const [eventCount] = await rows('SELECT COUNT(*) count FROM stripe_events WHERE id=?', [
        event.id,
      ]);
      assert.equal(Number(eventCount.count), 1);
      const [reconciled] = await rows(
        'SELECT subscription_status FROM billing_accounts WHERE business_id=?',
        [businessId],
      );
      assert.equal(
        reconciled.subscription_status,
        'active',
        'stale deletion event never overrides current provider state',
      );
      process.env.BILLING_PROVIDER = 'local';

      const exported = await a.get('/api/v1/account/export').expect(200);
      assert.equal(exported.body.data.business.id, businessId);
      assert.ok(!JSON.stringify(exported.body.data).includes('password_hash'));
      assert.ok(!JSON.stringify(exported.body.data).includes(businesses[1]));
      const photoKey = `${randomUUID()}.jpg`;
      await putPhoto(photoKey, Buffer.from('private cleanup fixture'));
      await mutate(
        "INSERT INTO attachments(id,business_id,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,'fixture.jpg','image/jpeg',?,1,1,23)",
        [randomUUID(), businessId, photoKey],
      );
      await a
        .delete('/api/v1/account')
        .set('Origin', origin)
        .send({ password: 'wrong', confirmation: 'Commerce Test A' })
        .expect(401);
      await a
        .delete('/api/v1/account')
        .set('Origin', origin)
        .send({ password: newPassword, confirmation: 'wrong' })
        .expect(422);
      await a
        .delete('/api/v1/account')
        .set('Origin', origin)
        .send({ password: newPassword, confirmation: 'Commerce Test A' })
        .expect(200);
      await a.get('/api/v1/auth/me').expect(401);
      const [deletion] = await rows('SELECT id FROM account_deletion_audits WHERE business_id=?', [
        businessId,
      ]);
      await deleteBusinessAccount(businessId, deletion.id);
      assert.equal((await rows('SELECT id FROM businesses WHERE id=?', [businessId])).length, 0);
      assert.equal((await rows('SELECT id FROM businesses WHERE id=?', [businesses[1]])).length, 1);
      await assert.rejects(getPhoto(photoKey));
      assert.equal(
        (await rows('SELECT status FROM account_deletion_audits WHERE id=?', [deletion.id]))[0]
          .status,
        'completed',
      );
      await deleteBusinessAccount(businessId, deletion.id);
    } finally {
      process.env.MAIL_PROVIDER = 'local';
      process.env.BILLING_PROVIDER = 'local';
      clearStripePrices();
      for (const id of businesses) {
        if (!(await rows('SELECT id FROM businesses WHERE id=?', [id])).length) continue;
        const deletionId = randomUUID();
        await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [
          id,
        ]);
        await mutate(
          "INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,'scheduled')",
          [deletionId, id],
        );
        await deleteBusinessAccount(id, deletionId);
      }
      await closeDatabase();
    }
  },
);

test(
  'Stripe Checkout and Portal use server prices for the chosen plan, trusted URLs, booked switches and current-state reconciliation',
  { skip: !enabled },
  async () => {
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_checkout';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_checkout';
    setStripePrices();
    process.env.TRUST_PROXY = '1';
    const app = createApp(),
      agent = request.agent(app),
      origin = 'http://localhost:3100',
      suffix = randomUUID();
    const guest = request
      .agent(app)
      .set('X-Forwarded-For', `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(9, 13)}::1`);
    let businessId = '';
    try {
      const created = await agent
        .post('/api/v1/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Checkout test',
          businessName: 'Checkout test',
          email: `checkout-${suffix}@example.test`,
          password: 'checkout test password123',
        })
        .expect(201);
      businessId = created.body.data.business.id;
      assert.equal(
        (await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({})).body.error
          ?.code,
        'PLAN_REQUIRED',
        'A card is added for a plan, with or without a confirmed email',
      );
      await agent
        .post('/api/v1/app/billing/plan')
        .set('Origin', origin)
        .send({ plan: 'monthly' })
        .expect(200);
      const stripe = stripeClient();
      let customers = 0,
        checkouts = 0,
        portals = 0;
      const price = (unit_amount: number, recurring: object) => ({
        active: true,
        currency: 'usd',
        unit_amount,
        recurring,
      });
      const perQuote = (cents: number) =>
        price(cents, { usage_type: 'metered', interval: 'month', meter: 'meter_quotes' });
      const prices: Record<string, unknown> = {
        price_per_quote_mock: perQuote(200),
        // Two $0 tiers, so Checkout says "Price varies" instead of "$0.00 per unit".
        price_per_accepted_mock: {
          ...perQuote(0),
          unit_amount: null,
          billing_scheme: 'tiered',
          tiers: [
            { up_to: 1, unit_amount: 0, flat_amount: null },
            { up_to: null, unit_amount: 0, flat_amount: null },
          ],
        },
        price_extra_quotes_mock: perQuote(100),
        price_monthly_mock: price(4900, { usage_type: 'licensed', interval: 'month' }),
        price_yearly_mock: price(49900, { usage_type: 'licensed', interval: 'year' }),
      };
      stripe.prices.retrieve = (async (id: string) => prices[id]) as any;
      stripe.billing.meters.retrieve = (async () => ({
        event_name: 'pricecharm_quotes',
        default_aggregation: { formula: 'sum' },
      })) as any;
      stripe.customers.create = (async (params: any, options: any) => {
        customers++;
        assert.equal(params.metadata.businessId, businessId);
        assert.equal(options.idempotencyKey, `quotient-customer:${businessId}`);
        return { id: `cus_${suffix}` };
      }) as any;
      // Stripe as a small stand-in: the customer's cards and subscriptions, changed by the calls.
      let card: { id: string; created: number } | null = null;
      let subscriptions: any[] = [];
      const defaults: string[] = [],
        starts: any[] = [],
        moves: any[] = [];
      stripe.customers.retrieve = (async (id: string, params: any) => {
        assert.deepEqual(
          [id, params],
          [`cus_${suffix}`, { expand: ['invoice_settings.default_payment_method'] }],
        );
        return { id, invoice_settings: { default_payment_method: card } };
      }) as any;
      stripe.customers.listPaymentMethods = (async () => ({ data: [] })) as any;
      stripe.customers.update = (async (_id: string, params: any) => {
        defaults.push(params.invoice_settings.default_payment_method);
        return {};
      }) as any;
      stripe.subscriptions.list = (async () => ({ data: subscriptions })) as any;
      let started = 0;
      const now = Math.floor(Date.now() / 1000),
        monthEnd = now + 20 * 86400,
        yearEnd = now + 300 * 86400;
      const item = (priceId: string) => ({
        id: `si_${priceId}`,
        price: { id: priceId },
        current_period_end: priceId === 'price_yearly_mock' ? yearEnd : monthEnd,
      });
      stripe.subscriptions.create = (async (params: any, options: any) => {
        starts.push({ params, key: options.idempotencyKey });
        // Each start takes a moment, so two at once would both get through without the lock.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const subscription = {
          id: `sub_${suffix}_${++started}`,
          status: params.trial_period_days ? 'trialing' : 'active',
          created: 600 + started,
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
        return subscription;
      }) as any;
      const sessions: Record<string, any> = {};
      let checkoutSession: any = {
        status: 'open',
        mode: 'setup',
        url: 'https://checkout.stripe.com/mock-only',
        metadata: { plan: 'monthly' },
      };
      stripe.checkout.sessions.create = (async (params: any) => {
        checkouts++;
        sessions[params.metadata.plan] = params;
        assert.deepEqual(params.allowed_payment_method_types, ['card', 'link', 'us_bank_account']);
        assert.match(params.success_url, /^http:\/\/localhost:3100\/app\/settings/);
        return {
          id: `cs_${suffix}_${params.metadata.plan}`,
          url: 'https://checkout.stripe.com/mock-only',
        };
      }) as any;
      stripe.checkout.sessions.retrieve = (async (id: string) => ({
        id,
        ...checkoutSession,
      })) as any;
      stripe.billingPortal.sessions.create = (async (params: any) => {
        portals++;
        assert.equal(params.customer, `cus_${suffix}`);
        assert.equal(params.return_url, 'http://localhost:3100/app/settings?billing=portal');
        return { url: 'https://billing.stripe.com/mock-only' };
      }) as any;
      await agent
        .post('/api/v1/billing/checkout')
        .set('Origin', origin)
        .send({ price: 'attacker-price', returnUrl: 'https://attacker.example' })
        .expect(400);
      assert.equal(
        (await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200))
          .body.data.url,
        'https://checkout.stripe.com/mock-only',
      );
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.equal(customers, 1);
      assert.equal(checkouts, 1, 'An open checkout for the same plan is reused');
      // Checkout only saves the card, and says above its button what the plan costs.
      assert.equal(sessions.monthly.mode, 'setup');
      assert.equal(sessions.monthly.currency, 'usd');
      assert.equal(sessions.monthly.line_items, undefined);
      assert.equal(sessions.monthly.subscription_data, undefined);
      assert.equal(
        sessions.monthly.custom_text.submit.message,
        '$49 a month after your free week, which starts today. Includes 100 quotes a month. Each one past that is $1, billed monthly. In your first 30 days, quote fees stop at $49.',
      );
      const pick = (plan: string) =>
        agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
      await pick('yearly');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.match(
        sessions.yearly.custom_text.submit.message,
        /^\$499 a year after your free week/,
      );
      // $2 a quote, with nothing up front. Trying plan after plan isn't stopped as abuse.
      await pick('per_quote');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.equal(
        sessions.per_quote.custom_text.submit.message,
        '$2 for each quote shown to a customer, billed monthly. Nothing today. In your first 30 days, quote fees stop at $49.',
      );
      await pick('per_accepted');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.equal(
        sessions.per_accepted.custom_text.submit.message,
        'Nothing today. Each month, your card is billed 1% of the quotes customers accepted, at least $1 and at most $25 each. No accepted quotes, no bill. In your first 30 days, quote fees stop at $49.',
      );
      await pick('monthly');
      assert.equal(starts.length, 0, 'Picking plans without a card starts nothing');
      assert.equal(
        (await agent.post('/api/v1/billing/portal').set('Origin', origin).send({}).expect(200)).body
          .data.url,
        'https://billing.stripe.com/mock-only',
      );
      assert.equal(portals, 1);

      // A card saved in Checkout becomes the default, and the plan starts on it, with its free
      // week. Stripe's webhook and the owner coming back can land together: one subscription.
      checkoutSession = {
        status: 'complete',
        mode: 'setup',
        metadata: { plan: 'monthly' },
        setup_intent: { payment_method: 'pm_checkout' },
      };
      card = { id: 'pm_checkout', created: 500 };
      const [back] = await Promise.all([
        agent.post('/api/v1/app/billing/sync').set('Origin', origin).send({}).expect(200),
        reconcileStripeCustomer(`cus_${suffix}`),
      ]);
      assert.deepEqual(defaults.slice(0, 1), ['pm_checkout']);
      assert.equal(starts.length, 1, 'One subscription, however many times it runs');
      const [{ checkout_session_id: cleared, plan_chosen_at: pickedAt }] = await rows(
        'SELECT checkout_session_id,plan_chosen_at FROM billing_accounts WHERE business_id=?',
        [businessId],
      );
      assert.equal(cleared, null);
      assert.deepEqual(starts[0], {
        params: {
          customer: `cus_${suffix}`,
          items: [
            { price: 'price_monthly_mock', quantity: 1 },
            { price: 'price_extra_quotes_mock' },
          ],
          billing_mode: { type: 'flexible' },
          metadata: { businessId, plan: 'monthly' },
          trial_period_days: 7,
        },
        key: `quotient-plan:${businessId}:monthly:${Math.floor(new Date(pickedAt).getTime() / 1000)}:pm_checkout`,
      });
      assert.deepEqual(
        [back.body.data.status, back.body.data.freeWeek, back.body.data.checkoutAvailable],
        ['trialing', false, false],
      );
      const [paid] = await rows(
        'SELECT period_end,card_added_at FROM billing_accounts WHERE business_id=?',
        [businessId],
      );
      assert.equal(Math.floor(new Date(paid.period_end).getTime() / 1000), monthEnd);
      assert.equal(
        new Date(paid.card_added_at).getTime(),
        601000,
        'The first card is when the first subscription started',
      );
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual(
        [starts.length, moves.length],
        [1, 0],
        'Once it’s on the plan, nothing more',
      );

      // Switching takes effect now, any way round, with Stripe crediting what's left. The quote
      // price is swapped on its item, never removed, so earlier quotes keep their price.
      const choose = async (plan: string) => {
        const saved = (await pick(plan)).body.data;
        assert.equal(saved.plan, plan);
        return moves.at(-1);
      };
      assert.deepEqual(await choose('yearly'), {
        items: [{ id: 'si_price_monthly_mock', price: 'price_yearly_mock' }],
        proration_behavior: 'create_prorations',
      });
      const [onYearly] = await rows('SELECT period_end FROM billing_accounts WHERE business_id=?', [
        businessId,
      ]);
      assert.equal(
        Math.floor(new Date(onYearly.period_end).getTime() / 1000),
        yearEnd,
        'The paid period is the year, not the quote price’s month',
      );
      // The free week is the subscription's, and Stripe bills no quotes in a trial, so it ends.
      assert.deepEqual(await choose('per_accepted'), {
        items: [
          { id: 'si_price_yearly_mock', deleted: true },
          { id: 'si_price_extra_quotes_mock', price: 'price_per_accepted_mock' },
        ],
        proration_behavior: 'create_prorations',
        trial_end: 'now',
      });
      assert.deepEqual(await choose('per_quote'), {
        items: [{ id: 'si_price_per_accepted_mock', price: 'price_per_quote_mock' }],
        proration_behavior: 'create_prorations',
      });
      assert.deepEqual(await choose('monthly'), {
        items: [
          { price: 'price_monthly_mock', quantity: 1 },
          { id: 'si_price_per_quote_mock', price: 'price_extra_quotes_mock' },
        ],
        proration_behavior: 'create_prorations',
      });
      const movesSoFar = moves.length;
      await pick('monthly');
      assert.equal(moves.length, movesSoFar, 'Picking the plan they’re on changes nothing');
      assert.equal(
        (await agent.get('/api/v1/app/billing')).body.data.nextPlan,
        undefined,
        'Nothing is booked for later',
      );

      // A plan they cancel stays stopped until they save a newer card or pick a plan again.
      const status = async () =>
        (
          await rows('SELECT subscription_status FROM billing_accounts WHERE business_id=?', [
            businessId,
          ])
        )[0].subscription_status;
      const cancel = (at: number) => {
        subscriptions = subscriptions.map((entry) =>
          entry.ended_at ? entry : { ...entry, status: 'canceled', ended_at: at },
        );
      };
      // Their last pick was an hour ago; they cancelled after it.
      await mutate(
        'UPDATE billing_accounts SET plan_chosen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE business_id=?',
        [businessId],
      );
      cancel(now - 600);
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual([starts.length, await status()], [1, 'canceled']);
      card = { id: 'pm_newer', created: now - 500 };
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual([starts.length, await status()], [2, 'active']);
      assert.equal(starts[1].params.trial_period_days, undefined, 'The free week is used');
      assert.match(starts[1].key, /:pm_newer$/);
      cancel(now - 400);
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual([starts.length, await status()], [2, 'canceled']);
      // Picking a plan again starts it on the card they have. Yearly carries the monthly quote
      // price on the same subscription.
      await pick('yearly');
      assert.deepEqual(
        [starts.length, starts[2].params.items, await status()],
        [
          3,
          [{ price: 'price_yearly_mock', quantity: 1 }, { price: 'price_extra_quotes_mock' }],
          'active',
        ],
      );

      // A card changed in the portal comes as a customer event, whose object is the customer.
      const cardEvent = {
        id: `evt_card_${suffix}`,
        type: 'customer.updated',
        data: { object: { object: 'customer', id: `cus_${suffix}` } },
      };
      const cardRaw = JSON.stringify(cardEvent);
      await guest
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .set(
          'stripe-signature',
          stripe.webhooks.generateTestHeaderString({
            payload: cardRaw,
            secret: process.env.STRIPE_WEBHOOK_SECRET,
          }),
        )
        .send(cardRaw)
        .expect(200);
      const [cardJob] = await rows('SELECT payload_json FROM jobs WHERE dedupe_key=?', [
        `stripe-event:${cardEvent.id}`,
      ]);
      assert.equal(
        json<{ customerId: string }>(cardJob.payload_json, { customerId: '' }).customerId,
        `cus_${suffix}`,
      );

      await mutate(
        "UPDATE billing_accounts SET plan='yearly',checkout_session_id=NULL WHERE business_id=?",
        [businessId],
      );

      const eventId = `evt_${suffix}`,
        event = {
          id: eventId,
          type: 'invoice.payment_failed',
          data: { object: { customer: `cus_${suffix}` } },
        };
      const raw = JSON.stringify(event),
        signature = stripe.webhooks.generateTestHeaderString({
          payload: raw,
          secret: process.env.STRIPE_WEBHOOK_SECRET,
        });
      await guest
        .post('/api/v1/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(raw)
        .expect(200);
      stripe.subscriptions.list = (async () => ({
        data: [
          {
            id: `sub_${suffix}`,
            status: 'past_due',
            created: 100,
            cancel_at_period_end: false,
            items: { data: [item('price_yearly_mock'), item('price_extra_quotes_mock')] },
          },
        ],
      })) as any;
      const [job] = await rows('SELECT id FROM jobs WHERE dedupe_key=?', [
        `stripe-event:${eventId}`,
      ]);
      assert.equal(await runOneJob(job.id), true);
      assert.equal(await runOneJob(job.id), false);
      assert.equal(
        (await rows('SELECT status FROM stripe_events WHERE id=?', [eventId]))[0].status,
        'processed',
      );
      assert.equal(
        (
          await rows('SELECT subscription_status FROM billing_accounts WHERE business_id=?', [
            businessId,
          ])
        )[0].subscription_status,
        'past_due',
      );
      await mutate('UPDATE billing_accounts SET trial_quote_limit=0 WHERE business_id=?', [
        businessId,
      ]);
      assert.equal(
        await transaction(
          async (connection) => (await liveBillingAccess(businessId, connection, 10000)).canSend,
        ),
        false,
        'A past-due subscription stops quotes once the free ones are used',
      );
      // A Stripe price that doesn't match the pricing page fails closed.
      stripe.prices.retrieve = (async (id: string) =>
        id === 'price_yearly_mock'
          ? price(4900, { usage_type: 'licensed', interval: 'year' })
          : prices[id]) as any;
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(503);
    } finally {
      process.env.BILLING_PROVIDER = 'local';
      clearStripePrices();
      if (businessId) {
        const id = randomUUID();
        await mutate('UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [
          businessId,
        ]);
        await mutate(
          "INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,'scheduled')",
          [id, businessId],
        );
        await deleteBusinessAccount(businessId, id);
      }
      await closeDatabase();
    }
  },
);

test(
  'worker claims are exclusive and uncertain SES sends are never blindly repeated',
  { skip: !enabled },
  async () => {
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'local';
    const id = await queueEmail({
      to: 'worker@example.test',
      subject: 'Worker test',
      text: 'Only one worker may send this.',
      dedupeKey: `worker-test:${randomUUID()}`,
    });
    const [job] = await rows('SELECT id FROM jobs WHERE dedupe_key=?', [`mail:${id}`]);
    const claimed = await Promise.all([runOneJob(job.id), runOneJob(job.id)]);
    assert.deepEqual(claimed.sort(), [false, true]);
    assert.equal(
      (await rows('SELECT status FROM jobs WHERE id=?', [job.id]))[0].status,
      'completed',
    );
    const uncertain = await queueEmail({
      to: 'worker@example.test',
      subject: 'Unknown provider outcome',
      text: 'Do not duplicate.',
      dedupeKey: `unknown-mail:${randomUUID()}`,
    });
    process.env.MAIL_PROVIDER = 'ses';
    process.env.SES_EMAIL_FROM = 'sender@example.test';
    process.env.AWS_REGION = 'us-east-1';
    const original = SESv2Client.prototype.send;
    let attempts = 0;
    (SESv2Client.prototype as any).send = async () => {
      attempts++;
      throw new Error('Ambiguous network interruption');
    };
    try {
      await assert.rejects(deliverEmail(uncertain), /failed/);
      await assert.rejects(deliverEmail(uncertain), /uncertain/);
      assert.equal(attempts, 1);
      assert.equal(
        (await rows('SELECT status FROM email_outbox WHERE id=?', [uncertain]))[0].status,
        'uncertain',
      );
    } finally {
      SESv2Client.prototype.send = original;
      process.env.MAIL_PROVIDER = 'local';
      await mutate('DELETE FROM jobs WHERE dedupe_key IN (?,?)', [
        `mail:${id}`,
        `mail:${uncertain}`,
      ]);
      await mutate('DELETE FROM email_outbox WHERE id IN (?,?)', [id, uncertain]);
      await closeDatabase();
    }
  },
);
