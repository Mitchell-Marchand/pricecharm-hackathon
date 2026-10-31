import { createHmac, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { tradeName } from '@pricecharm/trades';
import { aiMode, aiProvider, type AiImage } from '../ai/index.js';
import { intakeTurn } from '../ai/intake.js';
import type { Walkaround } from '../ai/walkaround.js';
import { hashToken, newToken } from '../auth.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { isDisposableEmail } from '../email-domains.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { hashingSecret } from '../config.js';
import { settingsFromRow } from '../charm.js';
import { ownerReplyTo, queueEmail } from '../integrations/email.js';
import { json, type Row } from '../models.js';
import { listPastJobs } from '../past-jobs.js';
import { quoteTotal, type DraftedQuote, type Quote } from '../practice/types.js';
import { draftForBusiness } from '../pricing/draft.js';
import { businessReadiness, type ServiceReadiness } from '../pricing/readiness.js';
import {
  priceStyle,
  priceText,
  pricedAs,
  rangeSpread,
  type LearningStyle,
} from '../pricing/style.js';
import {
  estimateGap,
  SOLID_POINTS,
  withinEstimate,
  type Estimate,
  type Rate,
} from '../pricing/rates.js';
import type { JobSpec } from '../pricing/spec.js';
import { formatQuantity } from '../pricing/units.js';
import { questionChecklist } from '../charm-notes.js';
import { getPhoto } from '../storage.js';
import { withAiUsage, withCustomerAiUsage } from '../usage.js';
import { consumeAuthRateLimit } from '../verification.js';
import { liveBillingAccess, recordAcceptance, recordLiveDelivery } from './billing.js';
import { lossReasonPhrase, type LossReason } from './outcomes.js';
import { recordActivity } from '../metrics.js';
import { chooseAcceptLabel, DEFAULT_ACCEPT_LABEL } from './accept-wording.js';
import {
  acceptedMessage,
  businessLogo,
  contactAt,
  contactName,
  visitMessage,
} from './quote-page.js';
import { previewView, startAfterPreview } from './previews.js';
import {
  photoReading,
  photoReadingsAvailable,
  readingPhotos,
  readPhotos,
} from './photo-readings.js';

const CHAT_DAYS = 14;
const EMAIL_LINK_DAYS = 30;

/**
 * The link in every email to this chat's customer, so a later email never retires the one in
 * their quote email. Derived from the server secret, so only its hash is stored. Each email
 * extends how long it works.
 */
export async function chatEmailLink(connection: Sql | undefined, slug: string, chatId: string) {
  const secret = hashingSecret();
  const token = secret
    ? createHmac('sha256', secret).update(`quote-chat-email-link:${chatId}`).digest('base64url')
    : newToken();
  await mutate(
    'UPDATE lead_chats SET email_token_hash=?,email_token_expires_at=? WHERE id=?',
    [hashToken(token), new Date(Date.now() + EMAIL_LINK_DAYS * 86_400_000), chatId],
    connection,
  );
  return { link: `${appOrigin()}/q/${slug}#chat=${chatId}&token=${token}`, days: EMAIL_LINK_DAYS };
}
export const MAX_MESSAGES = 60;

/** How long the one-tap approval link in a "needs your OK" email works. */
export const APPROVE_LINK_DAYS = 3;

/**
 * A link to one waiting quote with an Approve button, for an owner reading email on their phone.
 * It needs no sign-in, and all it can do is show that quote and send it as it is. Each email gets
 * a new one; the token is only in the email, with its hash here.
 */
async function approveLink(connection: Sql | undefined, quoteId: string) {
  const token = newToken();
  await mutate(
    'UPDATE live_quotes SET approve_token_hash=?,approve_token_expires_at=? WHERE id=?',
    [hashToken(token), new Date(Date.now() + APPROVE_LINK_DAYS * 86_400_000), quoteId],
    connection,
  );
  return `${appOrigin()}/approve/${quoteId}#token=${token}`;
}

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
    /** Who the chat says will follow up: the owner's first name unless they chose another. */
    ownerFirstName: await contactName(business),
    logo: await businessLogo(business),
    /** The one website allowed to show the widget. */
    websiteDomain: String(business.website_domain ?? ''),
    /** Taking quote requests: the owner has deployed the agent and hasn't paused it. */
    taking: Boolean(business.link_on),
    /** Takes walk-around videos, which need Meta's models to watch and measure. */
    videos: aiProvider === 'meta' || aiMode === 'demo',
  };
}

export async function addMessage(
  connection: Sql | undefined,
  input: {
    businessId: string;
    chatId: string;
    sender: 'customer' | 'assistant' | 'owner';
    text: string;
    kind?: 'text' | 'status';
    photoIds?: string[];
    videoId?: string;
    chips?: string[];
    /** A reply to a line added a moment before, stamped a millisecond later so it sorts after. */
    reply?: boolean;
  },
) {
  await mutate(
    `INSERT INTO lead_messages (id,business_id,chat_id,sender,kind,text,photo_ids_json,video_id,chips_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,${input.reply ? 'DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1000 MICROSECOND)' : 'UTC_TIMESTAMP(3)'})`,
    [
      randomUUID(),
      input.businessId,
      input.chatId,
      input.sender,
      input.kind ?? 'text',
      input.text,
      JSON.stringify(input.photoIds ?? []),
      input.videoId ?? null,
      JSON.stringify(input.chips ?? []),
    ],
    connection,
  );
}

/** The first thing a customer reads. It says it's an assistant, not a person. */
export const greeting = (businessName: string) =>
  `Hi! I'm the quote assistant for ${businessName}. I can put a price together for you in a couple of minutes. What do you need done?`;

