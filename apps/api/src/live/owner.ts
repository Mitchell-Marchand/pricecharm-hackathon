import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { mutate, rows, transaction } from '../db.js';
import { ApiError, ok, rateLimit } from '../http.js';
import { queueEmail } from '../integrations/email.js';
import { json } from '../models.js';
import { pricingProfile } from '../profile.js';
import { quoteDraftSchema, quoteTotal, type Quote } from '../practice/types.js';
import { owner } from '../auth.js';
import { liveBillingSummary } from './billing.js';
import { chatEmailLink, markSent } from './chat.js';

/** The owner's side of live quotes: the inbox, approving and editing, and settings. */
export const ownerQuotesRouter = Router();

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

const cardEdits = z.object(quoteDraftSchema.shape);

const FILTERS = {
  review: "q.status='review'",
  sent: "q.status='sent'",
  accepted: "q.status IN ('accepted','visit_requested')",
  all: '1=1',
} as const;

function listItem(row: Record<string, any>) {
  return {
    id: String(row.id),
    number: Number(row.number),
    status: String(row.status),
    customer: String(row.customer_name || 'A customer'),
    serviceName: String(row.service_name || ''),
    totalCents: Number(row.total_cents),
    reviewReason: String(row.review_reason || ''),
    test: row.source === 'test',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

ownerQuotesRouter.get('/app/home', async (req, res) => {
  const { businessId } = owner(req);
  const [counts] = await rows(
    `SELECT COALESCE(SUM(q.status='review'),0) review,
      COALESCE(SUM(q.status IN ('sent','accepted','visit_requested') AND q.sent_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) sent,
      COALESCE(SUM(q.status IN ('accepted') AND q.decided_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) accepted
      FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id WHERE q.business_id=? AND c.source<>'test'`,
    [businessId],
  );
  const waiting = await rows(
    `SELECT q.*,c.customer_name,c.service_name,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND q.status='review' ORDER BY q.created_at DESC LIMIT 10`,
    [businessId],
  );
  const [business] = await rows(
    'SELECT name,slug,auto_send,auto_send_limit_cents,website_domain FROM businesses WHERE id=?',
    [businessId],
  );
  res.json(
    ok({
      business: { name: business.name, slug: business.slug },
      counts: {
        needsOk: Number(counts.review),
        sentThisMonth: Number(counts.sent),
        acceptedThisMonth: Number(counts.accepted),
      },
      waiting: waiting.map(listItem),
      autoSend: Boolean(business.auto_send),
      autoSendLimitCents: Number(business.auto_send_limit_cents),
      websiteDomain: String(business.website_domain || ''),
    }),
  );
});

ownerQuotesRouter.get('/app/quotes', async (req, res) => {
  const { businessId } = owner(req);
  const filter = z
    .enum(['review', 'sent', 'accepted', 'all'])
    .default('all')
    .parse(req.query.filter ?? undefined);
  const items = await rows(
    `SELECT q.*,c.customer_name,c.service_name,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND ${FILTERS[filter]} ORDER BY q.created_at DESC LIMIT 200`,
    [businessId],
  );
  res.json(ok(items.map(listItem)));
});

async function quoteDetail(businessId: string, quoteId: string) {
  const [quote] = await rows(
    `SELECT q.*,c.customer_name,c.customer_email,c.service_name,c.source,c.summary,c.id AS chat_id
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id WHERE q.id=? AND q.business_id=?`,
    [quoteId, businessId],
  );
  if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
  const messages = await rows(
    'SELECT * FROM lead_messages WHERE chat_id=? ORDER BY created_at,id',
    [quote.chat_id],
  );
  const draft = json<{ reasoning?: string; confidence?: string }>(quote.draft_json, {});
  return {
    ...listItem(quote),
    customerEmail: quote.customer_email ? String(quote.customer_email) : null,
    summary: String(quote.summary || ''),
    card: json<Quote>(quote.quote_json, {} as Quote),
    reasoning: draft.reasoning ?? '',
    confidence: draft.confidence ?? '',
    checks: json<{ id: string; passed: boolean; detail: string }[]>(quote.checks_json, []),
    messages: messages.map((message) => ({
      id: String(message.id),
      from: String(message.sender),
      kind: String(message.kind),
      text: String(message.text),
      photos: json<string[]>(message.photo_ids_json, []).map((id) => ({
        id,
        url: `/api/v1/uploads/${id}`,
      })),
    })),
  };
}

ownerQuotesRouter.get('/app/quotes/:id', async (req, res) => {
  res.json(ok(await quoteDetail(owner(req).businessId, z.uuid().parse(req.params.id))));
});

/** Approve and send, with the owner's edits if they made any. The server redoes the math. */
ownerQuotesRouter.post('/app/quotes/:id/approve', rateLimit(30, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const quoteId = z.uuid().parse(req.params.id);
  // The card comes back whole. Only the parts an owner can edit are taken from it.
  const edits = req.body?.card ? cardEdits.parse(req.body.card) : null;
  await transaction(async (connection) => {
    const [quote] = await rows(
      `SELECT q.*,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id WHERE q.id=? AND q.business_id=? FOR UPDATE`,
      [quoteId, businessId],
      connection,
    );
    if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
    if (quote.status !== 'review')
      throw new ApiError(409, 'QUOTE_NOT_WAITING', 'This quote has already gone out.');
    if (edits) {
      const card = { ...json<Quote>(quote.quote_json, {} as Quote), ...edits };
      const total = quoteTotal(card);
      if (total <= 0) throw new ApiError(422, 'QUOTE_EMPTY', 'Add at least one priced line.');
      await mutate(
        'UPDATE live_quotes SET quote_json=?,total_cents=? WHERE id=?',
        [JSON.stringify(card), total, quoteId],
        connection,
      );
    } else if (Number(quote.total_cents) <= 0)
      throw new ApiError(422, 'QUOTE_EMPTY', 'Add a price before sending this quote.');
    await markSent(connection, {
      businessId,
      quoteId,
      sentBy: 'owner',
      test: quote.source === 'test',
    });
  });
  res.json(ok(await quoteDetail(businessId, quoteId)));
});

async function emailCustomer(businessId: string, chatId: string, subject: string, intro: string) {
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  const [business] = await rows('SELECT name,slug FROM businesses WHERE id=?', [businessId]);
  if (!chat?.customer_email || chat.source === 'test') return;
  const { link } = await chatEmailLink(undefined, String(business.slug), chatId);
  await queueEmail({
    businessId,
    dedupeKey: `owner-reply:${chatId}:${randomUUID()}`,
    to: String(chat.customer_email),
    subject: subject.replace('{business}', String(business.name)),
    text: `${intro.replace('{business}', String(business.name))}\n${link}`,
  });
}

/** The owner writes to the customer. The AI stays out of the conversation from then on. */
ownerQuotesRouter.post('/app/quotes/:id/messages', rateLimit(30, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const quoteId = z.uuid().parse(req.params.id);
  const { text } = z
    .object({ text: z.string().trim().min(1).max(2000) })
    .strict()
    .parse(req.body);
  const [quote] = await rows('SELECT chat_id FROM live_quotes WHERE id=? AND business_id=?', [
    quoteId,
    businessId,
  ]);
  if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
  await mutate(
    'INSERT INTO lead_messages (id,business_id,chat_id,sender,kind,text,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [randomUUID(), businessId, quote.chat_id, 'owner', 'text', text],
  );
  await mutate('UPDATE lead_chats SET human_handoff=TRUE WHERE id=?', [quote.chat_id]);
  await emailCustomer(
    businessId,
    String(quote.chat_id),
    '{business} replied about your quote',
    '{business} sent you a message about your quote request. Read it and reply here:',
  );
  res.json(ok(await quoteDetail(businessId, quoteId)));
});

/** The owner won't quote this one. The customer is told politely. */
ownerQuotesRouter.post('/app/quotes/:id/decline', rateLimit(30, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const quoteId = z.uuid().parse(req.params.id);
  const { message } = z
    .object({ message: z.string().trim().max(1000).default('') })
    .strict()
    .parse(req.body ?? {});
  const chatId = await transaction(async (connection) => {
    const [quote] = await rows(
      'SELECT * FROM live_quotes WHERE id=? AND business_id=? FOR UPDATE',
      [quoteId, businessId],
      connection,
    );
    if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
    if (quote.status !== 'review')
      throw new ApiError(409, 'QUOTE_NOT_WAITING', 'This quote has already gone out.');
    await mutate(
      "UPDATE live_quotes SET status='declined',decided_at=UTC_TIMESTAMP(3) WHERE id=?",
      [quoteId],
      connection,
    );
    await mutate("UPDATE lead_chats SET status='closed' WHERE id=?", [quote.chat_id], connection);
    const [business] = await rows(
      'SELECT name FROM businesses WHERE id=?',
      [businessId],
      connection,
    );
    await mutate(
      'INSERT INTO lead_messages (id,business_id,chat_id,sender,kind,text,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))',
      [
        randomUUID(),
        businessId,
        quote.chat_id,
        'owner',
        'text',
        message || `Thanks for asking. ${business.name} isn’t able to take on this job, sorry.`,
      ],
      connection,
    );
    return String(quote.chat_id);
  });
  await emailCustomer(
    businessId,
    chatId,
    'An update on your quote request from {business}',
    '{business} replied to your quote request:',
  );
  res.json(ok(await quoteDetail(businessId, quoteId)));
});

ownerQuotesRouter.get('/app/billing', async (req, res) => {
  res.json(ok(await liveBillingSummary(owner(req).businessId)));
});

ownerQuotesRouter.get('/app/profile', async (req, res) => {
  res.json(ok(await pricingProfile(owner(req).businessId)));
});

ownerQuotesRouter.patch('/app/settings', async (req, res) => {
  const { businessId } = owner(req);
  const input = z
    .object({
      autoSend: z.boolean(),
      autoSendLimitCents: z.number().int().min(5000).max(10_000_000),
    })
    .partial()
    .strict()
    .parse(req.body);
  if (input.autoSend !== undefined)
    await mutate('UPDATE businesses SET auto_send=? WHERE id=?', [input.autoSend, businessId]);
  if (input.autoSendLimitCents !== undefined)
    await mutate('UPDATE businesses SET auto_send_limit_cents=? WHERE id=?', [
      input.autoSendLimitCents,
      businessId,
    ]);
  const [business] = await rows(
    'SELECT auto_send,auto_send_limit_cents FROM businesses WHERE id=?',
    [businessId],
  );
  res.json(
    ok({
      autoSend: Boolean(business.auto_send),
      autoSendLimitCents: Number(business.auto_send_limit_cents),
      limitText: money(Number(business.auto_send_limit_cents)),
    }),
  );
});
