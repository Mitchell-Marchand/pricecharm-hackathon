import { randomUUID } from 'node:crypto';
import {
  billingProvider,
  ensureBillingAccount,
  feeForQuote,
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
 * - $2 for each quote a verified customer receives;
 * - 1% of each quote a customer accepts, charged when they accept;
 * - a subscription that covers a set number of quotes a month, then a fee for each one past it.
 * A payment method has to be on file first. An account can have `trial_quote_limit` free quotes
 * before that (none by default). Owner tests and repeat sends are never billed.
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
      reason: 'Add a payment method in Settings so your quotes can go out.',
    };
  if (
    billingProvider() === 'stripe' &&
    (!account.last_reconciled_at ||
      new Date(account.last_reconciled_at).getTime() < Date.now() - 86400000)
  )
    return { canSend: false, reason: 'We’re checking your billing. Try again in a few minutes.' };
  // On the accepted-quote plan the fee comes later, so the cap allows for it in case they say yes.
  const plan = account.plan as Plan;
  const fee =
    plan === 'per_accepted'
      ? feeForQuote(quoteCents, account)
      : deliveryFee(plan, account, usage.covered);
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

/** Records one delivered quote, once. Call in the transaction that shows it to the customer. */
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
  const feeCents = access.trial || !plan ? 0 : deliveryFee(plan, account, usage.covered);
  const usageId = await insertUsage(connection, account, {
    businessId: input.businessId,
    quoteId: input.quoteId,
    charge: 'delivered',
    source: input.sentBy === 'auto' ? 'live_auto' : 'live_owner',
    trial: access.trial,
    totalCents: input.totalCents,
    feeCents,
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
        trialCovered: access.trial,
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
    plan: Plan | null;
  },
) {
  const usageId = randomUUID();
  await mutate(
    `INSERT INTO quote_usage(id,business_id,quote_id,charge,plan,source,verified_contact,trial_covered,quote_value_cents,currency,fee_cents,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      usageId,
      input.businessId,
      input.quoteId,
      input.charge,
      input.plan,
      input.source,
      true,
      input.trial,
      input.totalCents,
      'USD',
      input.feeCents,
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
    "SELECT plan,trial_covered FROM quote_usage WHERE business_id=? AND quote_id=? AND charge='delivered'",
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
  const account = await ensureBillingAccount(input.businessId, connection);
  // The terms it was delivered under, even if the owner has since moved plans.
  const terms = planTariff('per_accepted');
  const feeCents = feeForQuote(input.totalCents, {
    fee_basis_points: terms.basisPoints,
    minimum_fee_cents: terms.minimumFeeCents,
    maximum_fee_cents: terms.maximumFeeCents,
  });
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
      plan: 'per_accepted',
    },
  );
  return { recorded: true, feeCents };
}
