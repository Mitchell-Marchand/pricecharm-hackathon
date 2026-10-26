import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { tradeName } from '@quotefolk/trades';
import { aiMode, type AiImage } from '../ai/index.js';
import { intakeTurn } from '../ai/intake.js';
import { draftQuote } from '../ai/quote-engine.js';
import { hashToken, newToken } from '../auth.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { isDisposableEmail } from '../email-domains.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { mailProvider, queueEmail } from '../integrations/email.js';
import { json, type Row } from '../models.js';
import { listPastJobs } from '../past-jobs.js';
import { pricingHistory } from '../practice/engine.js';
import { quoteTotal, type DraftedQuote, type Quote } from '../practice/types.js';
import { pricingProfile } from '../profile.js';
import { getPhoto } from '../storage.js';
import { withAiUsage, withCustomerAiUsage } from '../usage.js';
import { consumeAuthRateLimit } from '../verification.js';
import { recordLiveDelivery, liveBillingAccess } from './billing.js';

const CHAT_DAYS = 14;
const EMAIL_LINK_DAYS = 30;
const MAX_MESSAGES = 60;

export function appOrigin() {
  return (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
}
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

export async function businessBySlug(slug: unknown, connection?: Sql) {
  const parsed = z
    .string()
    .regex(/^[a-z0-9-]{1,180}$/)
    .safeParse(slug);
  const [business] = parsed.success
    ? await rows(
        "SELECT * FROM businesses WHERE slug=? AND status='active' AND deletion_requested_at IS NULL",
        [parsed.data],
        connection,
      )
    : [];
  if (!business) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This quote page isn’t available.');
  return business;
}

async function services(businessId: string, connection?: Sql) {
  return (
    await rows(
      'SELECT name FROM offerings WHERE business_id=? ORDER BY position',
      [businessId],
      connection,
    )
  ).map((row) => String(row.name));
}

async function ownerFirstName(businessId: string) {
  const [user] = await rows(
    'SELECT first_name,name FROM users WHERE business_id=? ORDER BY created_at LIMIT 1',
    [businessId],
  );
  return String(user?.first_name || String(user?.name ?? '').split(' ')[0] || '');
}

export async function publicProfile(business: Row) {
  const name = String(business.name);
  return {
    name,
    initials: name
      .split(/\s+/)
      .filter((word) => /^[A-Za-z0-9]/.test(word))
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join(''),
    trade: tradeName(business.trade_id, business.custom_trade),
    services: await services(String(business.id)),
    ownerFirstName: await ownerFirstName(String(business.id)),
    /** The one website allowed to show the widget. */
    websiteDomain: String(business.website_domain ?? ''),
  };
}

async function addMessage(
  connection: Sql | undefined,
  input: {
    businessId: string;
    chatId: string;
    sender: 'customer' | 'assistant' | 'owner';
    text: string;
    kind?: 'text' | 'status';
    photoIds?: string[];
    chips?: string[];
  },
) {
  await mutate(
    'INSERT INTO lead_messages (id,business_id,chat_id,sender,kind,text,photo_ids_json,chips_json,created_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [
      randomUUID(),
      input.businessId,
      input.chatId,
      input.sender,
      input.kind ?? 'text',
      input.text,
      JSON.stringify(input.photoIds ?? []),
      JSON.stringify(input.chips ?? []),
    ],
    connection,
  );
}

/** The first thing a customer reads. It says it's an assistant, not a person. */
export const greeting = (businessName: string) =>
  `Hi! I'm the quote assistant for ${businessName}. I can put a price together for you in a couple of minutes. What do you need done?`;

