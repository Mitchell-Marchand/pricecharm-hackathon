import { randomUUID } from 'node:crypto';
import {
  billingProvider,
  ensureBillingAccount,
  feeForQuote,
  stripeConfigured,
} from '../billing.js';
import { mutate, rows, type Sql } from '../db.js';
import { ApiError } from '../http.js';

/**
 * Billing for quotes from the new customer chat. The first `trial_quote_limit` quotes a verified
 * customer receives are free, with no time limit. After that each one has a fee, whether it went
 * out on its own or the owner approved it. Owner tests and repeat sends are never billed.
 */
const LIVE_SOURCES = "('live_auto','live_owner')";

async function liveUsage(businessId: string, connection: Sql) {
  const [usage] = await rows(
    `SELECT COUNT(*) delivered,
    COALESCE(SUM(CASE WHEN created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01') THEN fee_cents ELSE 0 END),0) fees
    FROM quote_usage WHERE business_id=? AND source IN ${LIVE_SOURCES}`,
    [businessId],
    connection,
  );
  const [all] = await rows(
    "SELECT COALESCE(SUM(CASE WHEN created_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01') THEN fee_cents ELSE 0 END),0) fees FROM quote_usage WHERE business_id=?",
    [businessId],
    connection,
  );
  return { delivered: Number(usage.delivered), monthFees: Number(all.fees) };
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
  if (
    account.subscription_status !== 'active' ||
    (billingProvider() === 'stripe' && !stripeConfigured())
  )
    return {
      canSend: false,
      reason: 'Your free quotes are used up. Add a payment method to send more.',
    };
  if (
    billingProvider() === 'stripe' &&
    (!account.last_reconciled_at ||
      new Date(account.last_reconciled_at).getTime() < Date.now() - 86400000)
  )
    return { canSend: false, reason: 'We’re checking your billing. Try again in a few minutes.' };
  if (usage.monthFees + feeForQuote(quoteCents, account) > Number(account.spending_cap_cents))
    return {
      canSend: false,
      reason: 'You’ve reached your monthly spending limit. Raise it in billing to send more.',
    };
  return { canSend: true, trial: false };
}

/** Records one delivered quote, once. Call in the transaction that shows it to the customer. */
export async function recordLiveDelivery(
  connection: Sql,
  input: { businessId: string; quoteId: string; totalCents: number; sentBy: 'auto' | 'owner' },
): Promise<{ recorded: boolean; feeCents: number }> {
  const [existing] = await rows(
    'SELECT id FROM quote_usage WHERE business_id=? AND quote_id=?',
    [input.businessId, input.quoteId],
    connection,
  );
  if (existing) return { recorded: false, feeCents: 0 };
  const access = await liveBillingAccess(input.businessId, connection, input.totalCents);
  if (!access.canSend) throw new ApiError(409, 'BILLING_LIMIT', access.reason);
  const account = await ensureBillingAccount(input.businessId, connection);
  const feeCents = access.trial ? 0 : feeForQuote(input.totalCents, account);
  const usageId = randomUUID();
  await mutate(
    `INSERT INTO quote_usage(id,business_id,quote_id,source,verified_contact,trial_covered,quote_value_cents,currency,fee_cents,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      usageId,
      input.businessId,
      input.quoteId,
      input.sentBy === 'auto' ? 'live_auto' : 'live_owner',
      true,
      access.trial,
      input.totalCents,
      'USD',
      feeCents,
      Number(account.fee_basis_points),
      Number(account.minimum_fee_cents),
      Number(account.maximum_fee_cents),
      account.tariff_version,
    ],
    connection,
  );
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
  if (feeCents > 0)
    await mutate(
      `INSERT IGNORE INTO jobs (id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'billing_dispatch',?,?)`,
      [randomUUID(), input.businessId, JSON.stringify({ usageId }), `meter:${usageId}`],
      connection,
    );
  return { recorded: true, feeCents };
}
