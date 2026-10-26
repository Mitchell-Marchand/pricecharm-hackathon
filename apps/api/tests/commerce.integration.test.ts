import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createApp } from '../src/app.js';
import { closeDatabase, mutate, rows, transaction } from '../src/db.js';
import { hashToken } from '../src/auth.js';
import {
  requestContactVerification,
  verifyContactVerification,
  isContactVerified,
} from '../src/verification.js';
import {
  assertBillingAccess,
  dispatchMeterEvent,
  ensureBillingAccount,
  getBilling,
  reconcileStripeCustomer,
  stripeClient,
} from '../src/billing.js';
import { recordQuoteDelivery } from '../src/integrations/billing.js';
import {
  decryptEmail,
  deliverEmail,
  encryptEmail,
  queueEmail,
  validateEmailConfiguration,
} from '../src/integrations/email.js';
import { deleteBusinessAccount } from '../src/accounts.js';
import { runOneJob } from '../src/worker.js';
import { getPhoto, putPhoto } from '../src/storage.js';

const enabled = process.env.RUN_DB_TESTS === '1';
test(
  'identity, scoped contact codes, durable mail, tariff ledger, signed Stripe events and tenant deletion',
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
      serviceId = '',
      slug = '';
    async function session(email = 'customer@example.test') {
      const started = await guest
        .post(`/api/v1/public/${slug}/sessions`)
        .send({ serviceId })
        .expect(201);
      const id = started.body.data.session.id;
      return {
        id,
        email,
        ...(await requestContactVerification({
          businessId,
          sessionId: id,
          email,
          exposeCode: true,
        })),
      };
    }
    async function makeQuote(value = 10000) {
      const id = randomUUID();
      await mutate(
        `INSERT INTO quotes(id,business_id,service_id,service_version,customer_name,customer_email,status,description,quantity,total_cents,currency,assumptions_json,line_items_json,calculation_json,source,verified_contact)
      VALUES (?,?,?,1,'Test customer','customer@example.test','issued','Test quote',1,?,'USD','[]','[]','{}','live',TRUE)`,
        [id, businessId, serviceId, value],
      );
      return id;
    }
    async function record(quoteId: string, value = 10000) {
      return transaction((connection) =>
        recordQuoteDelivery(connection, {
          businessId,
          quoteId,
          totalCents: value,
          currency: 'USD',
          source: 'automatic',
          verifiedContact: true,
        }),
      );
    }
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

      const service = await a
        .post('/api/v1/services')
        .set('Origin', origin)
        .send({
          name: 'Commerce service',
          description: 'A repeatable service',
          unitLabel: 'unit',
          unitPriceCents: 10000,
          requiredInputs: ['quantity'],
        })
        .expect(201);
      serviceId = service.body.data.id;
      await mutate('UPDATE services SET published_at=UTC_TIMESTAMP(3) WHERE id=?', [serviceId]);
      const contact = await session('Customer@Example.Test');
      assert.equal(contact.delivery, 'local');
      assert.match(contact.devCode!, /^\d{6}$/);
      await assert.rejects(
        requestContactVerification({ businessId, sessionId: contact.id, email: contact.email }),
        /wait/i,
      );
      await assert.rejects(
        verifyContactVerification({
          businessId: businesses[1],
          sessionId: contact.id,
          verificationId: contact.verificationId,
          code: contact.devCode!,
        }),
        /incorrect/,
      );
      await assert.rejects(
        verifyContactVerification({
          businessId,
          sessionId: contact.id,
          verificationId: contact.verificationId,
          code: 'wrong',
        }),
        /incorrect/,
      );
      const verified = await verifyContactVerification({
        businessId,
        sessionId: contact.id,
        verificationId: contact.verificationId,
        code: contact.devCode!,
      });
      assert.equal(verified.email, 'customer@example.test');
      assert.equal(await isContactVerified(businessId, contact.id, 'CUSTOMER@example.test'), true);
      assert.equal(
        await isContactVerified(businessId, contact.id, 'different@example.test'),
        false,
      );
      await assert.rejects(
        verifyContactVerification({
          businessId,
          sessionId: contact.id,
          verificationId: contact.verificationId,
          code: contact.devCode!,
        }),
        /already used/,
      );
      const exhausted = await session('other@example.test');
      for (let i = 0; i < 5; i++)
        await assert.rejects(
          verifyContactVerification({
            businessId,
            sessionId: exhausted.id,
            verificationId: exhausted.verificationId,
            code: 'invalid',
          }),
          /incorrect/,
        );
      await assert.rejects(
        verifyContactVerification({
          businessId,
          sessionId: exhausted.id,
          verificationId: exhausted.verificationId,
          code: exhausted.devCode!,
        }),
        /incorrect/,
      );
      const stale = await session('stale@example.test');
      await mutate(
        'UPDATE contact_verifications SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [stale.verificationId],
      );
      await assert.rejects(
        verifyContactVerification({
          businessId,
          sessionId: stale.id,
          verificationId: stale.verificationId,
          code: stale.devCode!,
        }),
        /expired/,
      );

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
      process.env.MAIL_PROVIDER = 'ses';
      process.env.SES_EMAIL_FROM = 'sender@example.test';
      process.env.AWS_REGION = 'us-east-1';
      const originalSend = SESv2Client.prototype.send;
      let sends = 0;
      (SESv2Client.prototype as any).send = async (command: any) => {
        sends++;
        assert.equal(command.input.Destination.ToAddresses[0], payload.to);
        return { MessageId: 'mock-ses-message' };
      };
      try {
        await deliverEmail(emailId);
        await deliverEmail(emailId);
        assert.equal(sends, 1);
      } finally {
        SESv2Client.prototype.send = originalSend;
        process.env.MAIL_PROVIDER = 'local';
      }

      assert.equal((await assertBillingAccess(businessId)).canIssue, true);
      const first = await makeQuote();
      assert.equal(await record(first), true);
      assert.equal(await record(first), false);
      const second = await makeQuote();
      await record(second);
      assert.equal((await getBilling(businessId)).trial.remainingQuotes, 0);
      assert.equal((await assertBillingAccess(businessId)).canIssue, false);
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
      const paid = await makeQuote();
      await record(paid);
      const paidAgain = await makeQuote();
      await record(paidAgain);
      assert.equal((await getBilling(businessId)).usage.feesCents, 200);
      assert.equal((await assertBillingAccess(businessId, undefined, 10000)).canIssue, false);
      const [fee] = await rows('SELECT * FROM quote_usage WHERE quote_id=?', [paid]);
      assert.equal(Number(fee.fee_cents), 100);
      assert.equal(fee.tariff_version, 'quote-percentage-v1');

      process.env.BILLING_PROVIDER = 'stripe';
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_commerce';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_commerce';
      process.env.STRIPE_PRICE_ID = 'price_mock';
      process.env.STRIPE_METER_EVENT_NAME = 'quotient_fee_cents';
      await mutate(
        "UPDATE billing_accounts SET stripe_customer_id='cus_mock_commerce',subscription_status='active',last_reconciled_at=UTC_TIMESTAMP(3) WHERE business_id=?",
        [businessId],
      );
      const stripe = stripeClient();
      let meterCalls = 0;
      stripe.billing.meterEvents.create = (async (params: any, options: any) => {
        meterCalls++;
        assert.equal(params.identifier, `quotient:${fee.id}`);
        assert.equal(params.payload.value, '100');
        assert.equal(options.idempotencyKey, `quotient-meter:${fee.id}`);
        return { identifier: params.identifier };
      }) as any;
      await dispatchMeterEvent(fee.id);
      await dispatchMeterEvent(fee.id);
      assert.equal(meterCalls, 1);
      stripe.subscriptions.list = (async () => ({
        data: [
          {
            id: 'sub_mock',
            status: 'active',
            created: 100,
            cancel_at_period_end: false,
            items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 }] },
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
  'Stripe Checkout and Portal use server prices, verified owners, trusted URLs and current-state reconciliation',
  { skip: !enabled },
  async () => {
    process.env.MAIL_PROVIDER = 'local';
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_checkout';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_checkout';
    process.env.STRIPE_PRICE_ID = 'price_checkout_mock';
    process.env.STRIPE_METER_EVENT_NAME = 'quotient_fee_cents';
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
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(409);
      await mutate('UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE business_id=?', [
        businessId,
      ]);
      const stripe = stripeClient();
      let customers = 0,
        checkouts = 0,
        portals = 0;
      stripe.prices.retrieve = (async () => ({
        active: true,
        currency: 'usd',
        unit_amount: 1,
        recurring: { usage_type: 'metered', meter: 'meter_checkout' },
      })) as any;
      stripe.billing.meters.retrieve = (async () => ({
        event_name: 'quotient_fee_cents',
        default_aggregation: { formula: 'sum' },
      })) as any;
      stripe.customers.create = (async (params: any, options: any) => {
        customers++;
        assert.equal(params.metadata.businessId, businessId);
        assert.equal(options.idempotencyKey, `quotient-customer:${businessId}`);
        return { id: `cus_${suffix}` };
      }) as any;
      stripe.subscriptions.list = (async () => ({ data: [] })) as any;
      stripe.checkout.sessions.create = (async (params: any) => {
        checkouts++;
        assert.deepEqual(params.line_items, [{ price: 'price_checkout_mock' }]);
        assert.equal(params.mode, 'subscription');
        assert.match(params.success_url, /^http:\/\/localhost:3100\/app\/settings/);
        return { id: `cs_${suffix}`, url: 'https://checkout.stripe.com/mock-only' };
      }) as any;
      stripe.checkout.sessions.retrieve = (async () => ({
        status: 'open',
        url: 'https://checkout.stripe.com/mock-only',
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
      assert.equal(
        (await agent.post('/api/v1/billing/portal').set('Origin', origin).send({}).expect(200)).body
          .data.url,
        'https://billing.stripe.com/mock-only',
      );
      assert.equal(portals, 1);
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
      await mutate(
        'UPDATE billing_accounts SET trial_ends_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE business_id=?',
        [businessId],
      );
      assert.equal((await assertBillingAccess(businessId)).canIssue, false);
      stripe.prices.retrieve = (async () => ({
        active: true,
        currency: 'usd',
        unit_amount: 100,
        recurring: { usage_type: 'metered', meter: 'meter_checkout' },
      })) as any;
      await agent.post('/api/v1/billing/checkout').set('Origin', origin).send({}).expect(503);
    } finally {
      process.env.BILLING_PROVIDER = 'local';
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
