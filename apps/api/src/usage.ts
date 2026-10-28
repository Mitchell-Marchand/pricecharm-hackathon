import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { hashingSecret } from './config.js';
import { mutate, rows, transaction } from './db.js';
import { runWithAiUsage, aiMode, type AiFailure, type AiUsage } from './ai/index.js';
import { ApiError } from './http.js';
import { consumeAuthRateLimit } from './verification.js';
import { recordEvent } from './metrics.js';

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

export function draftIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('draft-start', ip, day);
  if (!fingerprint) throw new ApiError(503, 'SETUP_UNAVAILABLE', 'Setup is unavailable right now.');
  return `draft-start:${day}:${fingerprint}`;
}

export function demoIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('public-demo', ip, day);
  if (!fingerprint) throw new ApiError(503, 'DEMO_UNAVAILABLE', 'The live demo is unavailable.');
  return `public-demo:${day}:${fingerprint}`;
}

export function customerIpBudgetKey(ip: string, day: string): string {
  const fingerprint = ipFingerprint('customer-chat', ip, day);
  if (!fingerprint)
    throw new ApiError(503, 'CUSTOMER_CHAT_UNAVAILABLE', 'Quote chat is unavailable right now.');
  return `customer-chat:${day}:${fingerprint}`;
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
        await recordEvent(undefined, businessId, 'ai_call', {
          operation: usage.operation,
          provider: usage.provider,
          model: usage.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          ms: usage.durationMs ?? null,
        });
      },
      failed: async (failure: AiFailure) => {
        await recordEvent(undefined, businessId, 'ai_failed', {
          operation: failure.operation,
          provider: failure.provider,
          model: failure.model,
          reason: failure.reason,
          ms: failure.durationMs,
        });
      },
    },
    task,
  );
}

/** Owner work: setup, past jobs, practice and their own test chats. */
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

/** AI calls one demo chat may make: enough for a full conversation and its quote. */
export const DEMO_CHAT_CALLS = 12;

/**
 * The public demo on the marketing site. Anyone can use it, so it gets the tightest limits: a
 * small daily pool inside the app-wide one, a daily cap per visitor and a cap per chat. It never
 * touches a business's allowance. Unlike the others, the caps apply in demo mode too, since they
 * guard against abuse as much as spending.
 */
export async function reserveDemoAiCall(input: { sessionId: string; ip: string }) {
  const appLimit = dailyLimit('AI_DAILY_APP_LIMIT', 1000);
  const demoLimit = Math.min(dailyLimit('AI_DAILY_DEMO_LIMIT', 300), appLimit);
  const ipLimit = dailyLimit('AI_DAILY_DEMO_IP_LIMIT', 40);
  await transaction(async (connection) => {
    await mutate(
      'INSERT INTO ai_daily_budgets (budget_day,total_reserved) VALUES (UTC_DATE(),0) ON DUPLICATE KEY UPDATE total_reserved = total_reserved',
      [],
      connection,
    );
    const [budget] = await rows(
      "SELECT total_reserved,demo_reserved,DATE_FORMAT(budget_day,'%Y-%m-%d') AS day FROM ai_daily_budgets WHERE budget_day = UTC_DATE() FOR UPDATE",
      [],
      connection,
    );
    if (Number(budget.total_reserved) >= appLimit || Number(budget.demo_reserved) >= demoLimit)
      throw new ApiError(429, 'DEMO_BUSY', 'The live demo is busy right now.');
    const limits: [string, number, number, string, string][] = [
      [
        demoIpBudgetKey(input.ip, String(budget.day)),
        ipLimit,
        24 * 60 * 60_000,
        'DEMO_DAILY_LIMIT',
        'You’ve tried the live demo a lot today. Come back tomorrow, or set up your own.',
      ],
      [
        `public-demo-chat:${input.sessionId}`,
        DEMO_CHAT_CALLS,
        2 * 60 * 60_000,
        'DEMO_CHAT_LIMIT',
        'This demo chat has gone as far as it can. Start over to try again.',
      ],
    ];
    for (const [key, maximum, windowMs, code, message] of limits) {
      try {
        await consumeAuthRateLimit(key, maximum, windowMs, connection);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'IDENTITY_RATE_LIMIT')
          throw new ApiError(429, code, message);
        throw error;
      }
    }
    await mutate(
      'UPDATE ai_daily_budgets SET total_reserved = total_reserved + 1, demo_reserved = demo_reserved + 1 WHERE budget_day = UTC_DATE()',
      [],
      connection,
    );
  });
}

/** A demo AI call: reserved first, and its token use logged, since there's no business to bill. */
export function withDemoAiUsage<T>(
  input: { sessionId: string; ip: string },
  task: () => Promise<T>,
): Promise<T> {
  return reserveDemoAiCall(input).then(() =>
    runWithAiUsage(
      {
        businessId: 'public-demo',
        conversationId: input.sessionId,
        record: async (usage: AiUsage) => {
          console.info(JSON.stringify({ event: 'demo_ai_call', ...usage }));
        },
      },
      task,
    ),
  );
}
