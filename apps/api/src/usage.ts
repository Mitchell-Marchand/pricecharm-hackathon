import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolConnection } from 'mysql2/promise';
import { hashingSecret } from './config.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { runWithAiUsage, aiMode, type AiUsage } from './ai/index.js';
import { ApiError } from './http.js';
import { iso, json } from './models.js';
import { consumeAuthRateLimit } from './verification.js';

function dailyLimit(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 && value < 1_000_000 ? value : fallback;
}

/** The database stores a daily keyed fingerprint, never a visitor's address. */
function ipFingerprint(scope: string, ip: string, day: string): string | undefined {
  const key = hashingSecret();
  if (!key) return undefined;
  const context = createHmac('sha256', key).update(`quotient-${scope}-ip-v1`).digest();
  const address = ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return createHmac('sha256', context)
    .update(`${day}:${isIP(address) ? address : 'unavailable'}`)
    .digest('hex');
}

export function guestIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('guest-preview', ip, day);
  if (!fingerprint)
    throw new ApiError(
      503,
      'GUEST_PREVIEW_UNAVAILABLE',
      'Free previews are unavailable right now.',
    );
  return `guest-preview:${day}:${fingerprint}`;
}

export function draftIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('draft-start', ip, day);
  if (!fingerprint) throw new ApiError(503, 'SETUP_UNAVAILABLE', 'Setup is unavailable right now.');
  return `draft-start:${day}:${fingerprint}`;
}

export function customerIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('customer-chat', ip, day);
  if (!fingerprint)
    throw new ApiError(503, 'CUSTOMER_CHAT_UNAVAILABLE', 'Quote chat is unavailable right now.');
  return `customer-chat:${day}:${fingerprint}`;
}

/** Caller inserts/locks the preview in this transaction, then commits before any provider call. */
export async function reserveGuestAiCall(
  input: { previewId: string; ip: string },
  connection: PoolConnection,
): Promise<void> {
  const [preview] = await rows(
    'SELECT reserved_at,status,expires_at FROM guest_previews WHERE id=? FOR UPDATE',
    [input.previewId],
    connection,
  );
  if (!preview || new Date(preview.expires_at).getTime() <= Date.now())
    throw new ApiError(410, 'GUEST_PREVIEW_EXPIRED', 'This preview has expired.');
  if (preview.reserved_at) return;
  if (preview.status !== 'processing')
    throw new ApiError(409, 'GUEST_PREVIEW_CHANGED', 'This preview is no longer being created.');
  await mutate(
    'INSERT INTO ai_daily_budgets (budget_day,total_reserved,guest_reserved) VALUES (UTC_DATE(),0,0) ON DUPLICATE KEY UPDATE total_reserved=total_reserved',
    [],
    connection,
  );
  const [budget] = await rows(
    "SELECT total_reserved,guest_reserved,DATE_FORMAT(budget_day,'%Y-%m-%d') AS day FROM ai_daily_budgets WHERE budget_day=UTC_DATE() FOR UPDATE",
    [],
    connection,
  );
  const appLimit = dailyLimit('AI_DAILY_APP_LIMIT', 1000);
  const guestLimit = Math.min(dailyLimit('GUEST_PREVIEW_DAILY_APP_LIMIT', 50), appLimit);
  if (Number(budget.total_reserved) >= appLimit || Number(budget.guest_reserved) >= guestLimit)
    throw new ApiError(
      429,
      'GUEST_PREVIEW_CAPACITY',
      'Free previews are at capacity today. Please try again later.',
    );
  try {
    await consumeAuthRateLimit(
      guestIpBudgetKey(input.ip, String(budget.day)),
      Math.min(dailyLimit('GUEST_PREVIEW_DAILY_IP_LIMIT', 3), guestLimit),
      24 * 60 * 60_000,
      connection,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'IDENTITY_RATE_LIMIT')
      throw new ApiError(
        429,
        'GUEST_PREVIEW_LIMIT',
        'You’ve reached today’s free preview limit. Please try again tomorrow.',
      );
    throw error;
  }
  await mutate(
    'UPDATE ai_daily_budgets SET total_reserved=total_reserved+1,guest_reserved=guest_reserved+1 WHERE budget_day=UTC_DATE()',
    [],
    connection,
  );
  await mutate(
    'UPDATE guest_previews SET reserved_at=UTC_TIMESTAMP(3),reservation_day=UTC_DATE() WHERE id=? AND reserved_at IS NULL',
    [input.previewId],
    connection,
  );
}

