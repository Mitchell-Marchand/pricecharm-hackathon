import { randomUUID } from 'node:crypto';
import {
  billingProvider,
  ensureBillingAccount,
  feeForQuote,
  firstMonth,
  freeUnderCode,
  getBilling,
  isPaying,
  isSubscription,
  PLANS,
  planTariff,
  publicPricing,
  stripeConfigured,
  type Plan,
} from '../billing.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { ApiError } from '../http.js';

/**
 * Billing for quotes from the customer chat, on the plan the owner chose:
 * - $2 for each quote shown to a customer, whether or not they answer it;
 * - 1% of each quote a customer accepts, charged when they accept;
 * - a subscription that covers a set number of quotes a month, then a fee for each one past it.
 * A payment method has to be on file first. An account can have `trial_quote_limit` free quotes
 * before that (none by default). For 30 days after the first card, quote fees on any plan stop at
 * the first-month max, and quotes past it still go out. A code makes the days after the first
 * card free instead, usually 30: quotes shown then aren't charged, even when accepted later, and
 * what they would have cost is kept as waived. Owner tests and repeat sends are never billed.
 */
const LIVE_SOURCES = "('live_auto','live_owner')";
const MONTH_START = "DATE_FORMAT(UTC_DATE(),'%Y-%m-01')";

async function liveUsage(businessId: string, connection: Sql) {
  const [usage] = await rows(
    `SELECT COUNT(*) delivered,
    COALESCE(SUM(created_at>=${MONTH_START} AND plan IN ('monthly','yearly')),0) covered
    FROM quote_usage WHERE business_id=? AND source IN ${LIVE_SOURCES}`,
    [businessId],
    connection,
  );
  const [all] = await rows(
    `SELECT COALESCE(SUM(CASE WHEN created_at>=${MONTH_START} THEN fee_cents ELSE 0 END),0) fees FROM quote_usage WHERE business_id=?`,
    [businessId],
    connection,
  );
  return {
    delivered: Number(usage.delivered),
    /** Quotes delivered on the subscription this month, against its allowance. */
    covered: Number(usage.covered),
    monthFees: Number(all.fees),
  };
}

/** What delivering this quote costs on the plan. Accepted-quote fees come later, if at all. */
function deliveryFee(plan: Plan, account: Parameters<typeof feeForQuote>[1], covered: number) {
  if (plan === 'per_quote') return Number(account.minimum_fee_cents);
  if (isSubscription(plan))
    return covered >= publicPricing().subscription.includedQuotes
      ? Number(account.minimum_fee_cents)
      : 0;
  return 0;
}

/**
 * A fee under the first-month max, and what the max let off. A delivered quote's fee counts one
 * on the quote meter, so it's charged whole or not at all. An accepted quote's fee is its own line
 * on the invoice, so it's cut to what's left.
 */
async function underFirstMonthMax(
  connection: Sql,
  account: Awaited<ReturnType<typeof ensureBillingAccount>>,
  feeCents: number,
  charge: 'delivered' | 'accepted',
) {
  const room = (await firstMonth(account, connection))?.roomCents;
  const charged =
    room === undefined || feeCents <= room ? feeCents : charge === 'accepted' ? room : 0;
  return { feeCents: charged, waivedCents: feeCents - charged };
}