/** Starts a quote chat. The owner's own test chats are marked so they're never billed or emailed. */
export async function startChat(business: Row, source: 'link' | 'widget' | 'test') {
  const token = newToken(),
    id = randomUUID();
  const offered = await services(String(business.id));
  await transaction(async (connection) => {
    await mutate(
      'INSERT INTO lead_chats (id,business_id,token_hash,source,expires_at) VALUES (?,?,?,?,?)',
      [id, business.id, hashToken(token), source, new Date(Date.now() + CHAT_DAYS * 86_400_000)],
      connection,
    );
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: id,
      sender: 'assistant',
      text: greeting(String(business.name)),
      chips: offered.slice(0, 6),
    });
  });
  return { token, chatId: id };
}

const bearer = (req: Request) =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];

/** The customer's chat, reached with its own token or the link from their quote email. */
export async function chatAccess(req: Request, connection?: Sql, lock = false) {
  const business = await businessBySlug(req.params.slug, connection);
  const chatId = z.uuid().parse(req.params.chatId);
  const token = bearer(req);
  if (!token) throw new ApiError(401, 'CHAT_TOKEN_REQUIRED', 'This chat link isn’t complete.');
  const hash = hashToken(token);
  const [chat] = await rows(
    `SELECT * FROM lead_chats WHERE id=? AND business_id=? AND ((token_hash=? AND expires_at>UTC_TIMESTAMP(3)) OR (email_token_hash=? AND email_token_expires_at>UTC_TIMESTAMP(3)))${lock ? ' FOR UPDATE' : ''}`,
    [chatId, business.id, hash, hash],
    connection,
  );
  if (!chat)
    throw new ApiError(404, 'CHAT_NOT_FOUND', 'This chat has expired or the link is wrong.');
  return { business, chat };
}

export function photoPath(slug: string, chatId: string, photoId: string) {
  return `/api/v1/chat/${slug}/${chatId}/photos/${photoId}`;
}

async function liveQuoteFor(chatId: string, connection?: Sql) {
  const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [chatId], connection);
  return quote ?? null;
}

export async function chatView(business: Row, chat: Row) {
  const messages = await rows(
    'SELECT * FROM lead_messages WHERE chat_id=? ORDER BY created_at,id',
    [chat.id],
  );
  const quote = await liveQuoteFor(String(chat.id));
  // Customers only ever see a quote the business sent; a held or declined one stays private.
  const visible = quote && ['sent', 'accepted', 'visit_requested'].includes(String(quote.status));
  return {
    id: String(chat.id),
    status: String(chat.status),
    test: chat.source === 'test',
    serviceName: String(chat.service_name),
    messages: messages.map((message) => ({
      id: String(message.id),
      from: message.sender as 'customer' | 'assistant' | 'owner',
      kind: message.kind as 'text' | 'status',
      text: String(message.text),
      photos: json<string[]>(message.photo_ids_json, []).map((id) => ({
        id,
        url: photoPath(String(business.slug), String(chat.id), id),
      })),
      chips: json<string[]>(message.chips_json, []),
      createdAt: new Date(message.created_at).toISOString(),
    })),
    contact: {
      name: String(chat.customer_name),
      email: chat.customer_email ? String(chat.customer_email) : null,
      verified: Boolean(chat.contact_verified_at),
    },
    quote: visible
      ? {
          id: String(quote.id),
          status: String(quote.status),
          card: { ...json<Quote>(quote.quote_json, {} as Quote), note: '' },
          sentAt: quote.sent_at ? new Date(quote.sent_at).toISOString() : null,
        }
      : null,
    waitingForOwner: quote?.status === 'review',
  };
}

async function chatImages(businessId: string, chatId: string): Promise<AiImage[]> {
  const photos = await rows(
    'SELECT storage_key FROM attachments WHERE business_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 3',
    [businessId, chatId],
  );
  return Promise.all(
    photos.map(async (photo) => ({
      mimeType: 'image/jpeg',
      dataBase64: (await getPhoto(String(photo.storage_key))).toString('base64'),
    })),
  );
}

