import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { owner } from './auth.js';
import { getPool, mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { iso } from './models.js';
import type { RowDataPacket } from 'mysql2/promise';
import { consumeAuthRateLimit } from './verification.js';
type BillingAccount = RowDataPacket & {
  fee_basis_points: number;
  minimum_fee_cents: number;
  maximum_fee_cents: number;
};

function setting(name: string, fallback: number, maximum: number, minimum = 0): number {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
export function publicPricing() {
  return {
    currency: 'USD' as const,
    monthlyCents: 0,
    includedQuotes: 0,
    overageCents: null,
    feeBasisPoints: setting('BILLING_FEE_BASIS_POINTS', 100, 10000),
    minimumFeeCents: setting('BILLING_MINIMUM_FEE_CENTS', 100, 100000),
    maximumFeeCents: setting('BILLING_MAXIMUM_FEE_CENTS', 2500, 100000),
    trialQuotes: setting('BILLING_TRIAL_QUOTES', 10, 100, 1),
    trialDays: setting('BILLING_TRIAL_DAYS', 14, 30, 1),
    tariffVersion: process.env.BILLING_TARIFF_VERSION || 'quote-percentage-v1',
  };
}
export function billingProvider(): 'local' | 'stripe' {
  const value =
    process.env.BILLING_PROVIDER || (process.env.NODE_ENV === 'production' ? 'stripe' : 'local');
  if (value !== 'local' && value !== 'stripe')
    throw new Error('BILLING_PROVIDER must be local or stripe.');
  if (value === 'local' && process.env.NODE_ENV === 'production')
    throw new Error('Production cannot use local payments.');
  return value;
}
export function stripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.STRIPE_PRICE_ID &&
    process.env.STRIPE_METER_EVENT_NAME,
  );
}
export function validateBillingConfiguration(): void {
  billingProvider();
  const pricing = publicPricing();
  if (pricing.maximumFeeCents < pricing.minimumFeeCents)
    throw new Error('The maximum quote fee must be at least its minimum.');
  if (process.env.NODE_ENV === 'production' && !stripeConfigured())
    throw new Error(
      'Production requires Stripe secret, webhook signing secret, metered price ID, and meter event name.',
    );
}
let stripeInstance: Stripe | undefined;
let stripeKey: string | undefined;
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key)
    throw new ApiError(
      503,
      'BILLING_NOT_CONFIGURED',
      'Payment setup is unavailable. Your remaining free trial can still be used.',
    );
  if (!stripeInstance || stripeKey !== key) {
    stripeKey = key;
    stripeInstance = new Stripe(key, { timeout: 10000, maxNetworkRetries: 1 });
  }
  return stripeInstance;
}
export async function ensureBillingAccount(businessId: string, connection: Sql) {
  const [business] = await rows(
    'SELECT id,created_at,deletion_requested_at FROM businesses WHERE id=? FOR UPDATE',
    [businessId],
    connection,
  );
  if (!business || business.deletion_requested_at)
    throw new ApiError(409, 'ACCOUNT_UNAVAILABLE', 'This business account is unavailable.');
  const pricing = publicPricing();
  await mutate(
    `INSERT IGNORE INTO billing_accounts(business_id,trial_ends_at,trial_quote_limit,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?)`,
    [
      businessId,
      new Date(new Date(business.created_at).getTime() + pricing.trialDays * 86400000),
      pricing.trialQuotes,
      pricing.feeBasisPoints,
      pricing.minimumFeeCents,
      pricing.maximumFeeCents,
      pricing.tariffVersion,
    ],
    connection,
  );
  const [account] = await rows<BillingAccount>(
    'SELECT * FROM billing_accounts WHERE business_id=? FOR UPDATE',
    [businessId],
    connection,
  );
  return account;
}
export function feeForQuote(
  totalCents: number,
  account: { fee_basis_points: number; minimum_fee_cents: number; maximum_fee_cents: number },
): number {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0)
    throw new Error('Quote values must be nonnegative integer cents.');
  if (totalCents === 0) return 0;
  const value = Number((BigInt(totalCents) * BigInt(account.fee_basis_points) + 5000n) / 10000n);
  return Math.min(
    Number(account.maximum_fee_cents),
    Math.max(Number(account.minimum_fee_cents), value),
  );
}
export async function billingCounts(businessId: string, connection: Sql) {
  const [usage] = await rows(
    `SELECT COUNT(*) delivered,
    COALESCE(SUM(source='automatic' AND verified_contact=TRUE),0) automatic,
    COALESCE(SUM(fee_cents>0 AND created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) billable,
    COALESCE(SUM(CASE WHEN created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01') THEN fee_cents ELSE 0 END),0) fees
    FROM quote_usage WHERE business_id=?`,
    [businessId],
    connection,
  );
  return {
    delivered: Number(usage.delivered),
    automatic: Number(usage.automatic),
    billable: Number(usage.billable),
    fees: Number(usage.fees),
  };
}
export async function assertBillingAccess(
  businessId: string,
  connection?: Sql,
  nextQuoteCents?: number,
): Promise<{ canIssue: boolean; reason?: string }> {
  const check = async (sql: Sql) => {
    const account = await ensureBillingAccount(businessId, sql),
      usage = await billingCounts(businessId, sql);
    if (
      new Date(account.trial_ends_at).getTime() > Date.now() &&
      usage.automatic < Number(account.trial_quote_limit)
    )
      return { canIssue: true };
    if (
      account.subscription_status !== 'active' ||
      (billingProvider() === 'stripe' && !stripeConfigured())
    )
      return {
        canIssue: false,
        reason: 'The free trial is complete. Activate billing to issue more automatic quotes.',
      };
    if (
      billingProvider() === 'stripe' &&
      (!account.last_reconciled_at ||
        new Date(account.last_reconciled_at).getTime() < Date.now() - 86400000)
    )
      return {
        canIssue: false,
        reason: 'Billing status is being refreshed. Requests can still be reviewed by the owner.',
      };
    const fee = nextQuoteCents === undefined ? 1 : feeForQuote(nextQuoteCents, account);
    if (usage.fees + fee > Number(account.spending_cap_cents))
      return {
        canIssue: false,
        reason:
          'This workspace reached its monthly fee spending cap. The owner can review this request or raise the cap.',
      };
    return { canIssue: true };
  };
  return connection ? check(connection) : transaction(check);
}
export async function getBilling(businessId: string) {
  return transaction(async (connection) => {
    const account = await ensureBillingAccount(businessId, connection),
      usage = await billingCounts(businessId, connection);
    const access = await assertBillingAccess(businessId, connection);
    const provider = billingProvider(),
      configured = provider === 'local' || stripeConfigured();
    const trialRemaining =
      new Date(account.trial_ends_at).getTime() > Date.now()
        ? Math.max(0, Number(account.trial_quote_limit) - usage.automatic)
        : 0;
    return {
      provider,
      configured,
      status: String(account.subscription_status),
      ...access,
      trial: {
        remainingQuotes: trialRemaining,
        quoteLimit: Number(account.trial_quote_limit),
        endsAt: iso(account.trial_ends_at),
      },
      usage: {
        deliveredQuotes: usage.delivered,
        billableQuotes: usage.billable,
        feesCents: usage.fees,
        month: new Date().toISOString().slice(0, 7),
      },
      tariff: {
        basisPoints: Number(account.fee_basis_points),
        minimumFeeCents: Number(account.minimum_fee_cents),
        maximumFeeCents: Number(account.maximum_fee_cents),
        currency: 'USD',
        version: String(account.tariff_version),
      },
      spendingCapCents: Number(account.spending_cap_cents),
      subscription:
        account.stripe_subscription_id || account.subscription_status === 'active'
          ? {
              status: String(account.subscription_status),
              cancelAtPeriodEnd: Boolean(account.cancel_at_period_end),
              periodEnd: account.period_end ? iso(account.period_end) : null,
            }
          : null,
      checkoutAvailable: configured && account.subscription_status !== 'active',
      portalAvailable:
        provider === 'local'
          ? account.subscription_status === 'active'
          : Boolean(configured && account.stripe_customer_id),
    };
  });
}
function appOrigin(): string {
  const value = (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
  const url = new URL(value);
  if (url.origin !== value || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:'))
    throw new Error('Invalid application origin.');
  return value;
}
async function validateMeteredPrice(): Promise<void> {
  if (!stripeConfigured())
    throw new ApiError(503, 'BILLING_NOT_CONFIGURED', 'Payment setup is unavailable.');
  const stripe = stripeClient(),
    price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID!);
  if (
    !price.active ||
    price.currency !== 'usd' ||
    price.unit_amount !== 1 ||
    price.recurring?.usage_type !== 'metered' ||
    !price.recurring.meter
  )
    throw new ApiError(
      503,
      'BILLING_PRICE_INVALID',
      'The configured billing price must be an active USD metered price of one cent per fee-cent unit.',
    );
  const meter = await stripe.billing.meters.retrieve(price.recurring.meter);
  if (
    meter.event_name !== process.env.STRIPE_METER_EVENT_NAME ||
    meter.default_aggregation.formula !== 'sum'
  )
    throw new ApiError(
      503,
      'BILLING_METER_INVALID',
      'The configured price must use the correct sum meter.',
    );
}

export const pricingHandler: RequestHandler = (_req, res) => {
  res.json(ok(publicPricing()));
};
export const billingRouter = Router();
billingRouter.get('/billing', async (req, res) => {
  res.json(ok(await getBilling(owner(req).businessId)));
});
billingRouter.patch('/billing', async (req, res) => {
  const { spendingCapCents } = z
    .object({ spendingCapCents: z.number().int().min(0).max(1_000_000) })
    .strict()
    .parse(req.body);
  await transaction(async (connection) => {
    await ensureBillingAccount(owner(req).businessId, connection);
    await mutate(
      'UPDATE billing_accounts SET spending_cap_cents=? WHERE business_id=?',
      [spendingCapCents, owner(req).businessId],
      connection,
    );
  });
  res.json(ok(await getBilling(owner(req).businessId)));
});
billingRouter.post('/billing/checkout', async (req, res) => {
  const context = owner(req);
  z.object({})
    .strict()
    .parse(req.body ?? {});
  if (!context.emailVerified)
    throw new ApiError(
      409,
      'EMAIL_VERIFICATION_REQUIRED',
      'Verify your owner email before activating billing.',
    );
  await consumeAuthRateLimit(`billing-checkout:${context.businessId}`, 5, 3600000);
  if (billingProvider() === 'local') {
    await transaction(async (connection) => {
      await ensureBillingAccount(context.businessId, connection);
      await mutate(
        "UPDATE billing_accounts SET subscription_status='active',last_reconciled_at=UTC_TIMESTAMP(3) WHERE business_id=?",
        [context.businessId],
        connection,
      );
    });
    res.json(ok({ url: `${appOrigin()}/dashboard/billing?local=active` }));
    return;
  }
  await validateMeteredPrice();
  const url = await transaction(async (connection) => {
    const account = await ensureBillingAccount(context.businessId, connection),
      stripe = stripeClient();
    let customerId: string = account.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: context.email, name: context.name, metadata: { businessId: context.businessId } },
        { idempotencyKey: `quotient-customer:${context.businessId}` },
      );
      customerId = customer.id;
      await mutate(
        'UPDATE billing_accounts SET stripe_customer_id=? WHERE business_id=?',
        [customerId, context.businessId],
        connection,
      );
    }
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    if (existingSubscriptions.data.length)
      throw new ApiError(
        409,
        'SUBSCRIPTION_EXISTS',
        'A subscription already exists. Use the billing portal to manage it.',
      );
    if (account.checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(String(account.checkout_session_id));
      if (existing.status === 'open' && existing.url) return existing.url;
    }
    const checkout = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: process.env.STRIPE_PRICE_ID! }],
        client_reference_id: context.businessId,
        subscription_data: { metadata: { businessId: context.businessId } },
        success_url: `${appOrigin()}/dashboard/billing?checkout=success`,
        cancel_url: `${appOrigin()}/dashboard/billing?checkout=cancelled`,
      },
      {
        idempotencyKey: `quotient-checkout:${context.businessId}:${Math.floor(Date.now() / 3600000)}`,
      },
    );
    if (!checkout.url)
      throw new ApiError(502, 'CHECKOUT_FAILED', 'Payment setup could not be started.');
    await mutate(
      'UPDATE billing_accounts SET checkout_session_id=? WHERE business_id=?',
      [checkout.id, context.businessId],
      connection,
    );
    return checkout.url;
  });
  res.json(ok({ url }));
});
billingRouter.post('/billing/portal', async (req, res) => {
  await consumeAuthRateLimit(`billing-portal:${owner(req).businessId}`, 20, 3600000);
  z.object({})
    .strict()
    .parse(req.body ?? {});
  if (billingProvider() === 'local') {
    res.json(ok({ url: `${appOrigin()}/dashboard/billing?local=portal` }));
    return;
  }
  const [account] = await rows(
    'SELECT stripe_customer_id FROM billing_accounts WHERE business_id=?',
    [owner(req).businessId],
  );
  if (!account?.stripe_customer_id)
    throw new ApiError(
      409,
      'BILLING_ACCOUNT_REQUIRED',
      'Activate billing before opening the portal.',
    );
  const portal = await stripeClient().billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${appOrigin()}/dashboard/billing`,
  });
  res.json(ok({ url: portal.url }));
});

export const stripeWebhook: RequestHandler = async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET || !Buffer.isBuffer(req.body))
    throw new ApiError(400, 'WEBHOOK_BODY_INVALID', 'A signed raw webhook body is required.');
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string')
    throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is missing.');
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
  }
  // Meter error notifications can be thin events without data.object.
  const object = (event.data?.object ?? {}) as unknown as { customer?: string | { id: string } };
  const customerId =
    typeof object.customer === 'string' ? object.customer : (object.customer?.id ?? null);
  await transaction(async (connection) => {
    await mutate(
      'INSERT IGNORE INTO stripe_events(id,type,customer_id) VALUES (?,?,?)',
      [event.id, event.type, customerId],
      connection,
    );
    await mutate(
      `INSERT IGNORE INTO jobs(id,type,payload_json,dedupe_key) VALUES (?,?,?,?)`,
      [
        randomUUID(),
        event.type.startsWith('v1.billing.meter.') ? 'billing_meter_error' : 'stripe_reconcile',
        JSON.stringify({ eventId: event.id, customerId }),
        `stripe-event:${event.id}`,
      ],
      connection,
    );
  });
  res.json(ok({ received: true }));
};

export async function reconcileStripeCustomer(customerId: string): Promise<void> {
  if (billingProvider() !== 'stripe') return;
  const [account] = await rows(
    'SELECT business_id FROM billing_accounts WHERE stripe_customer_id=?',
    [customerId],
  );
  if (!account) return;
  // Read current provider state instead of applying event snapshots; event delivery order is not authoritative.
  const subscriptions = await stripeClient().subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  const current = [...subscriptions.data].sort((a, b) => {
    const score = (status: string) =>
      status === 'active' ? 3 : status === 'trialing' ? 2 : status === 'past_due' ? 1 : 0;
    return score(b.status) - score(a.status) || b.created - a.created;
  })[0];
  await transaction(async (connection) => {
    await rows(
      'SELECT business_id FROM billing_accounts WHERE business_id=? FOR UPDATE',
      [account.business_id],
      connection,
    );
    const periodEnd = current?.items.data[0]?.current_period_end;
    await mutate(
      'UPDATE billing_accounts SET stripe_subscription_id=?,subscription_status=?,cancel_at_period_end=?,period_end=?,last_reconciled_at=UTC_TIMESTAMP(3) WHERE business_id=?',
      [
        current?.id ?? null,
        current?.status ?? 'cancelled',
        current?.cancel_at_period_end ?? false,
        periodEnd ? new Date(periodEnd * 1000) : null,
        account.business_id,
      ],
      connection,
    );
  });
}

export async function dispatchMeterEvent(usageId: string): Promise<void> {
  const item = await transaction(async (connection) => {
    const [usage] = await rows(
      'SELECT q.*,b.stripe_customer_id FROM quote_usage q JOIN billing_accounts b ON b.business_id=q.business_id WHERE q.id=? FOR UPDATE',
      [usageId],
      connection,
    );
    if (!usage || usage.stripe_reported_at || Number(usage.fee_cents) <= 0) return null;
    if (
      usage.dispatch_started_at &&
      new Date(usage.dispatch_started_at).getTime() < Date.now() - 23 * 3600000
    )
      throw new Error('Meter event requires manual reconciliation before another attempt.');
    await mutate(
      'UPDATE quote_usage SET dispatch_started_at=COALESCE(dispatch_started_at,UTC_TIMESTAMP(3)) WHERE id=?',
      [usageId],
      connection,
    );
    return usage;
  });
  if (!item) return;
  if (billingProvider() === 'stripe') {
    if (!item.stripe_customer_id) throw new Error('A metered event has no billing customer.');
    await stripeClient().billing.meterEvents.create(
      {
        event_name: process.env.STRIPE_METER_EVENT_NAME!,
        identifier: `quotient:${usageId}`,
        payload: { stripe_customer_id: item.stripe_customer_id, value: String(item.fee_cents) },
        timestamp: Math.floor(new Date(item.created_at).getTime() / 1000),
      },
      { idempotencyKey: `quotient-meter:${usageId}` },
    );
  }
  await mutate(
    'UPDATE quote_usage SET stripe_reported_at=UTC_TIMESTAMP(3) WHERE id=? AND stripe_reported_at IS NULL',
    [usageId],
  );
}