/** Who a WhatsApp chat is with: Meta's ID for them on the business's number, and what Meta shares. */
export type ChannelCustomer = {
  accountId: string;
  userId: string;
  name: string;
  phone: string | null;
};

/**
 * Starts a quote chat. The owner's own test chats are marked so they're never billed or emailed.
 * A WhatsApp chat starts with the name and number Meta passes on, so the customer is never asked
 * for a way to reach them. The customer wrote first there, so there's no greeting: the
 * assistant's first reply says who it is.
 */
export async function startChat(
  business: Row,
  source: 'link' | 'widget' | 'test' | 'whatsapp',
  customer?: ChannelCustomer,
) {
  const token = newToken(),
    id = randomUUID();
  const offered = customer ? [] : await services(String(business.id));
  await transaction(async (connection) => {
    await mutate(
      'INSERT INTO lead_chats (id,business_id,token_hash,source,expires_at,customer_name,customer_phone,channel_account_id,channel_user_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        id,
        business.id,
        hashToken(token),
        source,
        new Date(Date.now() + CHAT_DAYS * 86_400_000),
        customer?.name ?? '',
        customer?.phone ?? null,
        customer?.accountId ?? null,
        customer?.userId ?? null,
      ],
      connection,
    );
    await recordActivity(connection, String(business.id), 'customer_chat', {
      ref: id,
      detail: source,
    });
    if (!customer)
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
  const videos = new Map(
    (await rows('SELECT id,status,result_json FROM lead_videos WHERE chat_id=?', [chat.id])).map(
      (video) => [String(video.id), video],
    ),
  );
  const videoMeasuring = [...videos.values()].some((video) => video.status === 'measuring');
  // Photos only hold up a chat the assistant is answering; after that they're read for the owner.
  const photosMeasuring =
    chat.status === 'chatting' && !chat.human_handoff && (await readingPhotos(chat));
  const test = chat.source === 'test';
  // Customers only ever see a quote the business sent; a held or declined one stays private. The
  // owner testing their own link sees a held one too, with why it would wait.
  const visible =
    quote &&
    (['sent', 'accepted', 'visit_requested', 'lost', 'expired'].includes(String(quote.status)) ||
      (test && quote.status === 'review'));
  // Only the checks that hold a quote: a doubt alone would still reach a real customer, as a range.
  const wouldWait =
    test && quote?.status === 'review'
      ? json<Check[]>(quote.checks_json, [])
          .filter((check) => !check.passed && HOLDS.has(check.id))
          .map((check) => ({ id: check.id, detail: check.detail }))
      : [];
  // Only the customer's own chat reaches here, so this is when they first saw the open quote,
  // which is when its accept button's wording starts to count. Owners' tests never do.
  if (visible && !test && ['sent', 'expired'].includes(String(quote.status)) && !quote.seen_at) {
    const seen = await mutate(
      'UPDATE live_quotes SET seen_at=UTC_TIMESTAMP(3) WHERE id=? AND seen_at IS NULL',
      [quote.id],
    );
    if (seen.affectedRows)
      await recordActivity(undefined, String(business.id), 'quote_seen', {
        ref: String(quote.id),
        detail: String(quote.accept_variant ?? ''),
        value: Number(quote.total_cents),
      });
  }
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
      video: message.video_id ? videoView(videos.get(String(message.video_id))) : null,
      chips: json<string[]>(message.chips_json, []),
      createdAt: new Date(message.created_at).toISOString(),
    })),
    /** Walk-around videos need Meta's models to watch and measure them. */
    videosAllowed: aiProvider === 'meta' || aiMode === 'demo',
    measuring: videoMeasuring || photosMeasuring,
    /** What it's measuring is the customer's photos, not a video. Missing from older APIs. */
    measuringPhotos: photosMeasuring && !videoMeasuring,
    contact: {
      name: String(chat.customer_name),
      email: chat.customer_email ? String(chat.customer_email) : null,
      phone: chat.customer_phone ? String(chat.customer_phone) : null,
    },
    quote: visible
      ? {
          id: String(quote.id),
          status: String(quote.status),
          card: { ...json<Quote>(quote.quote_json, {} as Quote), note: '' },
          sentAt: quote.sent_at ? new Date(quote.sent_at).toISOString() : null,
          /** The words on its accept button. */
          acceptLabel: String(quote.accept_label || DEFAULT_ACCEPT_LABEL),
          /** The customer's photo, and a picture of the job done made from it, once it's ready. */
          preview: business.after_preview
            ? previewView(quote, `/api/v1/chat/${business.slug}/${chat.id}/preview`)
            : null,
        }
      : null,
    waitingForOwner: quote?.status === 'review',
    /** In an owner's test, why this quote would wait for them. */
    wouldWait,
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

/** Who AI work is for: a request, or the address saved with a video that's measured later. */
export type Asker = { ip?: string; socket?: { remoteAddress?: string } };

/** A video in the chat: whether it's measured yet, and what was found, in a few words each. */
function videoView(video: Row | undefined) {
  if (!video) return null;
  const result = json<Walkaround | null>(video.result_json, null);
  return {
    id: String(video.id),
    status: String(video.status) as 'measuring' | 'measured' | 'failed',
    found: result
      ? [
          ...result.counts
            .filter((item) => item.count > 0)
            .map(
              (item) =>
                `${item.atLeast ? 'at least ' : ''}${formatQuantity(item.count, item.unit)}`,
            ),
          ...(result.area
            ? [
                `${result.area.surface} about ${result.area.low}–${formatQuantity(result.area.high, result.area.unit)}`,
              ]
            : []),
        ]
      : [],
  };
}