/** Runs AI work against the right allowance: the owner's for their own tests, else the customers'. */
function withChatUsage<T>(req: Request, business: Row, chat: Row, task: () => Promise<T>) {
  return chat.source === 'test'
    ? withAiUsage(String(business.id), String(chat.id), task)
    : withCustomerAiUsage(
        {
          businessId: String(business.id),
          sessionId: String(chat.id),
          ip: req.ip || req.socket.remoteAddress || 'unknown',
        },
        task,
      );
}

/** The assistant's next message while it's still gathering details. */
async function runIntake(req: Request, business: Row, chat: Row) {
  const messages = await rows(
    "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' AND sender IN ('customer','assistant') ORDER BY created_at,id",
    [chat.id],
  );
  const [photos] = await rows(
    'SELECT COUNT(*) AS count FROM attachments WHERE business_id=? AND conversation_id=?',
    [business.id, chat.id],
  );
  const profile = await pricingProfile(String(business.id));
  const turn = await withChatUsage(req, business, chat, async () =>
    intakeTurn(
      {
        business: {
          name: String(business.name),
          trade: tradeName(business.trade_id, business.custom_trade),
          services: await services(String(business.id)),
          area: String(business.service_area ?? ''),
          radiusMiles: business.travel_radius_miles ? Number(business.travel_radius_miles) : null,
        },
        checklist: profile.asks,
        serviceName: String(chat.service_name),
        conversation: messages.map((message) => ({
          from: message.sender as 'customer' | 'assistant',
          text: String(message.text),
        })),
        photosReceived: Number(photos.count),
      },
      await chatImages(String(business.id), String(chat.id)),
    ),
  );
  await transaction(async (connection) => {
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'assistant',
      text: turn.reply,
      chips: turn.chips,
    });
    await mutate(
      "UPDATE lead_chats SET service_name=?,ready=?,summary=?,out_of_scope=?,status=IF(?,'contact',status) WHERE id=?",
      [turn.serviceName, turn.ready, turn.summary, turn.outOfScope, turn.ready, chat.id],
      connection,
    );
  });
}