export async function withGuestAiUsage<T>(
  input: { previewId: string },
  task: () => Promise<T>,
): Promise<T> {
  const [preview] = await rows(
    "SELECT id FROM guest_previews WHERE id=? AND status='processing' AND reserved_at IS NOT NULL AND expires_at>UTC_TIMESTAMP(3) AND usage_json IS NULL",
    [input.previewId],
  );
  if (!preview)
    throw new ApiError(409, 'GUEST_PREVIEW_CHANGED', 'This preview is no longer being created.');
  return runWithAiUsage(
    {
      previewId: input.previewId,
      record: async (usage: AiUsage) => {
        const result = await mutate(
          "UPDATE guest_previews SET usage_json=? WHERE id=? AND status='processing' AND reserved_at IS NOT NULL AND usage_json IS NULL",
          [JSON.stringify(usage), input.previewId],
        );
        if (result.affectedRows !== 1)
          throw new ApiError(
            409,
            'GUEST_PREVIEW_CHANGED',
            'This preview is no longer being created.',
          );
      },
    },
    task,
  );
}

function recordBusinessAiUsage<T>(
  businessId: string,
  conversationId: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return runWithAiUsage(
    {
      businessId,
      conversationId,
      record: async (usage: AiUsage) => {
        await mutate(
          'INSERT INTO usage_events (id, business_id, kind, metadata_json) VALUES (?, ?, ?, ?)',
          [randomUUID(), businessId, 'ai_call', JSON.stringify({ ...usage, conversationId })],
        );
      },
    },
    task,
  );
}

/** Owner work: training, setup, imports, private tests. */
export function withAiUsage<T>(
  businessId: string,
  conversationId: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return (aiMode === 'demo' ? Promise.resolve() : reserveAiCall(businessId, conversationId)).then(
    () => recordBusinessAiUsage(businessId, conversationId, task),
  );
}

/** Customer chat on a public link. It has allowances of its own, so it can't use up the owner's. */
export function withCustomerAiUsage<T>(
  input: { businessId: string; sessionId: string; ip: string },
  task: () => Promise<T>,
): Promise<T> {
  return (aiMode === 'demo' ? Promise.resolve() : reserveCustomerAiCall(input)).then(() =>
    recordBusinessAiUsage(input.businessId, input.sessionId, task),
  );
}
export async function recordReviewedDelivery(
  businessId: string,
  quoteId: string,
  totalCents: number,
  currency: string,
  connection: Sql,
) {
  await mutate(
    'INSERT IGNORE INTO usage_events (id, business_id, kind, quote_id, dedupe_key, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
    [
      randomUUID(),
      businessId,
      'quote_delivered',
      quoteId,
      `quote:${quoteId}:delivered`,
      JSON.stringify({
        billable: false,
        source: 'owner_review',
        totalCents,
        currency,
        reason: 'Owner-reviewed quotes are excluded from autonomous usage billing.',
      }),
    ],
    connection,
  );
}
export async function getUsage(businessId: string) {
  const [counts] = await rows(
    "SELECT SUM(kind = 'ai_call') AS ai_calls, SUM(kind = 'quote_delivered' AND JSON_EXTRACT(metadata_json, '$.billable') = TRUE) AS billable_quotes FROM usage_events WHERE business_id = ?",
    [businessId],
  );
  const events = (
    await rows(
      'SELECT id, kind, quote_id, metadata_json, created_at FROM usage_events WHERE business_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
      [businessId],
    )
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    quoteId: row.quote_id,
    metadata: json(row.metadata_json, {}),
    createdAt: iso(row.created_at),
  }));
  return {
    billableQuotes: Number(counts?.billable_quotes || 0),
    aiCalls: Number(counts?.ai_calls || 0),
    events,
  };
}