/** Runs AI work against the right allowance: the owner's for their own tests, else the customers'. */
function withChatUsage<T>(req: Asker, business: Row, chat: Row, task: () => Promise<T>) {
  return chat.source === 'test'
    ? withAiUsage(String(business.id), String(chat.id), task)
    : withCustomerAiUsage(
        {
          businessId: String(business.id),
          sessionId: String(chat.id),
          ip: req.ip || req.socket?.remoteAddress || 'unknown',
        },
        task,
      );
}

/**
 * The assistant's next message while it's still gathering details. Once it has enough, the quote
 * is drafted straight away, unless the owner asks for contact details before the price shows.
 */
async function runIntake(req: Asker, business: Row, chat: Row) {
  const measured = (
    await rows(
      'SELECT result_json FROM lead_videos WHERE chat_id=? AND result_json IS NOT NULL ORDER BY created_at',
      [chat.id],
    )
  ).flatMap((video) => {
    const result = json<Walkaround | null>(video.result_json, null);
    return result ? [result] : [];
  });
  const messages = await rows(
    "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' AND sender IN ('customer','assistant') ORDER BY created_at,id",
    [chat.id],
  );
  const [photoCount] = await rows(
    'SELECT COUNT(*) AS count FROM attachments WHERE business_id=? AND conversation_id=?',
    [business.id, chat.id],
  );
  const [read] = await rows('SELECT photo_reading_json FROM lead_chats WHERE id=?', [chat.id]);
  const photos = read ? photoReading(read) : null;
  const checklist = await questionChecklist(String(business.id));
  const contactFirst = Boolean(business.contact_first) && !hasContact(chat);
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
        checklist,
        serviceName: String(chat.service_name),
        conversation: messages.map((message) => ({
          from: message.sender as 'customer' | 'assistant',
          text: String(message.text),
        })),
        photosReceived: Number(photoCount.count) + measured.length,
        videosAllowed: aiProvider === 'meta' || aiMode === 'demo',
        photoNotes: photos?.notes.length ? photos.notes : undefined,
        videoNotes: measured.flatMap((result) => result.notes),
        contactFirst,
        // On WhatsApp the customer writes first, so the first reply says who it is.
        ...(chat.channel_account_id
          ? { customerStarted: { firstName: String(chat.customer_name).trim().split(/\s+/)[0] } }
          : {}),
      },
      await chatImages(String(business.id), String(chat.id)),
    ),
  );
  // The size measured in a video, or else in the photos, holds until the customer says otherwise.
  const sized =
    measured.findLast((result) => result.quantity) ?? (photos?.quantity ? photos : undefined);
  const spec =
    turn.spec.quantity || !sized
      ? turn.spec
      : { ...turn.spec, quantity: sized.quantity, unit: sized.unit };
  const serviceName = turn.serviceName || (sized?.serviceName ?? '');
  const next = !turn.ready ? 'chatting' : contactFirst ? 'contact' : 'quoting';
  await transaction(async (connection) => {
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'assistant',
      text: turn.reply,
      chips: turn.chips,
    });
    await mutate(
      'UPDATE lead_chats SET service_name=?,ready=?,summary=?,out_of_scope=?,spec_json=?,status=? WHERE id=?',
      [serviceName, turn.ready, turn.summary, turn.outOfScope, JSON.stringify(spec), next, chat.id],
      connection,
    );
  });
  if (next === 'quoting') await prepareLiveQuote(req, String(business.id), String(chat.id));
}

export async function customerMessage(req: Request, text: string) {
  const { business, chat } = await chatAccess(req);
  const [count] = await rows('SELECT COUNT(*) AS count FROM lead_messages WHERE chat_id=?', [
    chat.id,
  ]);
  if (Number(count.count) >= MAX_MESSAGES)
    throw new ApiError(422, 'CHAT_LONG', 'This chat is full. Start a new one to keep going.');
  const [previous] = await rows(
    'SELECT sender FROM lead_messages WHERE chat_id=? ORDER BY created_at DESC LIMIT 1',
    [chat.id],
  );
  await addMessage(undefined, {
    businessId: String(business.id),
    chatId: String(chat.id),
    sender: 'customer',
    text,
  });
  if (chat.status === 'chatting' && !chat.human_handoff) await runIntake(req, business, chat);
  else if (chat.status !== 'chatting' && chat.status !== 'contact') {
    if (chat.source !== 'test') await notifyOwner(String(business.id), String(chat.id), 'message');
    // Said once for a run of messages, so they know someone will answer, not the assistant.
    if (previous?.sender !== 'customer') {
      const owner = (await contactName(business)) || String(business.name);
      await addMessage(undefined, {
        businessId: String(business.id),
        chatId: String(chat.id),
        sender: 'assistant',
        kind: 'status',
        text: `Got it. ${owner} will see this and get back to you.`,
        reply: true,
      });
    }
  }
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
  // Read outside the request, like a video: the chat shows it's looking, and the assistant
  // carries on from what the photos show once they're read.
  if (photoReadingsAvailable()) readPhotosThenAnswer(req, String(chat.id));
  else if (chat.status === 'chatting' && !chat.human_handoff) await runIntake(req, business, chat);
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

/** Reads the chat's new photos outside the request, then the assistant carries on from them. */
export function readPhotosThenAnswer(asker: Asker, chatId: string) {
  void readPhotos(asker, chatId, () => continueChat(asker, chatId)).catch((error) =>
    reportError(error, { event: 'photo_read' }),
  );
}

/**
 * The assistant carries on from whatever the customer sent since it last spoke: a measured video,
 * or a few WhatsApp messages that came in together.
 */
export async function continueChat(asker: Asker, chatId: string) {
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  if (!chat || chat.status !== 'chatting' || chat.human_handoff) return;
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [chat.business_id]);
  if (business) await runIntake(asker, business, chat);
}

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