/** Whether one more quote can go out, and why not when it can't. Locks the billing account. */
export async function liveBillingAccess(
  businessId: string,
  connection: Sql,
  quoteCents: number,
): Promise<{ canSend: true; trial: boolean } | { canSend: false; reason: string }> {
  const account = await ensureBillingAccount(businessId, connection);
  const usage = await liveUsage(businessId, connection);
  if (usage.delivered < Number(account.trial_quote_limit)) return { canSend: true, trial: true };
  if (!PLANS.includes(account.plan))
    return { canSend: false, reason: 'Choose a plan so your quotes can go out.' };
  if (
    !isPaying(account.subscription_status) ||
    (billingProvider() === 'stripe' && !stripeConfigured())
  )
    return {
      canSend: false,
      // Stripe's "canceled" means they had a plan and it ended; their card may still be there.
      reason:
        account.subscription_status === 'canceled'
          ? 'Your plan ended. Choose a plan in Settings to start it again.'
          : 'Add a payment method in Settings so your quotes can go out.',
    };
  if (
    billingProvider() === 'stripe' &&
    (!account.last_reconciled_at ||
      new Date(account.last_reconciled_at).getTime() < Date.now() - 86400000)
  )
    return { canSend: false, reason: 'We’re checking your billing. Try again in a few minutes.' };
  // In a code's free days nothing is charged, so no spending limit is reached.
  if (freeUnderCode(account)) return { canSend: true, trial: false };
  // On the accepted-quote plan the fee comes later, so the cap allows for it in case they say yes.
  const plan = account.plan as Plan;
  const { feeCents: fee } = await underFirstMonthMax(
    connection,
    account,
    plan === 'per_accepted'
      ? feeForQuote(quoteCents, account)
      : deliveryFee(plan, account, usage.covered),
    plan === 'per_accepted' ? 'accepted' : 'delivered',
  );
  if (usage.monthFees + fee > Number(account.spending_cap_cents))
    return {
      canSend: false,
      reason: 'You’ve reached your monthly spending limit. Raise it in billing to send more.',
    };
  return { canSend: true, trial: false };
}

/** What the owner's billing settings show, counted the way live quotes are billed. */
export async function liveBillingSummary(businessId: string) {
  const billing = await getBilling(businessId);
  return transaction(async (connection) => {
    const account = await ensureBillingAccount(businessId, connection);
    const usage = await liveUsage(businessId, connection);
    const access = await liveBillingAccess(businessId, connection, 0);
    const [business] = await rows(
      'SELECT link_on,deployed_at FROM businesses WHERE id=?',
      [businessId],
      connection,
    );
    const quoteLimit = Number(account.trial_quote_limit);
    return {
      ...billing,
      trial: { quoteLimit, remainingQuotes: Math.max(0, quoteLimit - usage.delivered) },
      deliveredQuotes: usage.delivered,
      /** Quotes this month counted against the subscription's allowance. */
      coveredThisMonth: usage.covered,
      canSend: access.canSend,
      reason: access.canSend ? '' : access.reason,
      /** Whether the quote link takes requests: on once the owner deploys, off while paused. */
      linkOn: Boolean(business?.link_on),
      deployed: Boolean(business?.deployed_at),
    };
  });
}

/**
 * Records one quote shown to a customer, once. Call it in the transaction that shows it.
 */
export async function recordLiveDelivery(
  connection: Sql,
  input: { businessId: string; quoteId: string; totalCents: number; sentBy: 'auto' | 'owner' },
): Promise<{ recorded: boolean; feeCents: number }> {
  const [existing] = await rows(
    "SELECT id FROM quote_usage WHERE business_id=? AND quote_id=? AND charge='delivered'",
    [input.businessId, input.quoteId],
    connection,
  );
  if (existing) return { recorded: false, feeCents: 0 };
  const access = await liveBillingAccess(input.businessId, connection, input.totalCents);
  if (!access.canSend) throw new ApiError(409, 'BILLING_LIMIT', access.reason);
  const account = await ensureBillingAccount(input.businessId, connection);
  const plan = PLANS.includes(account.plan) ? (account.plan as Plan) : null;
  const usage = await liveUsage(input.businessId, connection);
  const fee = access.trial || !plan ? 0 : deliveryFee(plan, account, usage.covered);
  const free = freeUnderCode(account);
  const { feeCents, waivedCents } = free
    ? { feeCents: 0, waivedCents: fee }
    : await underFirstMonthMax(connection, account, fee, 'delivered');
  const usageId = await insertUsage(connection, account, {
    businessId: input.businessId,
    quoteId: input.quoteId,
    charge: 'delivered',
    source: input.sentBy === 'auto' ? 'live_auto' : 'live_owner',
    trial: access.trial,
    totalCents: input.totalCents,
    feeCents,
    waivedCents,
    plan,
  });
  await mutate(
    'INSERT IGNORE INTO usage_events(id,business_id,kind,dedupe_key,metadata_json) VALUES (?,?,?,?,?)',
    [
      randomUUID(),
      input.businessId,
      'quote_delivered',
      `live-quote:${input.quoteId}:delivered`,
      JSON.stringify({
        liveQuoteId: input.quoteId,
        billable: feeCents > 0,
        sentBy: input.sentBy,
        totalCents: input.totalCents,
        feeCents,
        waivedCents,
        trialCovered: access.trial,
        ...(free ? { code: String(account.promo_code) } : {}),
        usageId,
      }),
    ],
    connection,
  );
  return { recorded: true, feeCents };
}

