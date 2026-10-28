import { Router } from 'express';
import { z } from 'zod';
import { hashToken } from '../auth.js';
import { rows, transaction, type Sql } from '../db.js';
import { ApiError, ok, rateLimit } from '../http.js';
import { json, type Row } from '../models.js';
import type { Quote } from '../practice/types.js';
import { describeSpec, type JobSpec } from '../pricing/spec.js';
import { sendWaitingQuote } from './owner.js';
import { recordRequestEvent, requestSession } from '../metrics.js';

/**
 * The one-tap link in a "needs your OK" email. Whoever has it can see that one quote and send it
 * as it is, without signing in, until it runs out. Changing, declining or anything else needs the
 * owner's dashboard.
 */
export const approveLinkRouter = Router();

const linkInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

/** The quote this link was made for. A wrong or old token says so, and nothing more. */
async function linkedQuote(quoteId: string, token: string, connection?: Sql) {
  const [quote] = await rows(
    `SELECT q.*,c.customer_name,c.service_name,c.source,c.spec_json,b.name AS business_name
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id JOIN businesses b ON b.id=q.business_id
     WHERE q.id=? AND q.approve_token_hash=?${connection ? ' FOR UPDATE' : ''}`,
    [quoteId, hashToken(token)],
    connection,
  );
  if (!quote)
    throw new ApiError(
      404,
      'LINK_INVALID',
      'This link doesn’t work. Open the quote from your dashboard instead.',
    );
  if (new Date(quote.approve_token_expires_at).getTime() <= Date.now())
    throw new ApiError(
      410,
      'LINK_EXPIRED',
      'This link has run out. Open the quote from your dashboard to approve it.',
    );
  return quote;
}

/** What the owner needs to decide: the quote card, the job, and why it waited for them. */
function linkView(quote: Row) {
  const reasons = json<{ passed: boolean; detail: string }[]>(quote.checks_json, [])
    .filter((check) => !check.passed && check.detail)
    .map((check) => check.detail);
  return {
    quoteId: String(quote.id),
    business: String(quote.business_name),
    customer:
      String(quote.customer_name || '')
        .trim()
        .split(/\s+/)[0] || 'A customer',
    serviceName: String(quote.service_name || ''),
    /** Waiting for the owner, declined from the dashboard, or already with the customer. */
    status:
      quote.status === 'review'
        ? ('waiting' as const)
        : quote.status === 'declined'
          ? ('declined' as const)
          : ('sent' as const),
    totalCents: Number(quote.total_cents),
    card: json<Quote>(quote.quote_json, {} as Quote),
    details: describeSpec(json<JobSpec | null>(quote.spec_json, null)),
    reasons: reasons.length ? reasons : [String(quote.review_reason || '')].filter(Boolean),
    expiresAt: new Date(quote.approve_token_expires_at).toISOString(),
  };
}

// The token goes in the body, not the address, so it stays out of logs.
approveLinkRouter.post('/approve/:id/view', rateLimit(30, 15 * 60_000), async (req, res) => {
  const quoteId = z.uuid().parse(req.params.id);
  const { token } = linkInput.parse(req.body);
  const quote = await linkedQuote(quoteId, token);
  await recordRequestEvent(
    req,
    String(quote.business_id),
    'approve_link_opened',
    { status: String(quote.status) },
    { ref: quoteId },
  );
  res.json(ok(linkView(quote)));
});

/** Sends the quote as it is. The only thing this link can change. */
approveLinkRouter.post('/approve/:id', rateLimit(30, 15 * 60_000), async (req, res) => {
  const quoteId = z.uuid().parse(req.params.id);
  const { token } = linkInput.parse(req.body);
  await transaction(async (connection) =>
    sendWaitingQuote(connection, await linkedQuote(quoteId, token, connection), null, undefined, {
      channel: 'email',
      session: requestSession(req),
    }),
  );
  res.json(ok(linkView(await linkedQuote(quoteId, token))));
});
