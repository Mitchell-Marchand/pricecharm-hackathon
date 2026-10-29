import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';
import { hashToken } from '../src/auth.js';
import {
  applyDuePlanChanges,
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
    /** A customer chat on business A's quote link, asking for a code at this email. */
    async function chatWithCode(email = 'Customer@Example.Test') {
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
      return {
        id: String(started.body.data.chat.id),
        call,
        verificationId: String(contact.body.data.verificationId),
        devCode: String(contact.body.data.devCode),
      };
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

      // Customer email codes: one at a time, for this chat only, five tries, ten minutes.
      const contact = await chatWithCode();
      assert.match(contact.devCode, /^\d{6}$/);
      const again = await contact.call('/contact', {
        name: 'Test Customer',
        email: 'customer@example.test',
      });
      assert.equal(again.body.error.code, 'CODE_RATE_LIMIT');
      const otherSlug = String(other.body.data.business.slug);
      const elsewhere = await contact.call(
        '/verify',
        { verificationId: contact.verificationId, code: contact.devCode },
        `/api/v1/chat/${otherSlug}/${contact.id}`,
      );
      assert.equal(elsewhere.status, 404, 'A chat token only works on its own business');
      const wrong = await contact.call('/verify', {
        verificationId: contact.verificationId,
        code: contact.devCode === '000000' ? '111111' : '000000',
      });
      assert.equal(wrong.body.error.code, 'CODE_INVALID');
      const verified = await contact.call('/verify', {
        verificationId: contact.verificationId,
        code: contact.devCode,
      });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.data.contact.email, 'customer@example.test');
      assert.equal(verified.body.data.contact.verified, true);
      const reused = await contact.call('/verify', {
        verificationId: contact.verificationId,
        code: contact.devCode,
      });
      assert.equal(reused.status, 400, 'A code works once');
      const exhausted = await chatWithCode('other@example.test');
      for (let i = 0; i < 5; i++)
        await exhausted.call('/verify', {
          verificationId: exhausted.verificationId,
          code: exhausted.devCode === '000000' ? '111111' : '000000',
        });
      const tooLate = await exhausted.call('/verify', {
        verificationId: exhausted.verificationId,
        code: exhausted.devCode,
      });
      assert.equal(tooLate.status, 400, 'Five wrong tries use the code up');
      const stale = await chatWithCode('stale@example.test');
      await mutate(
        'UPDATE contact_verifications SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [stale.verificationId],
      );
      const expiredCode = await stale.call('/verify', {
        verificationId: stale.verificationId,
        code: stale.devCode,
      });
      assert.equal(expiredCode.status, 400, 'Codes expire');

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
      const [small, usual, huge, unanswered] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      for (const quoteId of [small, usual, huge, unanswered]) await record(quoteId);
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

      // Off a paid subscription waits for the end of the period; changing back undoes it.
      await mutate(
        'UPDATE billing_accounts SET period_end=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 DAY) WHERE business_id=?',
        [businessId],
      );
      const booked = (await choose(a, 'per_quote')).body.data;
      assert.deepEqual([booked.plan, booked.nextPlan], ['monthly', 'per_quote']);
      const undone = (await choose(a, 'monthly')).body.data;
      assert.deepEqual([undone.plan, undone.nextPlan], ['monthly', null]);
      await choose(a, 'per_quote');
      await mutate(
        'UPDATE billing_accounts SET period_end=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE business_id=?',
        [businessId],
      );
      await applyDuePlanChanges();
      const switched = (await a.get('/api/v1/app/billing')).body.data;
      assert.deepEqual([switched.plan, switched.nextPlan], ['per_quote', null]);
      const [{ choices }] = await rows(
        "SELECT COUNT(*) choices FROM usage_events WHERE business_id=? AND kind='plan_chosen'",
        [businessId],
      );
      assert.equal(Number(choices), 5, 'Every pick is recorded, for seeing what owners choose');

      // From setup: the subscription's free week starts with the card, then they deploy.
      await b.get('/api/v1/app/billing').expect(200);
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
        price_per_accepted_mock: perQuote(0),
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
      stripe.subscriptions.list = (async () => ({ data: [] })) as any;
      const sessions: Record<string, any> = {};
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
      stripe.checkout.sessions.retrieve = (async () => ({
        status: 'open',
        url: 'https://checkout.stripe.com/mock-only',
        metadata: { plan: 'monthly' },
      })) as any;
      stripe.billingPortal.sessions.create = (async (params: any) => {
        portals++;
        assert.equal(params.customer, `cus_${suffix}`);
        assert.equal(params.return_url, 'http://localhost:3100/app/settings');
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
      assert.equal(checkouts, 1);
      // Checkout shows the plan's own prices: $49 a month with its free week, and $1 a quote past
      // the allowance.
      assert.equal(sessions.monthly.mode, 'subscription');
      assert.deepEqual(sessions.monthly.line_items, [
        { price: 'price_monthly_mock', quantity: 1 },
        { price: 'price_extra_quotes_mock' },
      ]);
      assert.equal(sessions.monthly.subscription_data.trial_period_days, 7, 'The free week');
      assert.deepEqual(sessions.monthly.subscription_data.billing_mode, { type: 'flexible' });
      assert.equal(
        sessions.monthly.custom_text.submit.message,
        'Includes 100 quotes a month. Each one past that is $1, billed monthly.',
      );
      // Checkout can't mix a yearly price with the monthly quote price, so yearly starts alone.
      const pick = (plan: string) =>
        agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan }).expect(200);
      await pick('yearly');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.deepEqual(sessions.yearly.line_items, [{ price: 'price_yearly_mock', quantity: 1 }]);
      // $2 a quote, with nothing up front.
      await mutate('DELETE FROM auth_rate_limits WHERE bucket_key=?', [
        hashToken(`billing-checkout:${businessId}`),
      ]);
      await pick('per_quote');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.equal(sessions.per_quote.mode, 'subscription');
      assert.deepEqual(sessions.per_quote.line_items, [{ price: 'price_per_quote_mock' }]);
      assert.equal(sessions.per_quote.subscription_data.trial_period_days, undefined);
      // Stripe can't show 1% of a job as a price, so that plan's Checkout only saves the card,
      // under the plan's terms in our words.
      await pick('per_accepted');
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(200);
      assert.deepEqual(
        [sessions.per_accepted.mode, sessions.per_accepted.currency],
        ['setup', 'usd'],
      );
      assert.equal(sessions.per_accepted.line_items, undefined);
      assert.equal(
        sessions.per_accepted.custom_text.submit.message,
        '1% of each quote a customer accepts, at least $1 and at most $25, billed monthly. Nothing if they say no, and nothing today.',
      );
      await pick('monthly');
      assert.equal(
        (await agent.post('/api/v1/billing/portal').set('Origin', origin).send({}).expect(200)).body
          .data.url,
        'https://billing.stripe.com/mock-only',
      );
      assert.equal(portals, 1);

      // Switching a paying subscription: up to yearly now, off it at the end of the period.
      await mutate(
        "UPDATE billing_accounts SET stripe_subscription_id=?,subscription_status='active',period_end=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 20 DAY),trial_used_at=UTC_TIMESTAMP(3),last_reconciled_at=UTC_TIMESTAMP(3) WHERE business_id=?",
        [`sub_${suffix}`, businessId],
      );
      const updates: any[] = [];
      stripe.subscriptions.retrieve = (async () => ({
        id: `sub_${suffix}`,
        items: {
          data: [
            { id: 'si_fixed', price: { id: 'price_monthly_mock' } },
            { id: 'si_usage', price: { id: 'price_extra_quotes_mock' } },
          ],
        },
      })) as any;
      stripe.subscriptions.update = (async (_id: string, params: any) => {
        updates.push(params);
        return {};
      }) as any;
      const choose = (plan: string) =>
        agent.post('/api/v1/app/billing/plan').set('Origin', origin).send({ plan });
      assert.equal((await choose('yearly')).body.data.plan, 'yearly');
      assert.deepEqual(updates, [
        {
          items: [{ id: 'si_fixed', price: 'price_yearly_mock' }],
          proration_behavior: 'create_prorations',
        },
      ]);
      const scheduled: any[] = [];
      let released = '';
      stripe.subscriptionSchedules.create = (async () => ({
        id: 'sub_sched_mock',
        phases: [
          {
            items: [
              { price: 'price_yearly_mock', quantity: 1 },
              { price: 'price_extra_quotes_mock' },
            ],
            start_date: 1,
            end_date: 2,
          },
        ],
      })) as any;
      stripe.subscriptionSchedules.update = (async (_id: string, params: any) => {
        scheduled.push(params);
        return {};
      }) as any;
      stripe.subscriptionSchedules.release = (async (id: string) => {
        released = id;
        return {};
      }) as any;
      // On yearly the usage price still bills monthly. The switch waits for the year, not its month.
      const now = Math.floor(Date.now() / 1000),
        monthEnd = now + 20 * 86400,
        yearEnd = now + 300 * 86400;
      const usageItem = {
          id: 'si_usage',
          price: { id: 'price_extra_quotes_mock' },
          current_period_end: monthEnd,
        },
        yearlyItem = {
          id: 'si_fixed',
          price: { id: 'price_yearly_mock' },
          current_period_end: yearEnd,
        };
      stripe.subscriptions.retrieve = (async () => ({
        id: `sub_${suffix}`,
        items: { data: [usageItem, yearlyItem] },
      })) as any;
      const booked = (await choose('per_accepted')).body.data;
      assert.deepEqual([booked.plan, booked.nextPlan], ['yearly', 'per_accepted']);
      assert.equal(scheduled[0].phases[0].end_date, yearEnd);
      assert.deepEqual(scheduled[0].phases[1].items, [{ price: 'price_per_accepted_mock' }]);
      assert.equal(scheduled[0].phases[1].proration_behavior, 'none');
      assert.equal(updates.length, 1, 'Nothing changes on the subscription until then');
      const kept = (await choose('yearly')).body.data;
      assert.deepEqual([kept.plan, kept.nextPlan, released], ['yearly', null, 'sub_sched_mock']);

      // Between the per-quote plans the quote meter's price is swapped, never removed, so quotes
      // from before the switch are still billed at the price they went out at.
      stripe.subscriptions.retrieve = (async () => ({
        id: `sub_${suffix}`,
        items: { data: [{ id: 'si_usage', price: { id: 'price_per_quote_mock' } }] },
      })) as any;
      const fromPerQuote = async (plan: string) => {
        await mutate("UPDATE billing_accounts SET plan='per_quote' WHERE business_id=?", [
          businessId,
        ]);
        assert.equal((await choose(plan)).body.data.plan, plan);
        return updates.at(-1);
      };
      assert.deepEqual(await fromPerQuote('per_accepted'), {
        items: [{ id: 'si_usage', price: 'price_per_accepted_mock' }],
        proration_behavior: 'create_prorations',
      });
      assert.deepEqual(await fromPerQuote('monthly'), {
        items: [
          { price: 'price_monthly_mock', quantity: 1 },
          { id: 'si_usage', price: 'price_extra_quotes_mock' },
        ],
        proration_behavior: 'create_prorations',
      });
      await mutate("UPDATE billing_accounts SET plan='yearly' WHERE business_id=?", [businessId]);

      // A yearly checkout leaves the subscription with its own price alone. Reconciling adds the
      // usage price once, and the paid period it saves is the year.
      const added: any[] = [];
      stripe.subscriptions.update = (async (id: string, params: any, options: any) => {
        added.push({ id, params, key: options?.idempotencyKey });
        return {};
      }) as any;
      const subscriptionWith = (items: unknown[]) =>
        (async () => ({
          data: [
            {
              id: `sub_${suffix}`,
              status: 'trialing',
              created: 100,
              cancel_at_period_end: false,
              items: { data: items },
            },
          ],
        })) as any;
      stripe.subscriptions.list = subscriptionWith([yearlyItem]);
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual(added, [
        {
          id: `sub_${suffix}`,
          params: { items: [{ price: 'price_extra_quotes_mock' }], proration_behavior: 'none' },
          key: `quotient-usage-price:sub_${suffix}`,
        },
      ]);
      stripe.subscriptions.list = subscriptionWith([usageItem, yearlyItem]);
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.equal(added.length, 1, 'Once it has the usage price, nothing more is added');
      const [paid] = await rows('SELECT period_end FROM billing_accounts WHERE business_id=?', [
        businessId,
      ]);
      assert.equal(Math.floor(new Date(paid.period_end).getTime() / 1000), yearEnd);

      // A card saved for the accepted-quote plan starts its subscription once, on that plan only.
      await mutate(
        "UPDATE billing_accounts SET plan='per_accepted',checkout_session_id='cs_setup_mock',stripe_subscription_id=NULL,subscription_status='cancelled' WHERE business_id=?",
        [businessId],
      );
      stripe.checkout.sessions.retrieve = (async (id: string, params: any) => {
        assert.deepEqual([id, params], ['cs_setup_mock', { expand: ['setup_intent'] }]);
        return {
          id,
          mode: 'setup',
          status: 'complete',
          created: 1000,
          metadata: { plan: 'per_accepted' },
          setup_intent: { payment_method: 'pm_mock' },
        };
      }) as any;
      const defaults: any[] = [],
        starts: any[] = [];
      stripe.customers.update = (async (id: string, params: any) => {
        defaults.push([id, params]);
        return {};
      }) as any;
      const winSubscription = {
        id: 'sub_win_mock',
        status: 'active',
        created: 2000,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: 'si_win',
              price: { id: 'price_per_accepted_mock' },
              current_period_end: monthEnd,
            },
          ],
        },
      };
      stripe.subscriptions.create = (async (params: any, options: any) => {
        starts.push({ params, key: options.idempotencyKey });
        return winSubscription;
      }) as any;
      stripe.subscriptions.list = (async () => ({ data: [] })) as any;
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.deepEqual(starts, [
        {
          params: {
            customer: `cus_${suffix}`,
            items: [{ price: 'price_per_accepted_mock' }],
            default_payment_method: 'pm_mock',
            billing_mode: { type: 'flexible' },
            metadata: { businessId, plan: 'per_accepted' },
          },
          key: 'quotient-subscription:cs_setup_mock',
        },
      ]);
      assert.deepEqual(defaults, [
        [`cus_${suffix}`, { invoice_settings: { default_payment_method: 'pm_mock' } }],
      ]);
      const [win] = await rows(
        'SELECT stripe_subscription_id,subscription_status FROM billing_accounts WHERE business_id=?',
        [businessId],
      );
      assert.deepEqual(
        [win.stripe_subscription_id, win.subscription_status],
        ['sub_win_mock', 'active'],
      );
      assert.equal(added.length, 1, 'It starts with its quote price; nothing is added');
      // Cancelled later, it isn't started again; and a card saved for another plan starts nothing.
      stripe.subscriptions.list = (async () => ({
        data: [{ ...winSubscription, status: 'canceled' }],
      })) as any;
      await reconcileStripeCustomer(`cus_${suffix}`);
      await mutate("UPDATE billing_accounts SET plan='per_quote' WHERE business_id=?", [
        businessId,
      ]);
      stripe.subscriptions.list = (async () => ({ data: [] })) as any;
      await reconcileStripeCustomer(`cus_${suffix}`);
      assert.equal(starts.length, 1);
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
            items: { data: [] },
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
