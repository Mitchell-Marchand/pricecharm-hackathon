import { randomInt, randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { iso } from './models.js';
import type { RowDataPacket } from 'mysql2/promise';
import { consumeAuthRateLimit } from './verification.js';
import { recordMilestone, recordRequestEvent } from './metrics.js';
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
/**
 * The ways an owner can pay. Two charge per quote with nothing up front: $2 for each quote a
 * customer receives, or 1% of each quote a customer accepts. The third is a subscription, monthly
 * or yearly, with a free week and quotes past an allowance at $1 each.
 */
export const PLANS = ['per_quote', 'per_accepted', 'monthly', 'yearly'] as const;
export type Plan = (typeof PLANS)[number];
/** What an owner chooses between, side by side. The subscription is one choice, either way paid. */
export const PLAN_CHOICES = ['per_quote', 'per_accepted', 'subscription'] as const;
export const isSubscription = (plan: unknown): plan is 'monthly' | 'yearly' =>
  plan === 'monthly' || plan === 'yearly';
/** A card is on file and in good standing, including the subscription's free week. */
export const isPaying = (status: unknown) => status === 'active' || status === 'trialing';

export function publicPricing() {
  return {
    currency: 'USD' as const,
    perQuoteCents: setting('BILLING_PER_QUOTE_CENTS', 200, 100000, 1),
    accepted: {
      basisPoints: setting('BILLING_ACCEPTED_BASIS_POINTS', 100, 10000, 1),
      minimumFeeCents: setting('BILLING_ACCEPTED_MINIMUM_CENTS', 100, 100000),
      maximumFeeCents: setting('BILLING_ACCEPTED_MAXIMUM_CENTS', 2500, 100000),
    },
    subscription: {
      monthlyCents: setting('BILLING_MONTHLY_CENTS', 4900, 1000000, 1),
      yearlyCents: setting('BILLING_YEARLY_CENTS', 49900, 10000000, 1),
      trialDays: setting('BILLING_TRIAL_DAYS', 7, 60),
      /** Quotes a month the subscription covers. Past that, each one is the overage fee. */
      includedQuotes: setting('BILLING_INCLUDED_QUOTES', 100, 100000),
      overageCents: setting('BILLING_OVERAGE_CENTS', 100, 100000),
    },
    // Free quotes before fees start, on any plan. None by default.
    trialQuotes: setting('BILLING_TRIAL_QUOTES', 0, 100),
    // Quote fees in the 30 days after a business first adds a card stop here, on every plan.
    firstMonthMaxCents: setting('BILLING_FIRST_MONTH_MAX_CENTS', 4900, 1000000),
  };
}

const FIRST_MONTH_DAYS = 30;
/**
 * The 30 days after a business first added a card, while they last: when they end, the fees so
 * far, what the first-month max let off, and what's left under it. Null before a card and after.
 */
export async function firstMonth(account: RowDataPacket, connection: Sql) {
  if (!account.card_added_at) return null;
  const start = new Date(account.card_added_at),
    end = new Date(start.getTime() + FIRST_MONTH_DAYS * 86400000);
  if (end.getTime() <= Date.now()) return null;
  const [usage] = await rows(
    'SELECT COALESCE(SUM(fee_cents),0) fees,COALESCE(SUM(waived_cents),0) waived FROM quote_usage WHERE business_id=? AND created_at>=?',
    [account.business_id, start],
    connection,
  );
  const feesCents = Number(usage.fees);
  return {
    endsAt: end,
    feesCents,
    waivedCents: Number(usage.waived),
    roomCents: Math.max(0, publicPricing().firstMonthMaxCents - feesCents),
  };
}

/**
 * The fee terms each quote is charged under on a plan. They're saved on the account when the plan
 * is chosen and on every fee, so a later price change never rewrites an old charge. On the
 * subscription, they're the fee for a quote past the month's allowance.
 */
export function planTariff(plan: Plan) {
  const pricing = publicPricing();
  if (plan === 'per_quote')
    return {
      basisPoints: 0,
      minimumFeeCents: pricing.perQuoteCents,
      maximumFeeCents: pricing.perQuoteCents,
      version: 'per-quote-v1',
    };
  if (plan === 'per_accepted') return { ...pricing.accepted, version: 'per-accepted-v1' };
  return {
    basisPoints: 0,
    minimumFeeCents: pricing.subscription.overageCents,
    maximumFeeCents: pricing.subscription.overageCents,
    version: `${plan}-v1`,
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
/**
 * Each plan has its own Stripe prices, priced the way the pricing page says it. Three are on the
 * meter that counts billed quotes: $2 a quote, $1 a quote past the subscription's allowance, and
 * $0 a quote on the accepted-quote plan, whose fees go on the invoice one accepted job at a time.
 * The other two are the subscription's monthly and yearly prices.
 */
const STRIPE_PRICES = [
  'STRIPE_PRICE_PER_QUOTE',
  'STRIPE_PRICE_PER_ACCEPTED',
  'STRIPE_PRICE_EXTRA_QUOTES',
  'STRIPE_PRICE_MONTHLY',
  'STRIPE_PRICE_YEARLY',
] as const;
export function stripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.STRIPE_METER_EVENT_NAME &&
    STRIPE_PRICES.every((name) => process.env[name]),
  );
}
export function validateBillingConfiguration(): void {
  billingProvider();
  const accepted = publicPricing().accepted;
  if (accepted.maximumFeeCents < accepted.minimumFeeCents)
    throw new Error('The maximum accepted-quote fee must be at least its minimum.');
  if (process.env.NODE_ENV === 'production' && !stripeConfigured())
    throw new Error(
      `Production requires the Stripe secret, webhook signing secret, meter event name and ${STRIPE_PRICES.join(', ')}.`,
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
  // Fee terms stay unset in effect until a plan is chosen; quotes can't go out before then.
  const tariff = planTariff('per_quote');
  await mutate(
    `INSERT IGNORE INTO billing_accounts(business_id,trial_ends_at,trial_quote_limit,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?)`,
    [
      businessId,
      // Free quotes don't expire; the old flow's trial end date stays far off.
      new Date('2100-01-01T00:00:00Z'),
      publicPricing().trialQuotes,
      tariff.basisPoints,
      tariff.minimumFeeCents,
      tariff.maximumFeeCents,
      tariff.version,
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
    `SELECT COALESCE(SUM(charge='delivered'),0) delivered,
    COALESCE(SUM(fee_cents>0 AND created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) billable,
    COALESCE(SUM(CASE WHEN created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01') THEN fee_cents ELSE 0 END),0) fees
    FROM quote_usage WHERE business_id=?`,
    [businessId],
    connection,
  );
  return {
    delivered: Number(usage.delivered),
    billable: Number(usage.billable),
    fees: Number(usage.fees),
  };
}
/**
 * The order an owner sees the plans in. It's random per business and kept, so no plan gets an
 * edge from going first, and what they picked can be read against what they saw.
 */
async function planOrder(businessId: string, saved: unknown, connection: Sql) {
  const known = String(saved ?? '').split(',');
  if (known.length === PLAN_CHOICES.length && PLAN_CHOICES.every((plan) => known.includes(plan)))
    return known as (typeof PLAN_CHOICES)[number][];
  const order = [...PLAN_CHOICES];
  for (let index = order.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
  await mutate(
    'UPDATE billing_accounts SET plan_order=? WHERE business_id=?',
    [order.join(','), businessId],
    connection,
  );
  return order;
}

/** A record for seeing which plans owners pick: shown, chosen, switched. */
export async function planEvent(
  connection: Sql,
  businessId: string,
  kind: 'plan_chosen' | 'plan_scheduled',
  metadata: Record<string, unknown>,
) {
  await mutate(
    'INSERT INTO usage_events(id,business_id,kind,dedupe_key,metadata_json) VALUES (?,?,?,?,?)',
    [
      randomUUID(),
      businessId,
      kind,
      `${kind}:${businessId}:${randomUUID()}`,
      JSON.stringify(metadata),
    ],
    connection,
  );
}

export async function getBilling(businessId: string) {
  return transaction(async (connection) => {
    const account = await ensureBillingAccount(businessId, connection),
      usage = await billingCounts(businessId, connection),
      first = await firstMonth(account, connection);
    const provider = billingProvider(),
      configured = provider === 'local' || stripeConfigured();
    return {
      provider,
      configured,
      plan: (account.plan as Plan | null) ?? null,
      /** A switch that happens when the paid period ends. */
      nextPlan: (account.next_plan as Plan | null) ?? null,
      planOrder: await planOrder(businessId, account.plan_order, connection),
      pricing: publicPricing(),
      /** The subscription's free week, if they haven't had it. */
      freeWeek: !account.trial_used_at,
      /**
       * The first-month max while they have it: still ahead until a card is added, with no end
       * date yet, then for 30 days. Null once those are over.
       */
      firstMonth: first
        ? { endsAt: iso(first.endsAt), feesCents: first.feesCents, waivedCents: first.waivedCents }
        : account.card_added_at
          ? null
          : { endsAt: null, feesCents: 0, waivedCents: 0 },
      periodEnd: account.period_end ? iso(account.period_end) : null,
      status: String(account.subscription_status),
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
        account.stripe_subscription_id || isPaying(account.subscription_status)
          ? {
              status: String(account.subscription_status),
              cancelAtPeriodEnd: Boolean(account.cancel_at_period_end),
              periodEnd: account.period_end ? iso(account.period_end) : null,
            }
          : null,
      checkoutAvailable: configured && !isPaying(account.subscription_status),
      portalAvailable:
        provider === 'local'
          ? isPaying(account.subscription_status)
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
/**
 * The Stripe prices behind a plan: its price on the quote meter, which every subscription has one
 * of, and the monthly or yearly price on the subscription plans.
 */
function planPrices(plan: Plan): { metered: string; fixed: string | null } {
  return {
    metered:
      plan === 'per_quote'
        ? process.env.STRIPE_PRICE_PER_QUOTE!
        : plan === 'per_accepted'
          ? process.env.STRIPE_PRICE_PER_ACCEPTED!
          : process.env.STRIPE_PRICE_EXTRA_QUOTES!,
    fixed:
      plan === 'monthly'
        ? process.env.STRIPE_PRICE_MONTHLY!
        : plan === 'yearly'
          ? process.env.STRIPE_PRICE_YEARLY!
          : null,
  };
}
/** The subscription's item for the monthly or yearly plan's own price, if it has one. */
function planItem(subscription: Stripe.Subscription) {
  const fixedPrices = [process.env.STRIPE_PRICE_MONTHLY, process.env.STRIPE_PRICE_YEARLY];
  return subscription.items.data.find((item) => fixedPrices.includes(item.price.id));
}
/** The subscription's item on the quote meter, whichever plan's price it has now. */
function meteredItem(subscription: Stripe.Subscription) {
  const meteredPrices = [
    process.env.STRIPE_PRICE_PER_QUOTE,
    process.env.STRIPE_PRICE_PER_ACCEPTED,
    process.env.STRIPE_PRICE_EXTRA_QUOTES,
  ];
  return subscription.items.data.find((item) => meteredPrices.includes(item.price.id));
}
/**
 * When the period they paid for ends. The quote meter bills monthly even on the yearly plan, so
 * it's the plan's own price that counts, not whichever item Stripe lists first.
 */
function paidPeriodEnd(subscription: Stripe.Subscription): number | undefined {
  return (planItem(subscription) ?? subscription.items.data[0])?.current_period_end;
}

/**
 * What a price on the quote meter charges for each quote, or null when it isn't one amount. The
 * accepted-quote plan's price is two $0 tiers: Checkout shows a flat $0 price as "$0.00 per unit",
 * but tiers as "Price varies", under the plan's 1% terms, with the tiers folded away.
 */
export function centsPerQuote(price: Stripe.Price): number | null {
  if (price.billing_scheme !== 'tiered') return price.unit_amount;
  const amounts = new Set(price.tiers?.map((tier) => (tier.flat_amount ? -1 : tier.unit_amount)));
  const [amount] = amounts;
  return amounts.size === 1 && amount !== undefined && amount !== -1 ? amount : null;
}

/**
 * A plan's Stripe prices must match what the pricing page says, so a mistyped price fails closed
 * instead of charging something else.
 */
async function validatePlanPrices(plan: Plan): Promise<void> {
  if (!stripeConfigured())
    throw new ApiError(503, 'BILLING_NOT_CONFIGURED', 'Payment setup is unavailable.');
  const stripe = stripeClient(),
    pricing = publicPricing(),
    prices = planPrices(plan);
  const perQuote =
    plan === 'per_quote'
      ? pricing.perQuoteCents
      : plan === 'per_accepted'
        ? 0
        : pricing.subscription.overageCents;
  const metered = await stripe.prices.retrieve(prices.metered, { expand: ['tiers'] });
  if (
    !metered.active ||
    metered.currency !== 'usd' ||
    centsPerQuote(metered) !== perQuote ||
    metered.recurring?.usage_type !== 'metered' ||
    metered.recurring.interval !== 'month' ||
    !metered.recurring.meter
  )
    throw new ApiError(
      503,
      'BILLING_PRICE_INVALID',
      `The ${plan} quote price must be an active USD monthly metered price of ${perQuote} cents a quote.`,
    );
  const meter = await stripe.billing.meters.retrieve(metered.recurring.meter);
  if (
    meter.event_name !== process.env.STRIPE_METER_EVENT_NAME ||
    meter.default_aggregation.formula !== 'sum'
  )
    throw new ApiError(
      503,
      'BILLING_METER_INVALID',
      'The quote prices must use the sum meter for the configured event name.',
    );
  if (!prices.fixed) return;
  const fixed = await stripe.prices.retrieve(prices.fixed);
  const expected = pricing.subscription[plan === 'monthly' ? 'monthlyCents' : 'yearlyCents'];
  if (
    !fixed.active ||
    fixed.currency !== 'usd' ||
    fixed.unit_amount !== expected ||
    fixed.recurring?.usage_type !== 'licensed' ||
    fixed.recurring.interval !== (plan === 'monthly' ? 'month' : 'year')
  )
    throw new ApiError(
      503,
      'BILLING_PRICE_INVALID',
      `The configured ${plan} price must be an active USD ${plan === 'monthly' ? 'monthly' : 'yearly'} price of ${expected} cents.`,
    );
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function dollars(cents: number): string {
  return cents % 100 ? `$${(cents / 100).toFixed(2)}` : `$${cents / 100}`;
}
/**
 * What the plan costs, in a line above Checkout's button. Stripe can't show 1% as a price. A first
 * card also gets the first-month max.
 */
function checkoutTerms(plan: Plan, firstCard: boolean): string {
  const pricing = publicPricing(),
    { accepted, subscription } = pricing;
  const first = firstCard
    ? ` In your first 30 days, quote fees stop at ${dollars(pricing.firstMonthMaxCents)}.`
    : '';
  if (plan === 'per_quote')
    return `${dollars(pricing.perQuoteCents)} for each quote a customer gets from you, billed monthly. Nothing today.${first}`;
  if (plan === 'per_accepted')
    return `Nothing today. Each month, your card is billed ${accepted.basisPoints / 100}% of the quotes customers accepted, at least ${dollars(accepted.minimumFeeCents)} and at most ${dollars(accepted.maximumFeeCents)} each. No accepted quotes, no bill.${first}`;
  return `Includes ${subscription.includedQuotes} quotes a month. Each one past that is ${dollars(subscription.overageCents)}, billed monthly.${first}`;
}

billingRouter.post('/billing/checkout', async (req, res) => {
  const context = owner(req);
  // From setup, the owner comes back to setup's last screen, which says when they're live.
  const { from } = z
    .object({ from: z.enum(['setup']).optional() })
    .strict()
    .parse(req.body ?? {});
  const back = from === 'setup' ? '/start/live' : '/app/settings';
  await recordRequestEvent(req, context.businessId, 'checkout_started', {
    from: from ?? 'settings',
  });
  // Confirming the email isn't needed first: it's asked for, never in the way of going live.
  // Owners try a few plans before picking one, so this only stops a script.
  await consumeAuthRateLimit(`billing-checkout:${context.businessId}`, 30, 3600000);
  if (billingProvider() === 'local') {
    await transaction(async (connection) => {
      const account = await ensureBillingAccount(context.businessId, connection);
      const plan = chosenPlan(account);
      // Locally the card is taken as given, and a subscription starts on its free week.
      const freeWeek = isSubscription(plan) && !account.trial_used_at;
      await mutate(
        `UPDATE billing_accounts SET subscription_status=?,period_end=?,last_reconciled_at=UTC_TIMESTAMP(3),card_added_at=COALESCE(card_added_at,UTC_TIMESTAMP(3))${freeWeek ? ',trial_used_at=UTC_TIMESTAMP(3)' : ''} WHERE business_id=?`,
        [
          freeWeek ? 'trialing' : 'active',
          freeWeek
            ? new Date(Date.now() + publicPricing().subscription.trialDays * 86400000)
            : null,
          context.businessId,
        ],
        connection,
      );
      await recordMilestone(connection, context.businessId, 'billing_active');
    });
    res.json(ok({ url: `${appOrigin()}${back}?billing=active` }));
    return;
  }
  const url = await transaction(async (connection) => {
    const account = await ensureBillingAccount(context.businessId, connection),
      stripe = stripeClient();
    const plan = chosenPlan(account);
    await validatePlanPrices(plan);
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
    // An open checkout is reused only if it's for the plan they've chosen now.
    if (account.checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(String(account.checkout_session_id));
      if (
        existing.status === 'open' &&
        existing.url &&
        existing.mode === 'subscription' &&
        existing.metadata?.plan === plan
      )
        return existing.url;
    }
    const prices = planPrices(plan);
    const freeWeek = isSubscription(plan) && !account.trial_used_at;
    const checkout = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        // Checkout can't mix billing intervals, so the yearly plan starts on its own price and
        // reconciliation adds the monthly quote price before any quote goes out.
        line_items: [
          ...(prices.fixed ? [{ price: prices.fixed, quantity: 1 }] : []),
          ...(plan === 'yearly' ? [] : [{ price: prices.metered }]),
        ],
        client_reference_id: context.businessId,
        metadata: { plan },
        // A monthly bill for a business: no buy-now-pay-later or app wallets.
        allowed_payment_method_types: ['card', 'link', 'us_bank_account'],
        custom_text: { submit: { message: checkoutTerms(plan, !account.card_added_at) } },
        subscription_data: {
          // Usage from before a plan switch is billed at the old price, not dropped.
          billing_mode: { type: 'flexible' },
          metadata: { businessId: context.businessId, plan },
          ...(freeWeek ? { trial_period_days: publicPricing().subscription.trialDays } : {}),
        },
        success_url: `${appOrigin()}${back}?billing=active`,
        cancel_url: `${appOrigin()}${back}`,
      },
      {
        idempotencyKey: `quotient-checkout:${context.businessId}:${plan}:${Math.floor(Date.now() / 3600000)}`,
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

/** The plan on the account, or a clear refusal: a card is added for a chosen plan. */
function chosenPlan(account: RowDataPacket): Plan {
  if (!PLANS.includes(account.plan))
    throw new ApiError(409, 'PLAN_REQUIRED', 'Choose how you’d like to pay first.');
  return account.plan as Plan;
}

/**
 * Moves a paying Stripe subscription onto a plan's prices now: adds, swaps or drops the
 * subscription price, and swaps the price on the quote meter. That item is swapped, never
 * deleted, because Stripe drops a deleted item's usage; quotes from before the switch are billed
 * at the old price.
 */
async function moveSubscription(account: RowDataPacket, plan: Plan, freeWeek: boolean) {
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(String(account.stripe_subscription_id));
  const current = planItem(subscription),
    currentMetered = meteredItem(subscription);
  const target = planPrices(plan);
  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  if (current && !target.fixed) items.push({ id: current.id, deleted: true });
  else if (current && target.fixed && current.price.id !== target.fixed)
    items.push({ id: current.id, price: target.fixed });
  else if (!current && target.fixed) items.push({ price: target.fixed, quantity: 1 });
  if (!currentMetered) items.push({ price: target.metered });
  else if (currentMetered.price.id !== target.metered)
    items.push({ id: currentMetered.id, price: target.metered });
  if (!items.length && !freeWeek) return;
  await stripe.subscriptions.update(
    subscription.id,
    {
      items,
      proration_behavior: 'create_prorations',
      ...(freeWeek
        ? {
            trial_end:
              Math.floor(Date.now() / 1000) + publicPricing().subscription.trialDays * 86400,
          }
        : {}),
    },
    { idempotencyKey: `quotient-plan:${account.business_id}:${plan}:${Date.now()}` },
  );
}

/**
 * Books a switch for the end of the paid period with a Stripe schedule, so the next renewal is
 * already on the new plan's prices and nothing paid for is lost.
 */
async function scheduleSubscription(account: RowDataPacket, plan: Plan): Promise<string> {
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(String(account.stripe_subscription_id));
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: subscription.id,
  });
  const [phase] = schedule.phases;
  const prices = planPrices(plan);
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    phases: [
      {
        items: phase.items.map((item) => ({
          price: typeof item.price === 'string' ? item.price : item.price.id,
          ...(item.quantity ? { quantity: item.quantity } : {}),
        })),
        start_date: phase.start_date,
        // Stripe ends the first phase with the quote meter's month; a yearly plan runs to its year.
        end_date: paidPeriodEnd(subscription) ?? phase.end_date,
      },
      {
        items: [
          ...(prices.fixed ? [{ price: prices.fixed, quantity: 1 }] : []),
          { price: prices.metered },
        ],
        proration_behavior: 'none',
      },
    ],
  });
  return schedule.id;
}

/** Saves the plan and its fee terms, from now on. */
async function applyPlan(connection: Sql, account: RowDataPacket, plan: Plan, freeWeek: boolean) {
  const tariff = planTariff(plan);
  await mutate(
    `UPDATE billing_accounts SET plan=?,next_plan=NULL,plan_schedule_id=NULL,plan_chosen_at=UTC_TIMESTAMP(3),fee_basis_points=?,minimum_fee_cents=?,maximum_fee_cents=?,tariff_version=?${freeWeek ? ',trial_used_at=COALESCE(trial_used_at,UTC_TIMESTAMP(3))' : ''} WHERE business_id=?`,
    [
      plan,
      tariff.basisPoints,
      tariff.minimumFeeCents,
      tariff.maximumFeeCents,
      tariff.version,
      account.business_id,
    ],
    connection,
  );
  await planEvent(connection, String(account.business_id), 'plan_chosen', {
    from: account.plan ?? null,
    to: plan,
    shownOrder: account.plan_order,
    paying: isPaying(account.subscription_status),
  });
}

/**
 * Picks or switches the plan, any time. Before a card, between the per-quote plans, and onto or
 * up a subscription, it happens now. Off a paid subscription, or from yearly to monthly, it waits
 * for the end of the period they paid for.
 */
export async function changePlan(businessId: string, plan: Plan): Promise<void> {
  await transaction(async (connection) => {
    const account = await ensureBillingAccount(businessId, connection);
    const current = PLANS.includes(account.plan) ? (account.plan as Plan) : null;
    const onStripe =
      billingProvider() === 'stripe' &&
      Boolean(account.stripe_subscription_id) &&
      isPaying(account.subscription_status);
    // Changing their mind about a booked switch undoes it first.
    if (account.plan_schedule_id && onStripe)
      await stripeClient().subscriptionSchedules.release(String(account.plan_schedule_id));
    if (account.next_plan)
      await mutate(
        'UPDATE billing_accounts SET next_plan=NULL,plan_schedule_id=NULL WHERE business_id=?',
        [businessId],
        connection,
      );
    if (current === plan) return;
    if (onStripe) await validatePlanPrices(plan);
    const periodEnd = account.period_end ? new Date(account.period_end) : null;
    const waits =
      isSubscription(current) &&
      isPaying(account.subscription_status) &&
      periodEnd !== null &&
      periodEnd.getTime() > Date.now() &&
      (!isSubscription(plan) || (current === 'yearly' && plan === 'monthly'));
    if (waits) {
      const scheduleId = onStripe ? await scheduleSubscription(account, plan) : null;
      await mutate(
        'UPDATE billing_accounts SET next_plan=?,plan_schedule_id=? WHERE business_id=?',
        [plan, scheduleId, businessId],
        connection,
      );
      await planEvent(connection, businessId, 'plan_scheduled', {
        from: current,
        to: plan,
        at: periodEnd.toISOString(),
      });
      return;
    }
    const freeWeek = isSubscription(plan) && !account.trial_used_at && onStripe;
    if (onStripe) await moveSubscription(account, plan, freeWeek);
    await applyPlan(connection, account, plan, freeWeek);
  });
}

/** Switches booked for the end of a paid period, once it's passed. The worker runs this. */
export async function applyDuePlanChanges(): Promise<void> {
  const due = await rows(
    'SELECT business_id FROM billing_accounts WHERE next_plan IS NOT NULL AND (period_end IS NULL OR period_end<=UTC_TIMESTAMP(3)) LIMIT 50',
  );
  for (const item of due)
    await transaction(async (connection) => {
      const account = await ensureBillingAccount(String(item.business_id), connection);
      if (!PLANS.includes(account.next_plan)) return;
      // Stripe's schedule has already moved the subscription; this records it here.
      await applyPlan(connection, account, account.next_plan as Plan, false);
    });
}

billingRouter.post('/billing/portal', async (req, res) => {
  await consumeAuthRateLimit(`billing-portal:${owner(req).businessId}`, 20, 3600000);
  await recordRequestEvent(req, owner(req).businessId, 'billing_portal_opened');
  z.object({})
    .strict()
    .parse(req.body ?? {});
  if (billingProvider() === 'local') {
    res.json(ok({ url: `${appOrigin()}/app/settings` }));
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
    return_url: `${appOrigin()}/app/settings`,
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
    'SELECT business_id,plan FROM billing_accounts WHERE stripe_customer_id=?',
    [customerId],
  );
  if (!account) return;
  const stripe = stripeClient();
  // Read current provider state instead of applying event snapshots; event delivery order is not authoritative.
  const subscriptions = (
    await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  ).data;
  const current = [...subscriptions].sort((a, b) => {
    const score = (status: string) =>
      status === 'active' ? 3 : status === 'trialing' ? 2 : status === 'past_due' ? 1 : 0;
    return score(b.status) - score(a.status) || b.created - a.created;
  })[0];
  // Every paying subscription has a price on the quote meter. A yearly checkout starts without
  // one, so it's added here, before the account is marked paying and quotes can go out.
  if (current && isPaying(current.status) && PLANS.includes(account.plan) && !meteredItem(current))
    await stripe.subscriptions.update(
      current.id,
      { items: [{ price: planPrices(account.plan as Plan).metered }], proration_behavior: 'none' },
      { idempotencyKey: `quotient-usage-price:${current.id}` },
    );
  await transaction(async (connection) => {
    await rows(
      'SELECT business_id FROM billing_accounts WHERE business_id=? FOR UPDATE',
      [account.business_id],
      connection,
    );
    const periodEnd = current ? paidPeriodEnd(current) : undefined;
    // The first card is when their first subscription started, kept once it's known.
    const paying = current && isPaying(current.status);
    await mutate(
      `UPDATE billing_accounts SET stripe_subscription_id=?,subscription_status=?,cancel_at_period_end=?,period_end=?,last_reconciled_at=UTC_TIMESTAMP(3)${current?.status === 'trialing' ? ',trial_used_at=COALESCE(trial_used_at,UTC_TIMESTAMP(3))' : ''}${paying ? ',card_added_at=COALESCE(card_added_at,?)' : ''} WHERE business_id=?`,
      [
        current?.id ?? null,
        current?.status ?? 'cancelled',
        current?.cancel_at_period_end ?? false,
        periodEnd ? new Date(periodEnd * 1000) : null,
        ...(paying
          ? [new Date(Math.min(...subscriptions.map((item) => item.created)) * 1000)]
          : []),
        account.business_id,
      ],
      connection,
    );
    if (current?.status === 'active' || current?.status === 'trialing')
      await recordMilestone(connection, String(account.business_id), 'billing_active');
  });
}

/**
 * Sends one fee to Stripe, once. A delivered quote counts one on the quote meter, and the price on
 * the subscription makes it $2 or $1. An accepted quote's fee goes on the next invoice as a line of
 * its own, since 1% of a job isn't a price per quote.
 */
export async function dispatchFee(usageId: string): Promise<void> {
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
      throw new Error('Fee dispatch requires manual reconciliation before another attempt.');
    await mutate(
      'UPDATE quote_usage SET dispatch_started_at=COALESCE(dispatch_started_at,UTC_TIMESTAMP(3)) WHERE id=?',
      [usageId],
      connection,
    );
    return usage;
  });
  if (!item) return;
  if (billingProvider() === 'stripe') {
    if (!item.stripe_customer_id) throw new Error('A fee has no billing customer.');
    if (item.charge === 'accepted')
      await stripeClient().invoiceItems.create(
        {
          customer: item.stripe_customer_id,
          amount: Number(item.fee_cents),
          currency: 'usd',
          // A fee the first-month max cut short says so, or it reads as less than 1%.
          description: `Accepted quote for ${usd.format(Number(item.quote_value_cents) / 100)}${Number(item.waived_cents) > 0 ? ', up to your first-month max' : ''}`,
          metadata: { usageId, quoteId: String(item.quote_id) },
        },
        { idempotencyKey: `quotient-fee:${usageId}` },
      );
    else
      await stripeClient().billing.meterEvents.create(
        {
          event_name: process.env.STRIPE_METER_EVENT_NAME!,
          identifier: `quotient:${usageId}`,
          payload: { stripe_customer_id: item.stripe_customer_id, value: '1' },
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