export async function customerMessage(req: Request, text: string) {
  const { business, chat } = await chatAccess(req);
  const [count] = await rows('SELECT COUNT(*) AS count FROM lead_messages WHERE chat_id=?', [
    chat.id,
  ]);
  if (Number(count.count) >= MAX_MESSAGES)
    throw new ApiError(422, 'CHAT_LONG', 'This chat is full. Start a new one to keep going.');
  await addMessage(undefined, {
    businessId: String(business.id),
    chatId: String(chat.id),
    sender: 'customer',
    text,
  });
  if (chat.status === 'chatting' && !chat.human_handoff) await runIntake(req, business, chat);
  else if (chat.source !== 'test' && chat.status !== 'chatting' && chat.status !== 'contact')
    await notifyOwner(String(business.id), String(chat.id), 'message');
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

/** After a photo, the assistant carries on, now able to see it. */
export async function afterPhoto(req: Request, photoId: string) {
  const { business, chat } = await chatAccess(req);
  await addMessage(undefined, {
    businessId: String(business.id),
    chatId: String(chat.id),
    sender: 'customer',
    text: '',
    photoIds: [photoId],
  });
  if (chat.status === 'chatting' && !chat.human_handoff) await runIntake(req, business, chat);
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

function hashCode(value: string): string {
  const key = process.env.MAIL_ENCRYPTION_KEY || 'quotient-local-contact-code-pepper';
  if (process.env.NODE_ENV === 'production' && !process.env.MAIL_ENCRYPTION_KEY)
    throw new Error('Contact verification requires a production identity secret.');
  const context = createHmac('sha256', key).update('quotient-chat-verification-v1').digest();
  return createHmac('sha256', context).update(value).digest('hex');
}

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/** "Where should I send your quote?" Sends a code to confirm the email is theirs. */
export async function requestContact(
  req: Request,
  input: { name: string; email: string },
  exposeCode: boolean,
) {
  const email = emailSchema.parse(input.email);
  if (isDisposableEmail(email))
    throw new ApiError(
      422,
      'DISPOSABLE_EMAIL',
      'Please use an email address you’ll keep. Your quote will be sent there.',
    );
  const { business, chat } = await chatAccess(req);
  if (chat.status !== 'contact' && chat.status !== 'chatting')
    throw new ApiError(409, 'CHAT_DONE', 'Your quote is already on its way.');
  await mutate('UPDATE lead_chats SET customer_name=? WHERE id=?', [input.name, chat.id]);
  if (chat.source === 'test') {
    // The owner is testing their own link: no code, no email, straight to the quote.
    await mutate(
      "UPDATE lead_chats SET customer_email=?,contact_verified_at=UTC_TIMESTAMP(3),status='quoting' WHERE id=?",
      [email, chat.id],
    );
    await prepareLiveQuote(req, String(business.id), String(chat.id));
    const fresh = await chatAccess(req);
    return {
      verificationId: null,
      devCode: undefined,
      chat: await chatView(fresh.business, fresh.chat),
    };
  }
  await consumeAuthRateLimit(`chat-contact-ip:${req.ip}`, 20, 3_600_000);
  const verificationId = randomUUID(),
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await transaction(async (connection) => {
    const recent = await rows(
      'SELECT created_at FROM contact_verifications WHERE business_id=? AND session_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE) ORDER BY created_at DESC FOR UPDATE',
      [business.id, chat.id],
      connection,
    );
    if (
      recent.length >= 3 ||
      (recent[0] && new Date(recent[0].created_at).getTime() > Date.now() - 30_000)
    )
      throw new ApiError(
        429,
        'CODE_RATE_LIMIT',
        'Please wait a moment before asking for another code.',
      );
    await mutate(
      'UPDATE contact_verifications SET used_at=UTC_TIMESTAMP(3) WHERE business_id=? AND session_id=? AND used_at IS NULL',
      [business.id, chat.id],
      connection,
    );
    await mutate(
      'INSERT INTO contact_verifications(id,business_id,session_id,email,code_hash,expires_at) VALUES (?,?,?,?,?,?)',
      [
        verificationId,
        business.id,
        chat.id,
        email,
        hashCode(`${verificationId}:${chat.id}:${email}:${code}`),
        new Date(Date.now() + 10 * 60_000),
      ],
      connection,
    );
    await queueEmail(
      {
        businessId: String(business.id),
        dedupeKey: `chat-code:${verificationId}`,
        to: email,
        subject: `Your code for ${business.name}`,
        text: `Your code is ${code}. Enter it to see your quote from ${business.name}. It works for 10 minutes.\n\nIf you didn’t ask for a quote, you can ignore this email.`,
      },
      connection,
    );
  });
  return {
    verificationId,
    devCode: mailProvider() === 'local' && exposeCode ? code : undefined,
    chat: null,
  };
}

/** The customer enters their code. Then the quote is drafted and checked. */
export async function verifyContact(req: Request, input: { verificationId: string; code: string }) {
  const verified = await transaction(async (connection) => {
    const { chat } = await chatAccess(req, connection, true);
    const [item] = await rows(
      'SELECT * FROM contact_verifications WHERE id=? AND business_id=? AND session_id=? FOR UPDATE',
      [input.verificationId, chat.business_id, chat.id],
      connection,
    );
    if (
      !item ||
      item.used_at ||
      Number(item.attempts) >= 5 ||
      new Date(item.expires_at).getTime() <= Date.now()
    )
      return false;
    await mutate(
      'UPDATE contact_verifications SET attempts=attempts+1 WHERE id=?',
      [item.id],
      connection,
    );
    const expected = Buffer.from(String(item.code_hash), 'hex');
    const actual = Buffer.from(
      hashCode(`${item.id}:${chat.id}:${item.email}:${input.code}`),
      'hex',
    );
    if (!/^\d{6}$/.test(input.code) || !timingSafeEqual(expected, actual)) return false;
    await mutate(
      'UPDATE contact_verifications SET used_at=UTC_TIMESTAMP(3) WHERE id=?',
      [item.id],
      connection,
    );
    await mutate(
      "UPDATE lead_chats SET customer_email=?,contact_verified_at=UTC_TIMESTAMP(3),status='quoting' WHERE id=? AND status IN ('chatting','contact')",
      [item.email, chat.id],
      connection,
    );
    return true;
  });
  if (!verified)
    throw new ApiError(
      400,
      'CODE_INVALID',
      'That code didn’t work. Check it, or ask for a new one.',
    );
  const { business, chat } = await chatAccess(req);
  await prepareLiveQuote(req, String(business.id), String(chat.id));
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

type Check = { id: string; passed: boolean; detail: string };

/** The server's checks on the AI's draft. Any failure sends the quote to the owner first. */
async function checkDraft(business: Row, chat: Row, drafted: DraftedQuote, totalCents: number) {
  const checks: Check[] = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const limit = Number(business.auto_send_limit_cents);
  const offered = await services(String(business.id));
  add(
    'priced',
    drafted.lines.length > 0 && totalCents > 0,
    'It couldn’t price this from your past jobs.',
  );
  add(
    'decision',
    drafted.decision === 'quote',
    `It thinks you should see it first${drafted.reason ? `: ${drafted.reason}` : '.'}`,
  );
  add('confidence', drafted.confidence !== 'low', 'It isn’t sure about this one.');
  add('limit', totalCents <= limit, `It’s over your ${money(limit)} limit.`);
  add(
    'service',
    !chat.service_name || offered.includes(String(chat.service_name)),
    `${chat.service_name} isn’t one of your services.`,
  );
  add('scope', !chat.out_of_scope, String(chat.out_of_scope));
  const similar = (await listPastJobs(String(business.id))).filter(
    (job) => job.serviceName === chat.service_name,
  );
  if (similar.length >= 2) {
    const prices = similar.map((job) => job.priceCents);
    const low = Math.min(...prices),
      high = Math.max(...prices);
    add(
      'range',
      totalCents >= low * 0.5 && totalCents <= high * 2,
      `It’s far from what you charged for similar jobs (${money(low)} to ${money(high)}).`,
    );
  }
  add('handoff', !chat.human_handoff, 'The customer asked to talk to you.');
  add('auto', Boolean(business.auto_send), 'You approve each quote for now.');
  return checks;
}

/** Card details the owner usually includes, taken from their practice quotes for this service. */
async function usualTerms(businessId: string, serviceName: string) {
  const runs = await rows(
    "SELECT scenario_json,quote_json FROM practice_runs WHERE business_id=? AND outcome='quote' ORDER BY position DESC",
    [businessId],
  );
  const quotes = runs.map((run) => ({
    service: json<{ serviceName?: string }>(run.scenario_json, {}).serviceName,
    quote: json<Quote | null>(run.quote_json, null),
  }));
  const match =
    quotes.find((item) => item.service === serviceName && item.quote) ??
    quotes.find((item) => item.quote);
  return {
    included: match?.quote?.included ?? [],
    excluded: match?.quote?.excluded ?? [],
    validDays: match?.quote?.validDays ?? 14,
  };
}

function demoLiveDraft(
  jobs: { priceCents: number; serviceName: string; description: string }[],
  serviceName: string,
): DraftedQuote {
  const similar = jobs.filter((job) => job.serviceName === serviceName);
  const pool = (similar.length ? similar : jobs).map((job) => job.priceCents).sort((a, b) => a - b);
  const median = pool.length ? pool[Math.floor(pool.length / 2)] : 0;
  return {
    decision: 'quote',
    reason: '',
    lines: median ? [{ label: serviceName || 'Job as described', amountCents: median }] : [],
    discount: null,
    start: 'Next week',
    duration: '',
    confidence: median ? 'medium' : 'low',
    reasoning: 'Demo mode: the middle price of your similar past jobs.',
  };
}

/** Drafts the quote, checks it, and either sends it or puts it in front of the owner. */
export async function prepareLiveQuote(req: Request, businessId: string, chatId: string) {
  if (await liveQuoteFor(chatId)) return;
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  const messages = await rows(
    "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' ORDER BY created_at,id",
    [chatId],
  );
  let drafted: DraftedQuote;
  try {
    drafted =
      aiMode === 'demo'
        ? demoLiveDraft(await listPastJobs(businessId), String(chat.service_name))
        : await withChatUsage(req, business, chat, async () =>
            draftQuote({
              history: await pricingHistory(businessId),
              request: {
                serviceName: String(chat.service_name),
                conversation: messages
                  .filter((message) => message.text)
                  .map((message) => ({
                    from:
                      message.sender === 'customer' ? ('customer' as const) : ('owner' as const),
                    text: String(message.text),
                  })),
              },
              images: await chatImages(businessId, chatId),
            }),
          );
  } catch (error) {
    reportError(error, { event: 'live_draft' });
    drafted = {
      decision: 'site_visit',
      reason: 'it couldn’t draft this one',
      lines: [],
      discount: null,
      start: '',
      duration: '',
      confidence: 'low',
      reasoning: '',
    };
  }
  const totalCents = quoteTotal(drafted);
  const checks = await checkDraft(business, chat, drafted, totalCents);
  const terms = await usualTerms(businessId, String(chat.service_name));
  const test = chat.source === 'test';
  await transaction(async (connection) => {
    // Lock the chat so two requests can't both draft its quote.
    await rows('SELECT id FROM lead_chats WHERE id=? FOR UPDATE', [chatId], connection);
    if (await liveQuoteFor(chatId, connection)) return;
    const [counter] = await rows(
      'SELECT next_quote_number FROM businesses WHERE id=? FOR UPDATE',
      [businessId],
      connection,
    );
    const number = Number(counter.next_quote_number);
    await mutate(
      'UPDATE businesses SET next_quote_number=? WHERE id=?',
      [number + 1, businessId],
      connection,
    );
    const name = String(chat.customer_name).trim();
    const parts = name.split(/\s+/);
    const card: Quote = {
      number,
      customer: parts.length > 1 ? `${parts[0]} ${parts.at(-1)?.[0]}.` : name,
      place: String(business.service_area ?? ''),
      lines: drafted.lines.map((line, index) => ({ id: `l${index}`, ...line })),
      discount: drafted.discount,
      start: drafted.start,
      duration: drafted.duration,
      included: terms.included,
      excluded: terms.excluded,
      validDays: terms.validDays,
      note: '',
      issuedAt: new Date().toISOString(),
    };
    const failed = checks.filter((check) => !check.passed);
    let status: 'sent' | 'review' = failed.length ? 'review' : 'sent';
    let reason = failed.map((check) => check.detail).join(' ');
    const quoteId = randomUUID();
    await mutate(
      'INSERT INTO live_quotes (id,business_id,chat_id,number,status,quote_json,draft_json,checks_json,review_reason,total_cents) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        quoteId,
        businessId,
        chatId,
        number,
        'review',
        JSON.stringify(card),
        JSON.stringify(drafted),
        JSON.stringify(checks),
        reason.slice(0, 600),
        totalCents,
      ],
      connection,
    );
    if (status === 'sent' && !test) {
      const access = await liveBillingAccess(businessId, connection, totalCents);
      if (!access.canSend) {
        status = 'review';
        reason = access.reason;
        await mutate(
          'UPDATE live_quotes SET review_reason=? WHERE id=?',
          [reason, quoteId],
          connection,
        );
      }
    }
    if (status === 'sent')
      await markSent(connection, { businessId, quoteId, sentBy: 'auto', test });
    else {
      await mutate("UPDATE lead_chats SET status='review' WHERE id=?", [chatId], connection);
      const owner = await ownerFirstName(businessId);
      await addMessage(connection, {
        businessId,
        chatId,
        sender: 'assistant',
        kind: 'status',
        text: `Thanks! ${owner ? `${owner} at ` : ''}${business.name} will look this over and send your quote shortly. We’ll email you when it’s ready.`,
      });
      if (!test) await notifyOwner(businessId, chatId, 'review', connection);
    }
  });
}

/** Shows the quote to the customer, bills it once, and lets both sides know. */
export async function markSent(
  connection: Sql,
  input: { businessId: string; quoteId: string; sentBy: 'auto' | 'owner'; test: boolean },
) {
  const [quote] = await rows(
    'SELECT * FROM live_quotes WHERE id=? AND business_id=? FOR UPDATE',
    [input.quoteId, input.businessId],
    connection,
  );
  if (!input.test)
    await recordLiveDelivery(connection, {
      businessId: input.businessId,
      quoteId: input.quoteId,
      totalCents: Number(quote.total_cents),
      sentBy: input.sentBy,
    });
  await mutate(
    "UPDATE live_quotes SET status='sent',sent_by=?,sent_at=UTC_TIMESTAMP(3) WHERE id=?",
    [input.sentBy, input.quoteId],
    connection,
  );
  await mutate("UPDATE lead_chats SET status='sent' WHERE id=?", [quote.chat_id], connection);
  const [business] = await rows(
    'SELECT name FROM businesses WHERE id=?',
    [input.businessId],
    connection,
  );
  const [chat] = await rows(
    'SELECT customer_name FROM lead_chats WHERE id=?',
    [quote.chat_id],
    connection,
  );
  const first = String(chat.customer_name).trim().split(/\s+/)[0];
  await addMessage(connection, {
    businessId: input.businessId,
    chatId: String(quote.chat_id),
    sender: 'assistant',
    kind: 'status',
    text: `Here’s your quote${first ? `, ${first}` : ''}. A copy is on its way to your inbox.`,
  });
  if (input.test) return;
  await notifyCustomerQuote(
    connection,
    input.businessId,
    String(quote.chat_id),
    String(business.name),
  );
  if (input.sentBy === 'auto')
    await notifyOwner(input.businessId, String(quote.chat_id), 'sent', connection);
}

async function notifyCustomerQuote(
  connection: Sql,
  businessId: string,
  chatId: string,
  businessName: string,
) {
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId], connection);
  const [business] = await rows('SELECT slug FROM businesses WHERE id=?', [businessId], connection);
  const [quote] = await rows(
    'SELECT total_cents FROM live_quotes WHERE chat_id=?',
    [chatId],
    connection,
  );
  if (!chat.customer_email) return;
  const token = newToken();
  await mutate(
    'UPDATE lead_chats SET email_token_hash=?,email_token_expires_at=? WHERE id=?',
    [hashToken(token), new Date(Date.now() + EMAIL_LINK_DAYS * 86_400_000), chatId],
    connection,
  );
  const link = `${appOrigin()}/q/${business.slug}#chat=${chatId}&token=${token}`;
  const first = String(chat.customer_name).trim().split(/\s+/)[0];
  await queueEmail(
    {
      businessId,
      dedupeKey: `live-quote:${chatId}:customer`,
      to: String(chat.customer_email),
      subject: `Your quote from ${businessName}`,
      text: `Hi${first ? ` ${first}` : ''},\n\nHere’s your quote from ${businessName} for ${money(Number(quote.total_cents))}. See what’s included and accept it here:\n${link}\n\nThe link works for ${EMAIL_LINK_DAYS} days. Keep it to yourself, since anyone with it can see your quote.`,
    },
    connection,
  );
}

