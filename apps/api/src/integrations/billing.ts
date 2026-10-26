import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { mutate, rows } from '../db.js';
import {
  assertBillingAccess,
  billingCounts,
  billingProvider,
  ensureBillingAccount,
  feeForQuote,
  stripeConfigured,
} from '../billing.js';
import { ApiError } from '../http.js';

export type QuoteDelivery = {
  businessId: string;
  quoteId: string;
  totalCents: number;
  currency: string;
  source: 'owner_review' | 'automatic' | 'playground';
  verifiedContact: boolean;
};

export function billingReadiness(): {
  configured: boolean;
  collectionEnabled: boolean;
  mode: 'local' | 'stripe';
  detail: string;
} {
  return {
    configured: billingProvider() === 'local' || stripeConfigured(),
    collectionEnabled: billingProvider() === 'stripe' && stripeConfigured(),
    mode: billingProvider(),
    detail:
      billingProvider() === 'local'
        ? 'Isolated local payment provider; no real payment is collected.'
        : 'Qualified quotes use the approved tariff, trial allowance, and monthly spending cap.',
  };
}

export function calculatePlatformFeeCents(
  totalCents: number,
  basisPoints: number,
  capCents?: number,
): number {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000 ||
    (capCents !== undefined && (!Number.isSafeInteger(capCents) || capCents < 0))
  ) {
    throw new Error('Fee inputs must be nonnegative integer cents and valid basis points.');
  }
  const raw = (BigInt(totalCents) * BigInt(basisPoints) + 5000n) / 10000n;
  const capped = capCents === undefined ? raw : raw > BigInt(capCents) ? BigInt(capCents) : raw;
  return Number(capped);
}

/** Call inside the same transaction that first exposes the approved quote to its customer. */
export async function recordQuoteDelivery(
  connection: PoolConnection,
  input: QuoteDelivery,
): Promise<boolean> {
  if (input.source === 'playground') return false;
  if (
    !Number.isSafeInteger(input.totalCents) ||
    input.totalCents < 0 ||
    !/^[A-Z]{3}$/.test(input.currency)
  ) {
    throw new Error('A delivered quote must have valid integer cents and an ISO currency code.');
  }
  const account = await ensureBillingAccount(input.businessId, connection);
  const [existing] = await rows(
    'SELECT id FROM quote_usage WHERE business_id=? AND quote_id=?',
    [input.businessId, input.quoteId],
    connection,
  );
  if (existing) return false;
  const [quote] = await rows(
    'SELECT * FROM quotes WHERE id=? AND business_id=? FOR UPDATE',
    [input.quoteId, input.businessId],
    connection,
  );
  if (
    !quote ||
    quote.status !== 'issued' ||
    Number(quote.total_cents) !== input.totalCents ||
    quote.currency !== input.currency
  )
    throw new ApiError(
      409,
      'DELIVERY_INVALID',
      'Only the issued quote snapshot can be recorded as delivered.',
    );
  const eligible = input.source === 'automatic' && input.verifiedContact;
  if (eligible && !quote.verified_contact)
    throw new ApiError(
      409,
      'CONTACT_NOT_VERIFIED',
      'Automatic quote delivery requires a verified contact.',
    );
  const counts = await billingCounts(input.businessId, connection);
  const trialCovered =
    eligible &&
    new Date(account.trial_ends_at).getTime() > Date.now() &&
    counts.automatic < Number(account.trial_quote_limit);
  if (eligible && !trialCovered) {
    const access = await assertBillingAccess(input.businessId, connection, input.totalCents);
    if (!access.canIssue)
      throw new ApiError(409, 'BILLING_LIMIT', access.reason || 'Billing is unavailable.');
  }
  const feeCents = eligible && !trialCovered ? feeForQuote(input.totalCents, account) : 0;
  const usageId = randomUUID();
  await mutate(
    `INSERT INTO quote_usage(id,business_id,quote_id,source,verified_contact,trial_covered,quote_value_cents,currency,fee_cents,fee_basis_points,minimum_fee_cents,maximum_fee_cents,tariff_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      usageId,
      input.businessId,
      input.quoteId,
      input.source,
      input.verifiedContact,
      trialCovered,
      input.totalCents,
      input.currency,
      feeCents,
      Number(account.fee_basis_points),
      Number(account.minimum_fee_cents),
      Number(account.maximum_fee_cents),
      account.tariff_version,
    ],
    connection,
  );
  await mutate(
    'INSERT IGNORE INTO usage_events(id,business_id,kind,quote_id,dedupe_key,metadata_json) VALUES (?,?,?,?,?,?)',
    [
      randomUUID(),
      input.businessId,
      'quote_delivered',
      input.quoteId,
      `quote:${input.quoteId}:delivered`,
      JSON.stringify({
        billable: feeCents > 0,
        source: input.source,
        totalCents: input.totalCents,
        currency: input.currency,
        feeCents,
        trialCovered,
        tariffVersion: account.tariff_version,
        usageId,
      }),
    ],
    connection,
  );
  if (feeCents > 0) {
    await mutate(
      `INSERT IGNORE INTO jobs (id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'billing_dispatch',?,?)`,
      [randomUUID(), input.businessId, JSON.stringify({ usageId }), `meter:${usageId}`],
      connection,
    );
  }
  return true;
}