export type ContactInput = { name: string; email?: string; phone?: string };
type Contact = { name: string; email: string | null; phone: string | null };

/**
 * A customer's name and a way to reach them: an email, a phone number, or both. Nothing is sent
 * to check them first. Customers leave them when they want to hear back.
 */
export function parseContact(input: ContactInput): Contact {
  const typedEmail = input.email?.trim() ?? '',
    typedPhone = input.phone?.trim() ?? '';
  const email = typedEmail ? emailSchema.safeParse(typedEmail) : null;
  if (email && !email.success)
    throw new ApiError(422, 'EMAIL_INVALID', 'That email doesn’t look right.');
  if (email?.data && isDisposableEmail(email.data))
    throw new ApiError(
      422,
      'DISPOSABLE_EMAIL',
      'Please use an email address you’ll keep. Your quote will be sent there.',
    );
  const digits = typedPhone.replace(/\D/g, '');
  if (
    typedPhone &&
    (!/^\+?[\d\s().-]+$/.test(typedPhone) || digits.length < 7 || digits.length > 15)
  )
    throw new ApiError(422, 'PHONE_INVALID', 'That phone number doesn’t look right.');
  if (!email?.data && !typedPhone)
    throw new ApiError(
      422,
      'CONTACT_REQUIRED',
      'Add a phone number or an email so they can reach you.',
    );
  return { name: input.name.trim(), email: email?.data ?? null, phone: typedPhone || null };
}

/** A way to reach the customer: an email, a phone number, or the WhatsApp chat they wrote from. */
const hasContact = (chat: Row) =>
  Boolean(chat.customer_email || chat.customer_phone || chat.channel_user_id);

/**
 * Why the owner can't reach this WhatsApp customer there anymore, or '' when they can. WhatsApp only
 * delivers a business's messages within a day of the customer's last one.
 */
export async function whatsAppClosed(
  chatId: string,
  connection?: Sql,
  /** A quote can still go after that, on the business's quote template, once it has one. */
  quote = false,
): Promise<string> {
  const [chat] = await rows(
    `SELECT c.channel_account_id,c.customer_phone,a.waba_id,
       c.last_inbound_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR) AS open
     FROM lead_chats c LEFT JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?`,
    [chatId],
    connection,
  );
  if (!chat?.channel_account_id || Number(chat.open) || (quote && chat.waba_id)) return '';
  return `It’s been more than a day since they last wrote on WhatsApp, and WhatsApp won’t deliver anything after that.${chat.customer_phone ? ` Call or text them at ${chat.customer_phone}.` : ''}`;
}