/** Reserve before calling a provider, including attempts that later fail or time out. */
export async function reserveAiCall(businessId: string, conversationId: string | undefined) {
  const tenantLimit = dailyLimit('AI_DAILY_BUSINESS_LIMIT', 100);
  const appLimit = dailyLimit('AI_DAILY_APP_LIMIT', 1000);
  await transaction(async (connection) => {
    await mutate(
      'INSERT INTO ai_daily_budgets (budget_day,total_reserved) VALUES (UTC_DATE(),0) ON DUPLICATE KEY UPDATE total_reserved = total_reserved',
      [],
      connection,
    );
    // One durable lock serializes reservations across all workers and app replicas.
    const [budget] = await rows(
      'SELECT total_reserved FROM ai_daily_budgets WHERE budget_day = UTC_DATE() FOR UPDATE',
      [],
      connection,
    );
    if (Number(budget.total_reserved) >= appLimit)
      throw new ApiError(
        429,
        'AI_APP_BUDGET',
        'AI conversations are at capacity today. Please try again later.',
      );
    // A setup that hasn't become an account yet draws on a smaller pool, with a lifetime cap.
    const [business] = await rows(
      'SELECT status FROM businesses WHERE id = ?',
      [businessId],
      connection,
    );
    const draft = business?.status === 'draft';
    if (draft) {
      const [draftBudget] = await rows(
        'SELECT draft_reserved FROM ai_daily_budgets WHERE budget_day = UTC_DATE()',
        [],
        connection,
      );
      if (
        Number(draftBudget.draft_reserved) >=
        Math.min(dailyLimit('AI_DAILY_DRAFT_APP_LIMIT', 400), appLimit)
      )
        throw new ApiError(
          429,
          'SETUP_AI_CAPACITY',
          'Setup is busy right now. Your progress is saved, so please try again in a little while.',
        );
      const [used] = await rows(
        "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation'",
        [businessId],
        connection,
      );
      if (Number(used.count) >= dailyLimit('AI_DRAFT_LIFETIME_LIMIT', 150))
        throw new ApiError(
          429,
          'SETUP_AI_LIMIT',
          'This setup has used its AI allowance. Create your account to keep going.',
        );
    }
    const [tenant] = await rows(
      "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_reservation' AND created_at >= UTC_DATE()",
      [businessId],
      connection,
    );
    if (Number(tenant.count) >= tenantLimit)
      throw new ApiError(
        429,
        'AI_BUSINESS_BUDGET',
        'This workspace reached its daily AI conversation allowance. You can still review requests and manage pricing.',
      );
    await mutate(
      `UPDATE ai_daily_budgets SET total_reserved = total_reserved + 1${draft ? ', draft_reserved = draft_reserved + 1' : ''} WHERE budget_day = UTC_DATE()`,
      [],
      connection,
    );
    await mutate(
      'INSERT INTO usage_events (id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
      [
        randomUUID(),
        businessId,
        'ai_reservation',
        JSON.stringify({ conversationId: conversationId ?? null }),
      ],
      connection,
    );
  });
}

/**
 * Customer chat draws on three allowances besides the app-wide one: all customers together, each
 * business's customers, and each visitor's address. Owners keep whatever customers can't reach.
 */
export async function reserveCustomerAiCall(input: {
  businessId: string;
  sessionId: string;
  ip: string;
}) {
  const appLimit = dailyLimit('AI_DAILY_APP_LIMIT', 1000);
  const customerLimit = Math.min(dailyLimit('AI_DAILY_CUSTOMER_APP_LIMIT', 600), appLimit);
  const businessLimit = dailyLimit('AI_DAILY_BUSINESS_CUSTOMER_LIMIT', 200);
  const ipLimit = dailyLimit('AI_DAILY_CUSTOMER_IP_LIMIT', 60);
  await transaction(async (connection) => {
    await mutate(
      'INSERT INTO ai_daily_budgets (budget_day,total_reserved) VALUES (UTC_DATE(),0) ON DUPLICATE KEY UPDATE total_reserved = total_reserved',
      [],
      connection,
    );
    const [budget] = await rows(
      "SELECT total_reserved,customer_reserved,DATE_FORMAT(budget_day,'%Y-%m-%d') AS day FROM ai_daily_budgets WHERE budget_day = UTC_DATE() FOR UPDATE",
      [],
      connection,
    );
    if (
      Number(budget.total_reserved) >= appLimit ||
      Number(budget.customer_reserved) >= customerLimit
    )
      throw new ApiError(
        429,
        'AI_CUSTOMER_CAPACITY',
        'Quote chat is busy right now. Please try again later.',
      );
    const [business] = await rows(
      "SELECT COUNT(*) AS count FROM usage_events WHERE business_id = ? AND kind = 'ai_customer_reservation' AND created_at >= UTC_DATE()",
      [input.businessId],
      connection,
    );
    if (Number(business.count) >= businessLimit)
      throw new ApiError(
        429,
        'AI_BUSINESS_CUSTOMER_BUDGET',
        'This business has reached today’s chat limit. Please try again tomorrow.',
      );
    try {
      await consumeAuthRateLimit(
        customerIpBudgetKey(input.ip, String(budget.day)),
        ipLimit,
        24 * 60 * 60_000,
        connection,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'IDENTITY_RATE_LIMIT')
        throw new ApiError(
          429,
          'AI_CUSTOMER_IP_LIMIT',
          'You’ve reached today’s chat limit. Please try again tomorrow.',
        );
      throw error;
    }
    await mutate(
      'UPDATE ai_daily_budgets SET total_reserved = total_reserved + 1, customer_reserved = customer_reserved + 1 WHERE budget_day = UTC_DATE()',
      [],
      connection,
    );
    await mutate(
      'INSERT INTO usage_events (id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
      [
        randomUUID(),
        input.businessId,
        'ai_customer_reservation',
        JSON.stringify({ conversationId: input.sessionId }),
      ],
      connection,
    );
  });
}
