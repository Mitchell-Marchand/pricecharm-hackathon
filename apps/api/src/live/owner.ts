import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { ApiError, ok, rateLimit } from '../http.js';
import { ownerReplyTo, queueEmail } from '../integrations/email.js';
import { businessById, json, type Row } from '../models.js';
import { money } from '../money.js';
import { pricingProfile } from '../profile.js';
import { quoteDraftSchema, quoteTotal, type DraftEngine, type Quote } from '../practice/types.js';
import { agentReadiness, businessReadiness, serviceWorkload } from '../pricing/readiness.js';
import { LEARNING_STYLES, restyle, type LearningStyle } from '../pricing/style.js';
import { charmSettingsInput, saveCharmSettings, settingsFromRow } from '../charm.js';
import { describeSpec, type JobSpec } from '../pricing/spec.js';
import { owner } from '../auth.js';
import {
  billingProvider,
  changePlan,
  PLANS,
  reconcileStripeCustomer,
  redeemCode,
} from '../billing.js';
import { consumeAuthRateLimit } from '../verification.js';
import { liveBillingAccess, liveBillingSummary } from './billing.js';
import { chatEmailLink, markSent, whatsAppClosed } from './chat.js';
import { lossReasonLabel } from './outcomes.js';
import { overlayFile, ownerVideos, videoFile } from './videos.js';
import { ownerPhotoReading, photoOverlayFile } from './photo-readings.js';
import { previewFile, previewView } from './previews.js';
import {
  recordActivity,
  recordEvent,
  recordMilestone,
  recordRequestEvent,
  requestSession,
} from '../metrics.js';

/** The owner's side of live quotes: the inbox, approving and editing, and settings. */
export const ownerQuotesRouter = Router();

const cardEdits = z.object(quoteDraftSchema.shape);

const FILTERS = {
  review: "q.status='review'",
  sent: "q.status='sent'",
  accepted: "q.status IN ('accepted','visit_requested')",
  all: '1=1',
} as const;

/**
 * A quote that would wait for the owner, from a customer who hasn't said where to send it. It
 * isn't anyone's request until they do, so the owner doesn't see it.
 */
const ASKING_FOR_CONTACT = "c.status='contact'";