/** How the quote card names the customer: "Sam K." */
function cardName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)?.[0]}.` : name.trim();
}

async function saveContact(connection: Sql, chatId: string, contact: Contact) {
  await mutate(
    'UPDATE lead_chats SET customer_name=?,customer_email=COALESCE(?,customer_email),customer_phone=COALESCE(?,customer_phone) WHERE id=?',
    [contact.name, contact.email, contact.phone, chatId],
    connection,
  );
  // The quote card says who it's for, once they've said.
  await mutate(
    "UPDATE live_quotes SET quote_json=JSON_SET(quote_json,'$.customer',?) WHERE chat_id=?",
    [cardName(contact.name), chatId],
    connection,
  );
}

/**
 * The customer leaves their name and a way to reach them. Where the chat is, that does one of:
 * - shows the quote, when the owner asks for details before the price;
 * - passes a quote that waits for the owner to them, now that it has somewhere to go;
 * - on a quote they can see, makes it a lead: a copy to their inbox, or a way for the owner to
 *   answer the question they're about to ask.
 */
export async function leaveContact(
  req: Request,
  input: ContactInput,
  purpose: 'copy' | 'question' = 'copy',
) {
  // Checked before anything about the chat is looked up.
  const contact = parseContact(input);
  const { business, chat } = await chatAccess(req);
  const test = chat.source === 'test';
  if (!test) await consumeAuthRateLimit(`chat-contact-ip:${req.ip}`, 20, 3_600_000);
  const draft = await transaction(async (connection) => {
    const { chat: locked } = await chatAccess(req, connection, true);
    const chatId = String(locked.id),
      businessId = String(business.id);
    const quote = await liveQuoteFor(chatId, connection);
    if (locked.status === 'chatting') {
      await saveContact(connection, chatId, contact);
      return false;
    }
    if (locked.status === 'contact' && !quote) {
      await saveContact(connection, chatId, contact);
      await mutate("UPDATE lead_chats SET status='quoting' WHERE id=?", [chatId], connection);
      return true;
    }
    if (locked.status === 'contact' && quote?.status === 'review') {
      await saveContact(connection, chatId, contact);
      await mutate("UPDATE lead_chats SET status='review' WHERE id=?", [chatId], connection);
      const owner = (await contactName(business, connection)) || String(business.name);
      await addMessage(connection, {
        businessId,
        chatId,
        sender: 'assistant',
        kind: 'status',
        text: contact.email
          ? `Thanks, ${contact.name.split(/\s+/)[0]}. We’ll email you as soon as ${owner} sends it.`
          : `Thanks, ${contact.name.split(/\s+/)[0]}. ${owner} will be in touch with your quote.`,
      });
      if (!test) await notifyOwner(businessId, chatId, 'review', connection);
      return false;
    }
    if (quote && ANSWERABLE.includes(String(quote.status))) {
      if (purpose === 'copy' && !contact.email)
        throw new ApiError(422, 'EMAIL_REQUIRED', 'Add your email so we can send it.');
      await saveContact(connection, chatId, contact);
      if (purpose === 'copy')
        await addMessage(connection, {
          businessId,
          chatId,
          sender: 'assistant',
          kind: 'status',
          text: `Sent. A copy is on its way to ${contact.email}.`,
        });
      if (!test) {
        if (contact.email)
          await notifyCustomerQuote(connection, businessId, chatId, String(business.name));
        // A question tells the owner on its own, a moment later.
        if (purpose === 'copy') await notifyOwner(businessId, chatId, 'lead', connection);
      }
      return false;
    }
    throw new ApiError(409, 'CHAT_DONE', 'Your quote is already on its way.');
  });
  if (draft) await prepareLiveQuote(req, String(business.id), String(chat.id));
  const fresh = await chatAccess(req);
  // Shaped like the old code step's answer, so a page from before this still works.
  return {
    verificationId: null,
    devCode: undefined,
    chat: await chatView(fresh.business, fresh.chat),
  };
}

type Check = { id: string; passed: boolean; detail: string };

/**
 * Checks that keep a quote with the owner: their own settings, a customer who asked for them, a
 * job they don't do, or no price at all. Any other check that fails still sends the quote, as a
 * range at its widest (or the owner's estimate, if that's how they quote while it learns), never
 * as a firm price, and flags it for them.
 */
const HOLDS = new Set(['priced', 'service', 'scope', 'handoff', 'auto', 'limit']);

/** Why the job's size keeps the draft from being held to the owner's rate, if it does. */
function sizeProblem(service: string, spec: JobSpec | null, estimate: Estimate | null) {
  if (!spec?.quantity || !spec.unit) return 'It couldn’t tell how big the job is.';
  const per = spec.unit.replace(/s$/, '') || spec.unit;
  if (!estimate) return `You haven’t priced ${service} by the ${per} before.`;
  const { rate } = estimate;
  switch (estimateGap(estimate)) {
    case 'few':
      return `It has only ${rate.points} ${service} ${rate.points === 1 ? 'job' : 'jobs'} priced by the ${per}.`;
    case 'bigger':
      return `It’s much bigger than the ${service} jobs you’ve priced, which go up to ${formatQuantity(rate.largest, rate.unit)}.`;
    case 'smaller':
      return `It’s much smaller than the ${service} jobs you’ve priced, which start at ${formatQuantity(rate.smallest, rate.unit)}.`;
    default:
      return '';
  }
}

/**
 * The server's checks on the Charm's draft. A failed hold sends the quote to the owner first; any
 * other failure sends it as a wide range and flags it. They are about the job, not about how
 * trained the Charm is: a service it's still learning goes out in the style the owner picked.
 */
async function checkDraft(
  business: Row,
  chat: Row,
  drafted: DraftedQuote,
  totalCents: number,
  estimate: Estimate | null,
  learned: ServiceReadiness | undefined,
  style: LearningStyle,
) {
  const checks: Check[] = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const { limitCents, autoSend } = settingsFromRow(business);
  const offered = await services(String(business.id));
  const service = String(chat.service_name || '');
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
  // A range or an estimate already tells the customer the price may move.
  add(
    'confidence',
    drafted.confidence !== 'low' || style !== 'firm',
    'It isn’t sure about this one.',
  );
  if (limitCents !== null)
    add('limit', totalCents <= limitCents, `It’s over your ${money(limitCents)} limit.`);
  add(
    'service',
    Boolean(service) && offered.includes(service),
    service
      ? `${service} isn’t one of your services.`
      : 'It couldn’t tell which of your services this is.',
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
  // The size has to be one it can hold to the owner's rate: known, and near jobs they've priced.
  // Until it has enough sized prices for the service, there's no rate to hold it to.
  if (learned && learned.sizedPrices >= SOLID_POINTS) {
    const size = sizeProblem(service, json<JobSpec | null>(chat.spec_json, null), estimate);
    add('size', !size, size);
  }
  // With the size known and enough jobs at that size, the total has to match the owner's rate.
  if (estimate?.solid && drafted.lines.length)
    add(
      'rate',
      withinEstimate(totalCents, estimate),
      `It’s far from your usual rate, which comes to about ${money(estimate.cents)} for this size.`,
    );
  add('handoff', !chat.human_handoff, 'The customer asked to talk to you.');
  add('auto', autoSend, 'You approve each quote for now.');
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
  const same = quotes.find((item) => item.service === serviceName && item.quote);
  const match = same ?? quotes.find((item) => item.quote);
  return {
    included: match?.quote?.included ?? [],
    excluded: match?.quote?.excluded ?? [],
    validDays: match?.quote?.validDays ?? 14,
    start: match?.quote?.start ?? '',
    // How long a job takes depends on the service, so only the same service's says.
    duration: same?.quote?.duration ?? '',
  };
}

/** Drafts the quote, checks it, and either sends it or puts it in front of the owner. */
export async function prepareLiveQuote(req: Asker, businessId: string, chatId: string) {
  if (await liveQuoteFor(chatId)) return;
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  const messages = await rows(
    "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' ORDER BY created_at,id",
    [chatId],
  );
  const videos = (
    await rows(
      'SELECT result_json FROM lead_videos WHERE chat_id=? AND result_json IS NOT NULL ORDER BY created_at',
      [chatId],
    )
  ).flatMap((video) => json<Walkaround | null>(video.result_json, null) ?? []);
  const photos = photoReading(chat);
  const saved = json<JobSpec | null>(chat.spec_json, null);
  // A size the photos measured, when nothing else gave one.
  const spec =
    saved && !saved.quantity && photos?.quantity
      ? { ...saved, quantity: photos.quantity, unit: photos.unit }
      : saved;
  if (spec !== saved) {
    // Kept on the chat, so the checks and the owner see the size the quote went on.
    chat.spec_json = JSON.stringify(spec);
    await mutate('UPDATE lead_chats SET spec_json=? WHERE id=?', [chat.spec_json, chatId]);
  }
  // Everything measured and seen in the video and photos: counts, kinds, condition, materials.
  const media = [...videos.flatMap((video) => video.notes), ...(photos?.notes ?? [])];
  let drafted: DraftedQuote;
  let estimate: Estimate | null = null;
  let rates: Rate[] | undefined;
  let engine: unknown = null;
  try {
    ({ drafted, estimate, rates, engine } = await withChatUsage(req, business, chat, async () =>
      draftForBusiness({
        businessId,
        serviceName: String(chat.service_name),
        conversation: messages
          .filter((message) => message.text)
          .map((message) => ({
            from: message.sender === 'customer' ? ('customer' as const) : ('owner' as const),
            text: String(message.text),
          })),
        spec,
        media,
        images: await chatImages(businessId, chatId),
      }),
    ));
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
  const service = String(chat.service_name || '').toLowerCase();
  const learned = (await businessReadiness(businessId, rates)).find(
    (item) => service && item.service.toLowerCase() === service,
  );
  const settings = settingsFromRow(business);
  const progress = learned?.progress ?? 0;
  const checks = await checkDraft(
    business,
    chat,
    drafted,
    totalCents,
    estimate,
    learned,
    priceStyle(progress, settings),
  );
  const failed = checks.filter((check) => !check.passed);
  const held = failed.filter((check) => HOLDS.has(check.id));
  // A doubt about the price shows the customer a range, never nothing and never a firm price.
  const doubted = failed.length > 0 && !held.length;
  const style = doubted
    ? settings.learningStyle === 'estimate'
      ? 'estimate'
      : 'range'
    : priceStyle(progress, settings);
  const spread = rangeSpread(doubted ? 0 : progress, settings.trainedPercent);
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
    const card: Quote = {
      ...pricedAs(style, totalCents, spread),
      number,
      customer: cardName(String(chat.customer_name)),
      // Where the customer is isn't asked for, and the business's own area reads as their name.
      place: '',
      lines: drafted.lines.map((line, index) => ({ id: `l${index}`, ...line })),
      discount: drafted.discount,
      // A formula prices the job but doesn't say when; the owner's usual answer does.
      start: drafted.start || terms.start,
      duration: drafted.duration || terms.duration,
      included: terms.included,
      excluded: terms.excluded,
      validDays: terms.validDays,
      note: '',
      issuedAt: new Date().toISOString(),
    };
    let status: 'sent' | 'review' = held.length ? 'review' : 'sent';
    let reason = failed.map((check) => check.detail).join(' ');
    const quoteId = randomUUID();
    await mutate(
      'INSERT INTO live_quotes (id,business_id,chat_id,number,status,quote_json,draft_json,checks_json,engine_json,review_reason,total_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        quoteId,
        businessId,
        chatId,
        number,
        'review',
        JSON.stringify(card),
        JSON.stringify(drafted),
        JSON.stringify(checks),
        engine ? JSON.stringify(engine) : null,
        reason.slice(0, 600),
        totalCents,
      ],
      connection,
    );
    await recordActivity(connection, businessId, 'quote_drafted', {
      ref: quoteId,
      detail: test ? 'test' : 'live',
      value: totalCents,
    });
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
      // A quote that waits needs somewhere to go once the owner sends it, so a customer who
      // hasn't left their details is asked for them first. Until then, the owner isn't bothered.
      const reachable = test || hasContact(chat);
      await mutate(
        'UPDATE lead_chats SET status=? WHERE id=?',
        [reachable ? 'review' : 'contact', chatId],
        connection,
      );
      const owner = await contactName(business);
      const who = `${owner ? `${owner} at ` : ''}${business.name}`;
      await addMessage(connection, {
        businessId,
        chatId,
        sender: 'assistant',
        kind: 'status',
        // The owner testing their own link sees what their Charm drafted, and why it would wait.
        // On WhatsApp a quote only goes once it's sent, so it says where to send it from.
        text: test
          ? chat.channel_account_id
            ? 'Your Charm drafted this quote and is holding it for you. Send it from PriceCharm and it’ll come here.'
            : 'Here’s the quote your Charm drafted.'
          : !reachable
            ? `${who} wants to look this one over before it goes out. Where should they send it?`
            : chat.customer_email
              ? `Thanks! ${who} will look this over and send your quote shortly. We’ll email you when it’s ready.`
              : `Thanks! ${who} will look this over and get back to you with your quote shortly.`,
      });
      if (!test && reachable) await notifyOwner(businessId, chatId, 'review', connection);
    }
  });
  // The after picture is drawn outside this request and shows up with the quote once it's ready.
  void startAfterPreview(req, chatId).catch((error) =>
    reportError(error, { event: 'after_preview' }),
  );
}

/**
 * Shows the quote to the customer, which is when it's billed, once, whether or not they answer
 * it. When they've already left their details, it lets both sides know; otherwise that waits
 * until they do. Owners' tests are never billed.
 */
export async function markSent(
  connection: Sql,
  input: { businessId: string; quoteId: string; sentBy: 'auto' | 'owner'; test: boolean },
) {
  const [quote] = await rows(
    'SELECT * FROM live_quotes WHERE id=? AND business_id=? FOR UPDATE',
    [input.quoteId, input.businessId],
    connection,
  );
  const [chat] = await rows(
    'SELECT customer_name,customer_email,customer_phone,channel_account_id,channel_user_id FROM lead_chats WHERE id=?',
    [quote.chat_id],
    connection,
  );
  // On WhatsApp the customer sees it once WhatsApp says it reached them, so it's billed then
  // (recordDeliveries in src/channels/conversation.ts). It still has to be allowed to go now.
  if (!input.test && chat.channel_account_id) {
    const access = await liveBillingAccess(input.businessId, connection, Number(quote.total_cents));
    if (!access.canSend) throw new ApiError(409, 'BILLING_LIMIT', access.reason);
  } else if (!input.test)
    await recordLiveDelivery(connection, {
      businessId: input.businessId,
      quoteId: input.quoteId,
      totalCents: Number(quote.total_cents),
      sentBy: input.sentBy,
    });
  const [business] = await rows(
    'SELECT * FROM businesses WHERE id=?',
    [input.businessId],
    connection,
  );
  // The words on its accept button, kept with the quote so it always shows the same ones.
  const button = quote.accept_label
    ? { label: String(quote.accept_label), variant: String(quote.accept_variant ?? '') }
    : await chooseAcceptLabel(business, connection);
  await mutate(
    "UPDATE live_quotes SET status='sent',sent_by=?,sent_at=UTC_TIMESTAMP(3),accept_label=?,accept_variant=? WHERE id=?",
    [input.sentBy, button.label, button.variant || null, input.quoteId],
    connection,
  );
  await mutate("UPDATE lead_chats SET status='sent' WHERE id=?", [quote.chat_id], connection);
  await recordActivity(connection, input.businessId, 'quote_sent', {
    ref: input.quoteId,
    detail: input.test ? 'test' : input.sentBy,
    value: Number(quote.total_cents),
  });
  const first = String(chat.customer_name).trim().split(/\s+/)[0];
  // On WhatsApp the quote comes as its own message that says what it is.
  if (!chat.channel_account_id)
    await addMessage(connection, {
      businessId: input.businessId,
      chatId: String(quote.chat_id),
      sender: 'assistant',
      kind: 'status',
      text: `Here’s your quote${first ? `, ${first}` : ''}.${chat.customer_email ? ' A copy is on its way to your inbox.' : ''}`,
    });
  if (input.test || !hasContact(chat)) return;
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
    'SELECT total_cents,quote_json FROM live_quotes WHERE chat_id=?',
    [chatId],
    connection,
  );
  if (!chat.customer_email) return;
  const { link } = await chatEmailLink(connection, String(business.slug), chatId);
  const first = String(chat.customer_name).trim().split(/\s+/)[0];
  await queueEmail(
    {
      businessId,
      dedupeKey: `live-quote:${chatId}:customer`,
      to: String(chat.customer_email),
      replyTo: await ownerReplyTo(businessId, connection),
      fromName: businessName,
      subject: `Your quote from ${businessName}`,
      text: `Hi${first ? ` ${first}` : ''},\n\nHere’s your quote from ${businessName} for ${priceText(json<Quote | null>(quote.quote_json, null), Number(quote.total_cents))}. See what’s included and accept it here:\n${link}\n\nThe link works for ${EMAIL_LINK_DAYS} days. Keep it to yourself, since anyone with it can see your quote.`,
    },
    connection,
  );
}

type OwnerEvent = 'review' | 'sent' | 'lead' | 'accepted' | 'visit' | 'message' | 'lost';

/**
 * Owners hear about every request that needs them and every customer who leaves a way to reach
 * them. A quote someone only looked at isn't news.
 */
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
    'SELECT customer_name,customer_email,customer_phone,service_name FROM lead_chats WHERE id=?',
    [chatId],
    connection,
  );
  const [quote] = await rows(
    'SELECT id,total_cents,quote_json,review_reason,outcome_reason,outcome_note FROM live_quotes WHERE chat_id=?',
    [chatId],
    connection,
  );
  if (!owner || !chat) return;
  const why = quote?.review_reason ? `\n\nWhy it’s waiting: ${quote.review_reason}` : '';
  const first = String(chat.customer_name).trim().split(/\s+/)[0] || 'A customer';
  const service = String(chat.service_name || '').toLowerCase();
  const total = quote
    ? priceText(json<Quote | null>(quote.quote_json, null), Number(quote.total_cents))
    : '';
  const link = quote ? `${appOrigin()}/app/quotes/${quote.id}` : `${appOrigin()}/app`;
  const reach = [
    chat.customer_phone ? `Phone: ${chat.customer_phone}` : '',
    chat.customer_email ? `Email: ${chat.customer_email}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const details = reach ? `\n\n${reach}` : '';
  // A quote with no price can't go out as it is, so it only gets the link to change it.
  const approve =
    event === 'review' && quote && Number(quote.total_cents) > 0
      ? `\n\nApprove it as it is, no sign-in needed (this link works for ${APPROVE_LINK_DAYS} days):\n${await approveLink(connection, String(quote.id))}\n\nOr look it over and change it first:\n${link}`
      : `\n${link}`;
  const message: Record<OwnerEvent, { subject: string; text: string }> = {
    review: {
      subject: `${first} wants a ${service || 'quote'}${service ? ' quote' : ''}. It needs your OK.`,
      text: `${first} asked for a ${service || 'quote'}${service ? ' quote' : ''}. Your Charm drafted it${Number(quote?.total_cents) > 0 ? ` for ${total}` : ''}, and it’s waiting for you to approve or change it.${approve}${why}`,
    },
    sent: {
      subject: `Quote sent: ${total} to ${first}`,
      text: `Your Charm sent ${first} a quote for ${total}.${details}\n\nSee the quote and the conversation:\n${link}`,
    },
    lead: {
      subject: `${first} asked for a copy of your ${total} quote`,
      text: `${first} asked for your quote for ${total} to be emailed to them. They haven’t said yes yet, so it may be worth a follow-up.${details}\n\nSee the quote and the conversation:\n${link}`,
    },
    accepted: {
      subject: `${first} said yes to your ${total} quote`,
      text: `${first} said yes to your quote for ${total}. Get in touch to schedule the work.${details}\n\n${link}`,
    },
    visit: {
      subject: `${first} would like a site visit`,
      text: `${first} would like you to see the job before going ahead.${details}\n\n${link}`,
    },
    message: {
      subject: `${first} sent you a message`,
      text: `${first} sent a message about their quote request:\n${link}`,
    },
    lost: {
      subject: `${first} isn’t going ahead with your ${total} quote`,
      text: `${first} isn’t going ahead with your quote for ${total}. Their reason: ${lossReasonPhrase(String(quote?.outcome_reason ?? ''))}.${quote?.outcome_note ? `\n\nThey added: “${quote.outcome_note}”` : ''}\n\nYour Charm keeps this with the quote, so it knows how this price went.\n${link}`,
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

/** Statuses a customer can still answer: open, or past its valid days without an answer. */
const ANSWERABLE = ['sent', 'expired'];

export async function customerDecision(
  req: Request,
  decision: 'accept' | 'visit' | 'decline',
  why: { reason: LossReason; note: string } = { reason: 'other', note: '' },
  input?: ContactInput,
) {
  const { chat } = await chatAccess(req);
  await decide(String(chat.id), decision, why, input);
  const fresh = await chatAccess(req);
  return chatView(fresh.business, fresh.chat);
}

/**
 * The customer answers their quote, on the chat page or on WhatsApp. A yes or a visit request
 * needs a way to reach them, which they leave now if they haven't already. That's when the owner
 * has a lead and, on the accepted-quote plan, when it's billed. Only a yes with their details
 * counts as the price winning.
 */
export async function decide(
  chatId: string,
  decision: 'accept' | 'visit' | 'decline',
  why: { reason: LossReason; note: string } = { reason: 'other', note: '' },
  input?: ContactInput,
) {
  const contact = input && decision !== 'decline' ? parseContact(input) : null;
  await transaction(async (connection) => {
    const [chat] = await rows(
      'SELECT * FROM lead_chats WHERE id=? FOR UPDATE',
      [chatId],
      connection,
    );
    const [business] = await rows(
      'SELECT * FROM businesses WHERE id=?',
      [chat.business_id],
      connection,
    );
    const quote = await liveQuoteFor(String(chat.id), connection);
    if (!quote || !ANSWERABLE.includes(String(quote.status)))
      throw new ApiError(409, 'QUOTE_NOT_OPEN', 'This quote can’t be changed now.');
    if (decision !== 'decline') {
      if (contact) await saveContact(connection, String(chat.id), contact);
      else if (!hasContact(chat))
        throw new ApiError(
          422,
          'CONTACT_REQUIRED',
          `Add your name and a phone number or an email, so ${(await contactName(business, connection)) || business.name} can reach you.`,
        );
    }
    const status = { accept: 'accepted', visit: 'visit_requested', decline: 'lost' }[decision];
    await mutate(
      'UPDATE live_quotes SET status=?,decided_at=UTC_TIMESTAMP(3),outcome_reason=?,outcome_note=? WHERE id=?',
      [
        status,
        decision === 'decline' ? why.reason : '',
        decision === 'decline' ? why.note : '',
        quote.id,
      ],
      connection,
    );
    await mutate(
      'UPDATE lead_chats SET status=? WHERE id=?',
      [{ accept: 'accepted', visit: 'visit', decline: 'closed' }[decision], chat.id],
      connection,
    );
    await recordActivity(connection, String(business.id), 'quote_outcome', {
      ref: String(quote.id),
      detail: { accept: 'accepted', visit: 'visit', decline: 'lost' }[decision],
      value: Number(quote.total_cents),
    });
    // On the accepted-quote plan, this is when the quote is charged.
    if (decision === 'accept')
      await recordAcceptance(connection, {
        businessId: String(business.id),
        quoteId: String(quote.id),
        totalCents: Number(quote.total_cents),
      });
    // On WhatsApp nothing says who the owner is, so they're named with the business.
    const owner = chat.channel_account_id
      ? await contactAt(business)
      : (await contactName(business)) || String(business.name);
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'customer',
      kind: 'status',
      text: {
        accept: 'Said yes to the quote.',
        visit: 'Asked for a site visit before going ahead.',
        decline: `Isn’t going ahead: ${lossReasonPhrase(why.reason)}.`,
      }[decision],
    });
    await addMessage(connection, {
      businessId: String(business.id),
      chatId: String(chat.id),
      sender: 'assistant',
      kind: 'status',
      reply: true,
      // The owner can write their own lines for after a yes and a visit request.
      text:
        decision === 'accept'
          ? await acceptedMessage(
              business,
              json<Quote | null>(quote.quote_json, null)?.style === 'range',
              undefined,
              owner,
            )
          : decision === 'visit'
            ? await visitMessage(business, undefined, owner)
            : `Thanks for letting ${owner} know.`,
    });
    if (chat.source !== 'test')
      await notifyOwner(
        String(business.id),
        String(chat.id),
        ({ accept: 'accepted', visit: 'visit', decline: 'lost' } as const)[decision],
        connection,
      );
  });
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