type OwnerEvent = 'review' | 'sent' | 'accepted' | 'visit' | 'message';

/** Owners hear about every request that needs them and every quote that goes out. */
export async function notifyOwner(
  businessId: string,
  chatId: string,
  event: OwnerEvent,
  connection?: Sql,
) {
  const [owner] = await rows(
    'SELECT email FROM users WHERE business_id=? ORDER BY created_at LIMIT 1',
    [businessId],
    connection,
  );
  const [chat] = await rows(
    'SELECT customer_name,service_name FROM lead_chats WHERE id=?',
    [chatId],
    connection,
  );
  const [quote] = await rows(
    'SELECT id,total_cents FROM live_quotes WHERE chat_id=?',
    [chatId],
    connection,
  );
  if (!owner || !chat) return;
  const first = String(chat.customer_name).trim().split(/\s+/)[0] || 'A customer';
  const service = String(chat.service_name || '').toLowerCase();
  const total = quote ? money(Number(quote.total_cents)) : '';
  const link = quote ? `${appOrigin()}/app/quotes/${quote.id}` : `${appOrigin()}/app`;
  const message: Record<OwnerEvent, { subject: string; text: string }> = {
    review: {
      subject: `${first} wants a ${service || 'quote'}${service ? ' quote' : ''}. It needs your OK.`,
      text: `${first} asked for a ${service || 'quote'}${service ? ' quote' : ''}. Your AI drafted it, and it’s waiting for you to approve or change it:\n${link}`,
    },
    sent: {
      subject: `Quote sent: ${total} to ${first}`,
      text: `Your AI sent ${first} a quote for ${total}.\n\nSee the quote and the conversation:\n${link}`,
    },
    accepted: {
      subject: `${first} accepted your ${total} quote`,
      text: `${first} accepted your quote for ${total}. Get in touch to schedule the work:\n${link}`,
    },
    visit: {
      subject: `${first} would like a site visit`,
      text: `${first} would like you to see the job before going ahead:\n${link}`,
    },
    message: {
      subject: `${first} sent you a message`,
      text: `${first} sent a message about their quote request:\n${link}`,
    },
  };
  await queueEmail(
    {
      businessId,
      dedupeKey: `owner-${event}:${chatId}:${event === 'message' ? Math.floor(Date.now() / 300_000) : 'once'}`,
      to: String(owner.email),
      subject: message[event].subject,
      text: message[event].text,
    },
    connection,
  );
}