function listItem(row: Record<string, any>) {
  const card = json<Partial<Quote>>(row.quote_json, {});
  const reachable = Boolean(row.customer_email || row.customer_phone);
  return {
    id: String(row.id),
    number: Number(row.number),
    status: String(row.status),
    customer: String(row.customer_name || (reachable ? 'A customer' : 'Visitor')),
    /** The customer left a phone number or an email. Someone who only looked didn't. */
    reachable,
    serviceName: String(row.service_name || ''),
    totalCents: Number(row.total_cents),
    /** What the customer sees instead of the total, for a range quote. */
    range: card.style === 'range' && card.range ? card.range : null,
    reviewReason: String(row.review_reason || ''),
    test: row.source === 'test',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

ownerQuotesRouter.get('/app/home', async (req, res) => {
  const { businessId } = owner(req);
  // Test quotes waiting for an OK are in the list below, so they count there, but not in what
  // went out this month.
  const [counts] = await rows(
    `SELECT COALESCE(SUM(q.status='review'),0) review,
      COALESCE(SUM(c.source<>'test' AND q.status IN ('sent','accepted','visit_requested') AND q.sent_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) sent,
      COALESCE(SUM(c.source<>'test' AND q.status IN ('accepted') AND q.decided_at>=DATE_FORMAT(UTC_DATE(),'%Y-%m-01')),0) accepted
      FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
      WHERE q.business_id=? AND NOT ${ASKING_FOR_CONTACT}`,
    [businessId],
  );
  const waiting = await rows(
    `SELECT q.*,c.customer_name,c.customer_email,c.customer_phone,c.service_name,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND q.status='review' AND NOT ${ASKING_FOR_CONTACT} ORDER BY q.created_at DESC LIMIT 10`,
    [businessId],
  );
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const settings = settingsFromRow(business);
  const services = await businessReadiness(businessId);
  res.json(
    ok({
      business: { id: businessId, name: business.name, slug: business.slug },
      counts: {
        needsOk: Number(counts.review),
        sentThisMonth: Number(counts.sent),
        acceptedThisMonth: Number(counts.accepted),
      },
      waiting: waiting.map(listItem),
      autoSend: settings.autoSend,
      /** Null for no limit. */
      autoSendLimitCents: settings.limitCents,
      settings,
      websiteDomain: String(business.website_domain || ''),
      readiness: agentReadiness(services, await serviceWorkload(businessId)),
      services,
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
    `SELECT q.*,c.customer_name,c.customer_email,c.customer_phone,c.service_name,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND ${FILTERS[filter]} AND NOT ${ASKING_FOR_CONTACT} ORDER BY q.created_at DESC LIMIT 200`,
    [businessId],
  );
  res.json(ok(items.map(listItem)));
});

async function quoteDetail(businessId: string, quoteId: string) {
  const [quote] = await rows(
    `SELECT q.*,c.customer_name,c.customer_email,c.customer_phone,c.job_address,c.service_name,c.source,c.summary,c.spec_json,c.id AS chat_id
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id WHERE q.id=? AND q.business_id=?`,
    [quoteId, businessId],
  );
  if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
  const messages = await rows(
    'SELECT * FROM lead_messages WHERE chat_id=? ORDER BY created_at,id',
    [quote.chat_id],
  );
  const draft = json<{ reasoning?: string; confidence?: string }>(quote.draft_json, {});
  const engine = json<Partial<DraftEngine>>(quote.engine_json, {});
  return {
    ...listItem(quote),
    customerEmail: quote.customer_email ? String(quote.customer_email) : null,
    customerPhone: quote.customer_phone ? String(quote.customer_phone) : null,
    /** The job's street address, when they left it. Only ever shown to the owner. */
    jobAddress: quote.job_address ? String(quote.job_address) : null,
    summary: String(quote.summary || ''),
    /** The job as fields: "600 sq ft; heavy moss; wants it next week". */
    details: describeSpec(json<JobSpec | null>(quote.spec_json, null)),
    /** What the server priced it from, like the owner's usual rate for this size. */
    basis: engine.startingPoint
      ? 'You haven’t priced this service yet, so it started from what other businesses in your trade charge.'
      : String(engine.estimateBasis || ''),
    outcome:
      quote.status === 'lost'
        ? {
            reason: lossReasonLabel(String(quote.outcome_reason)),
            note: String(quote.outcome_note || ''),
          }
        : null,
    /** The words on the customer's accept button, once it went out. */
    acceptLabel: quote.accept_label ? String(quote.accept_label) : null,
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
      videoId: message.video_id ? String(message.video_id) : null,
    })),
    /** Walk-around videos the customer sent, with what was counted and measured in them. */
    videos: await ownerVideos(businessId, String(quote.chat_id)),
    /** What was counted and seen in the customer's photos, once they've been read. */
    photoReading: await ownerPhotoReading(businessId, String(quote.chat_id), String(quote.id)),
    /** The before-and-after customers see with the quote, once it's drawn, while it's turned on. */
    preview: (await rows('SELECT after_preview FROM businesses WHERE id=?', [businessId]))[0]
      ?.after_preview
      ? previewView(quote, `/api/v1/app/quotes/${quote.id}/preview`)
      : null,
  };
}

ownerQuotesRouter.get('/app/quotes/:id/preview/:which', async (req, res) => {
  const [quote] = await rows('SELECT * FROM live_quotes WHERE id=? AND business_id=?', [
    z.uuid().parse(req.params.id),
    owner(req).businessId,
  ]);
  if (!quote) throw new ApiError(404, 'NOT_FOUND', 'Picture not found.');
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(await previewFile(quote, String(req.params.which)));
});

ownerQuotesRouter.get('/app/quotes/:id/photo-overlays/:index', async (req, res) => {
  const index = z.coerce.number().int().min(0).max(10).parse(req.params.index);
  const image = await photoOverlayFile(owner(req).businessId, String(req.params.id), index);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(image);
});

ownerQuotesRouter.get('/app/videos/:id', async (req, res) => {
  const video = await videoFile(owner(req).businessId, String(req.params.id));
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(video.mimeType).send(video.bytes);
});

ownerQuotesRouter.get('/app/videos/:id/overlays/:index', async (req, res) => {
  const index = z.coerce.number().int().min(0).max(10).parse(req.params.index);
  const image = await overlayFile(owner(req).businessId, String(req.params.id), index);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(image);
});

ownerQuotesRouter.get('/app/quotes/:id', async (req, res) => {
  const quoteId = z.uuid().parse(req.params.id);
  const detail = await quoteDetail(owner(req).businessId, quoteId);
  await recordRequestEvent(
    req,
    owner(req).businessId,
    'owner_quote_opened',
    { status: String(detail.status), test: Boolean(detail.test) },
    { ref: quoteId },
  );
  res.json(ok(detail));
});

/** Approve and send, with the owner's edits if they made any. The server redoes the math. */
/**
 * Sends a quote that's waiting for the owner, with their edits if they made any. The quote row
 * (with its chat's source) has to be locked in this transaction.
 */
export async function sendWaitingQuote(
  connection: Sql,
  quote: Row,
  edits: Partial<Quote> | null,
  style?: LearningStyle,
  via: { channel: 'app' | 'email'; session?: string | null } = { channel: 'app' },
): Promise<void> {
  if (quote.status !== 'review')
    throw new ApiError(409, 'QUOTE_NOT_WAITING', 'This quote has already gone out.');
  const [chat] = await rows(
    'SELECT status FROM lead_chats WHERE id=?',
    [quote.chat_id],
    connection,
  );
  if (chat?.status === 'contact')
    throw new ApiError(409, 'NO_CONTACT', 'This customer hasn’t said where to send it yet.');
  const drafted = Number(quote.total_cents);
  if (edits || style) {
    // A range follows the owner's new price; they can also send it firm, or as an estimate. What
    // an open condition would add was worked out on the Charm's price, so a new price drops it.
    const { ifs, ...charms } = json<Quote>(quote.quote_json, {} as Quote);
    const card = restyle({ ...charms, ...(edits?.lines ? {} : { ifs }), ...edits }, style);
    const total = quoteTotal(card);
    if (total <= 0) throw new ApiError(422, 'QUOTE_EMPTY', 'Add at least one priced line.');
    await mutate(
      'UPDATE live_quotes SET quote_json=?,total_cents=? WHERE id=?',
      [JSON.stringify(card), total, quote.id],
      connection,
    );
  } else if (Number(quote.total_cents) <= 0)
    throw new ApiError(422, 'QUOTE_EMPTY', 'Add a price before sending this quote.');
  const closed = await whatsAppClosed(String(quote.chat_id), connection, true);
  if (closed) throw new ApiError(409, 'WHATSAPP_CLOSED', closed);
  await markSent(connection, {
    businessId: String(quote.business_id),
    quoteId: String(quote.id),
    sentBy: 'owner',
    test: quote.source === 'test',
  });
  const [sent] = await rows(
    'SELECT total_cents FROM live_quotes WHERE id=?',
    [quote.id],
    connection,
  );
  const total = Number(sent.total_cents);
  await recordEvent(
    connection,
    String(quote.business_id),
    'quote_approved',
    {
      via: via.channel,
      test: quote.source === 'test',
      edited: Boolean(edits),
      style: style ?? '',
      drafted_cents: drafted,
      sent_cents: total,
      change_pct: drafted > 0 ? Math.round(((total - drafted) / drafted) * 100) : null,
      // How long the customer waited on the owner.
      waited_minutes: Math.round((Date.now() - new Date(quote.created_at).getTime()) / 60_000),
      review_reason: String(quote.review_reason ?? '').slice(0, 120),
    },
    { session: via.session, ref: String(quote.id), value: total },
  );
}

ownerQuotesRouter.post('/app/quotes/:id/approve', rateLimit(30, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const quoteId = z.uuid().parse(req.params.id);
  // The card comes back whole. Only the parts an owner can edit are taken from it.
  const edits = req.body?.card ? cardEdits.parse(req.body.card) : null;
  const style = req.body?.style ? z.enum(LEARNING_STYLES).parse(req.body.style) : undefined;
  await transaction(async (connection) => {
    const [quote] = await rows(
      `SELECT q.*,c.source FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id WHERE q.id=? AND q.business_id=? FOR UPDATE`,
      [quoteId, businessId],
      connection,
    );
    if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'That quote isn’t here.');
    await sendWaitingQuote(connection, quote, edits, style, {
      channel: 'app',
      session: requestSession(req),
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
    replyTo: await ownerReplyTo(businessId),
    fromName: String(business.name),
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
  const closed = await whatsAppClosed(String(quote.chat_id));
  if (closed) throw new ApiError(409, 'WHATSAPP_CLOSED', closed);
  await mutate(
    'INSERT INTO lead_messages (id,business_id,chat_id,sender,kind,text,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [randomUUID(), businessId, quote.chat_id, 'owner', 'text', text],
  );
  await mutate('UPDATE lead_chats SET human_handoff=TRUE WHERE id=?', [quote.chat_id]);
  await recordRequestEvent(
    req,
    businessId,
    'owner_message_sent',
    { chars: text.length },
    { ref: quoteId },
  );
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
    await recordActivity(connection, businessId, 'quote_outcome', {
      ref: quoteId,
      detail: 'owner_declined',
      value: Number(quote.total_cents),
    });
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

/** Picks or switches the plan. See changePlan for when a switch takes effect. */
ownerQuotesRouter.post('/app/billing/plan', async (req, res) => {
  const { businessId } = owner(req);
  const { plan } = z
    .object({ plan: z.enum(PLANS) })
    .strict()
    .parse(req.body);
  await consumeAuthRateLimit(`billing-plan:${businessId}`, 20, 3600_000);
  await changePlan(businessId, plan);
  await recordMilestone(undefined, businessId, 'plan_chosen', plan);
  res.json(ok(await liveBillingSummary(businessId)));
});

/** Puts a code on the account, for free days from the first card. */
ownerQuotesRouter.post('/app/billing/code', async (req, res) => {
  const { businessId } = owner(req);
  const { code } = z
    .object({ code: z.string().trim().min(1).max(60) })
    .strict()
    .parse(req.body);
  // Enough tries for typos, not enough to guess codes.
  await consumeAuthRateLimit(`billing-code:${businessId}`, 10, 3600_000);
  await redeemCode(businessId, code);
  res.json(ok(await liveBillingSummary(businessId)));
});

/**
 * Deploys the Charm: the quote link starts taking requests. It needs a plan and a card, so every
 * quote it writes can reach the customer. How trained it is doesn't matter here; the owner's
 * settings say what goes out while it's learning.
 */
ownerQuotesRouter.post('/app/deploy', async (req, res) => {
  const { businessId } = owner(req);
  await transaction(async (connection) => {
    const access = await liveBillingAccess(businessId, connection, 0);
    if (!access.canSend) throw new ApiError(409, 'NOT_READY_TO_DEPLOY', access.reason);
    await mutate(
      'UPDATE businesses SET link_on=TRUE,deployed_at=COALESCE(deployed_at,UTC_TIMESTAMP(3)) WHERE id=?',
      [businessId],
      connection,
    );
    await recordMilestone(connection, businessId, 'went_live');
  });
  res.json(ok(await liveBillingSummary(businessId)));
});

/** Pauses the quote link, or turns it back on. Customers see that it isn't taking requests. */
ownerQuotesRouter.patch('/app/link', async (req, res) => {
  const { businessId } = owner(req);
  const { on } = z.object({ on: z.boolean() }).strict().parse(req.body);
  await transaction(async (connection) => {
    if (on) {
      const access = await liveBillingAccess(businessId, connection, 0);
      if (!access.canSend) throw new ApiError(409, 'NOT_READY_TO_DEPLOY', access.reason);
    }
    await mutate(
      `UPDATE businesses SET link_on=?${on ? ',deployed_at=COALESCE(deployed_at,UTC_TIMESTAMP(3))' : ''} WHERE id=?`,
      [on, businessId],
      connection,
    );
    if (on) await recordMilestone(connection, businessId, 'went_live');
    await recordEvent(
      connection,
      businessId,
      'link_switched',
      { on },
      { session: requestSession(req) },
    );
  });
  res.json(ok(await liveBillingSummary(businessId)));
});

/**
 * Back from adding a card: reads the subscription from Stripe now, rather than waiting for its
 * webhook, so setup can say they're live straight away.
 */
ownerQuotesRouter.post('/app/billing/sync', async (req, res) => {
  const { businessId } = owner(req);
  await consumeAuthRateLimit(`billing-sync:${businessId}`, 30, 3600_000);
  const [account] = await rows(
    'SELECT stripe_customer_id FROM billing_accounts WHERE business_id=?',
    [businessId],
  );
  if (billingProvider() === 'stripe' && account?.stripe_customer_id)
    await reconcileStripeCustomer(String(account.stripe_customer_id));
  res.json(ok(await liveBillingSummary(businessId)));
});

ownerQuotesRouter.get('/app/profile', async (req, res) => {
  res.json(ok(await pricingProfile(owner(req).businessId)));
});

ownerQuotesRouter.patch('/app/settings', async (req, res) => {
  const settings = await saveCharmSettings(
    owner(req).businessId,
    charmSettingsInput.parse(req.body),
  );
  res.json(
    ok({
      ...settings,
      // The names older pages read.
      autoSendLimitCents: settings.limitCents,
      limitText:
        settings.limitCents === null
          ? ''
          : money(settings.limitCents, (await businessById(owner(req).businessId)).currency),
    }),
  );
});