/** One charge for a quote: when it's delivered, or when the customer accepts it. */
async function insertUsage(
  connection: Sql,
  account: Awaited<ReturnType<typeof ensureBillingAccount>>,
  input: {
    businessId: string;
    quoteId: string;
    charge: 'delivered' | 'accepted';
    source: string;
    trial: boolean;
    totalCents: number;
    feeCents: number;
    /** What the first-month max let off. */
    waivedCents: number;
    plan: Plan | null;
  },
) {
  const usageId = randomUUID();
  await mutate(
    `INSERT INTO quote_usage(id,business_id,quote_id,charge,plan,source,verified_contact,trial_covered,quote_value_cents,currency,fee_cents,waived_cents,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      usageId,
      input.businessId,
      input.quoteId,
      input.charge,
      input.plan,
      input.source,
      // Customers' contact details aren't checked with a code anymore.
      false,
      input.trial,
      input.totalCents,
      account.currency,
      input.feeCents,
      input.waivedCents,
      Number(account.fee_basis_points),
      Number(account.minimum_fee_cents),
      Number(account.maximum_fee_cents),
      account.tariff_version,
    ],
    connection,
  );
  if (input.feeCents > 0)
    await mutate(
      `INSERT IGNORE INTO jobs (id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'billing_dispatch',?,?)`,
      [randomUUID(), input.businessId, JSON.stringify({ usageId }), `meter:${usageId}`],
      connection,
    );
  return usageId;
}

/**
 * A customer accepted a quote. On the accepted-quote plan, that's when it's charged: 1% of the
 * quote, within the plan's minimum and maximum. It follows the plan the quote was delivered on,
 * so switching plans in between never charges it twice or not at all. Once per quote.
 */
export async function recordAcceptance(
  connection: Sql,
  input: { businessId: string; quoteId: string; totalCents: number },
): Promise<{ recorded: boolean; feeCents: number }> {
  const [delivered] = await rows(
    "SELECT plan,trial_covered,created_at FROM quote_usage WHERE business_id=? AND quote_id=? AND charge='delivered'",
    [input.businessId, input.quoteId],
    connection,
  );
  if (delivered?.plan !== 'per_accepted' || delivered.trial_covered)
    return { recorded: false, feeCents: 0 };
  const [already] = await rows(
    "SELECT id FROM quote_usage WHERE business_id=? AND quote_id=? AND charge='accepted'",
    [input.businessId, input.quoteId],
    connection,
  );
  if (already) return { recorded: false, feeCents: 0 };
  // A yes is never turned away over the owner's billing, and past their spending limit, or with
  // their card failing since the quote showed, it isn't charged.
  const access = await liveBillingAccess(input.businessId, connection, input.totalCents);
  const account = await ensureBillingAccount(input.businessId, connection);
  // The terms it was delivered under, even if the owner has since moved plans.
  const terms = planTariff('per_accepted', account.currency);
  const fee = access.canSend
    ? feeForQuote(input.totalCents, {
        fee_basis_points: terms.basisPoints,
        minimum_fee_cents: terms.minimumFeeCents,
        maximum_fee_cents: terms.maximumFeeCents,
      })
    : 0;
  // Shown in a code's free days, it stays free, however long the customer took to say yes.
  const { feeCents, waivedCents } = freeUnderCode(account, new Date(delivered.created_at))
    ? { feeCents: 0, waivedCents: fee }
    : await underFirstMonthMax(connection, account, fee, 'accepted');
  await insertUsage(
    connection,
    {
      ...account,
      fee_basis_points: terms.basisPoints,
      minimum_fee_cents: terms.minimumFeeCents,
      maximum_fee_cents: terms.maximumFeeCents,
      tariff_version: terms.version,
    } as typeof account,
    {
      businessId: input.businessId,
      quoteId: input.quoteId,
      charge: 'accepted',
      source: 'live_accepted',
      trial: false,
      totalCents: input.totalCents,
      feeCents,
      waivedCents,
      plan: 'per_accepted',
    },
  );
  return { recorded: true, feeCents };
}