export async function customerDecision(req: Request, decision: 'accept' | 'visit') {
  await transaction(async (connection) => {
    const { business, chat } = await chatAccess(req, connection, true);
    const quote = await liveQuoteFor(String(chat.id), connection);
    if (!quote || quote.status !== 'sent')
      throw new ApiError(409, 'QUOTE_NOT_OPEN', 'This quote can’t be changed now.');
    const status = decision === 'accept' ? 'accepted' : 'visit_requested';
    await mutate(
      'UPDATE live_quotes SET status=?,decided_at=UTC_TIMESTAMP(3) WHERE id=?',
      [status, quote.id],
      connection,
    );
    await mutate(
      'UPDATE lead_chats SET status=? WHERE id=?',
      [decision === 'accept' ? 'accepted' : 'visit', chat.id],
      connection,
    );
    const owner = await ownerFirstName(String(business.id));
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'customer',
      kind: 'status',
      text:
        decision === 'accept'
          ? 'Accepted the quote.'
          : 'Asked for a site visit before going ahead.',
    });
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'assistant',
      kind: 'status',
      text:
        decision === 'accept'
          ? `You’re all set. ${owner || business.name} will be in touch to schedule.`
          : `Got it. ${owner || business.name} will get in touch to set up a visit.`,
    });
    if (chat.source !== 'test')
      await notifyOwner(
        String(business.id),
        String(chat.id),
        decision === 'accept' ? 'accepted' : 'visit',
        connection,
      );
  });
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

export async function chatPhoto(req: Request) {
  const { business, chat } = await chatAccess(req);
  const [photo] = await rows(
    'SELECT storage_key FROM attachments WHERE id=? AND business_id=? AND conversation_id=?',
    [z.uuid().parse(req.params.photoId), business.id, chat.id],
  );
  if (!photo) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
  return getPhoto(String(photo.storage_key));
}
