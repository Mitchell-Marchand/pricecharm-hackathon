import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { aiMode, aiProvider } from '../ai/index.js';
import { mutate, rows, transaction } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { recordActivity } from '../metrics.js';
import { json, type Row } from '../models.js';
import type { Quote } from '../practice/types.js';
import { storeImage } from '../uploads.js';
import { DEFAULT_ACCEPT_LABEL } from '../live/accept-wording.js';
import {
  addMessage,
  chatEmailLink,
  continueChat,
  decide,
  MAX_MESSAGES,
  notifyOwner,
  startChat,
  type Asker,
} from '../live/chat.js';
import { recordLiveDelivery } from '../live/billing.js';
import { lossReasons, type LossReason } from '../live/outcomes.js';
import { readPhotos } from '../live/photo-readings.js';
import { previewFile } from '../live/previews.js';
import { contactName } from '../live/quote-page.js';
import { kickVideos, storeVideo } from '../live/videos.js';
import {
  CHIP,
  ERRORS,
  QUOTE,
  REASON,
  WhatsAppError,
  download,
  quoteMessage,
  readWebhook,
  reasonsMessage,
  send,
  showTyping,
  upload,
  withChoices,
  type Addressee,
  type Delivery,
  type Inbound,
  type Line,
  type Outbound,
} from './whatsapp.js';

/**
 * Customers' WhatsApp chats with a business's Charm. Each message is kept in the inbox, then the
 * chat takes it as it takes one from the quote link, and whatever the Charm or the owner says in
 * the chat goes back on WhatsApp. One sender's messages are handled one at a time, in order.
 */

/** Messages that arrive this close together, like a few photos picked at once, get one answer. */
const BURST_MS = 1500;
/** How long one answer may hold a sender before someone else may pick them up. */
const LEASE_SECONDS = 180;
/** markSent writes "Here's your quote" just after it marks the quote sent; the quote follows it. */
const QUOTE_INTRO_MS = 2000;
const MAX_PHOTO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const PREVIEW_CAPTION =
  'What it could look like when it’s done. This picture was made with AI from your photo, so the real result can look different.';

/** Our test number sends with the platform's token. Each business's own comes with Embedded Signup. */
function lineFor(account: Row): Line {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set WHATSAPP_ACCESS_TOKEN to answer on WhatsApp.');
  return { phoneNumberId: String(account.platform_id), token };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lease(accountId: string, sender: string): Promise<string | null> {
  const token = randomUUID();
  // A held lease stays with its holder until it runs out; MariaDB applies these left to right.
  await mutate(
    `INSERT INTO channel_senders (account_id,sender,lease_token,lease_until) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${LEASE_SECONDS} SECOND))
     ON DUPLICATE KEY UPDATE
       lease_token=IF(lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3),VALUES(lease_token),lease_token),
       lease_until=IF(lease_token=VALUES(lease_token),VALUES(lease_until),lease_until)`,
    [accountId, sender, token],
  );
  const [held] = await rows(
    'SELECT lease_token FROM channel_senders WHERE account_id=? AND sender=?',
    [accountId, sender],
  );
  return held?.lease_token === token ? token : null;
}

async function release(accountId: string, sender: string, token: string) {
  await mutate(
    'UPDATE channel_senders SET lease_token=NULL,lease_until=NULL WHERE account_id=? AND sender=? AND lease_token=?',
    [accountId, sender, token],
  );
}

/** Runs a task while holding this sender, or not at all when someone else holds them. */
async function holding(accountId: string, sender: string, task: () => Promise<void>) {
  const token = await lease(accountId, sender);
  if (!token) return false;
  try {
    await task();
  } finally {
    await release(accountId, sender, token);
  }
  return true;
}

const waiting = (accountId: string, sender: string) =>
  rows(
    "SELECT * FROM channel_inbox WHERE account_id=? AND sender=? AND status='waiting' ORDER BY sent_at,created_at",
    [accountId, sender],
  );

/** Keeps each customer message once and records what became of ours. Returns who to answer. */
export async function receive(payload: unknown) {
  const { messages, deliveries } = readWebhook(payload);
  const senders = new Map<string, { accountId: string; sender: string }>();
  for (const message of messages) {
    const [account] = await rows(
      "SELECT id FROM channel_accounts WHERE kind='whatsapp' AND platform_id=? AND status='connected'",
      [message.phoneNumberId],
    );
    if (!account) continue;
    const saved = await mutate(
      'INSERT IGNORE INTO channel_inbox (id,account_id,sender,platform_message_id,payload_json,sent_at) VALUES (?,?,?,?,?,?)',
      [
        randomUUID(),
        account.id,
        message.sender,
        message.id,
        JSON.stringify(message),
        new Date(message.at),
      ],
    );
    if (saved.affectedRows)
      senders.set(`${account.id} ${message.sender}`, {
        accountId: String(account.id),
        sender: message.sender,
      });
  }
  await recordDeliveries(deliveries);
  return [...senders.values()];
}

/**
 * Answers whatever this sender has waiting. If someone else is already answering them, that one
 * looks again before letting go, so nothing is left behind.
 */
export async function answer(accountId: string, sender: string): Promise<void> {
  while ((await waiting(accountId, sender)).length)
    if (!(await holding(accountId, sender, () => answerWaiting(accountId, sender)))) return;
}

async function answerWaiting(accountId: string, sender: string) {
  const [account] = await rows('SELECT * FROM channel_accounts WHERE id=?', [accountId]);
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [account.business_id]);
  const line = lineFor(account);
  const first = await waiting(accountId, sender);
  if (!first.length) return;
  // The business isn't taking quote requests, so these are left for the owner.
  if (!business.link_on) {
    await mutate(
      `UPDATE channel_inbox SET status='skipped' WHERE id IN (${first.map(() => '?').join(',')})`,
      first.map((item) => item.id),
    );
    return;
  }
  const latest = json<Inbound | null>(first.at(-1)?.payload_json, null);
  if (latest) await showTyping(line, latest.id).catch(() => {});
  await pause(BURST_MS);
  const items = await waiting(accountId, sender);
  await mutate(
    `UPDATE channel_inbox SET status='handling' WHERE id IN (${items.map(() => '?').join(',')})`,
    items.map((item) => item.id),
  );
  const messages = items.flatMap((item) => {
    const message = json<Inbound | null>(item.payload_json, null);
    return message ? [message] : [];
  });
  const chat = await openChat(account, business, messages[0]);
  const chatId = String(chat.id);
  await mutate(
    "UPDATE lead_chats SET last_inbound_at=UTC_TIMESTAMP(3),customer_name=IF(customer_name='',?,customer_name) WHERE id=?",
    [messages[0].name, chatId],
  );
  const asker: Asker = { ip: `wa:${sender}`.slice(0, 64) };
  const owner = (await contactName(business)) || String(business.name);
  let carryOn = false,
    forOwner = false;
  try {
    for (const message of messages) {
      const [current] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
      const next = await take(line, business, current, message, asker, owner);
      carryOn ||= next === 'charm';
      forOwner ||= next === 'owner';
    }
    // Photos are read before the answer, so it covers what they show. The customer sees typing.
    if (messages.some((message) => message.kind === 'photo')) await readPhotos(asker, chatId);
    if (carryOn) await continueChat(asker, chatId);
    if (forOwner) await passToOwner(business, chatId, owner);
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'whatsapp_answer' });
    await addMessage(undefined, {
      businessId: String(business.id),
      chatId,
      sender: 'assistant',
      kind: 'status',
      text: `Sorry, I can’t answer that right now. ${owner} will get back to you here.`,
    });
    await notifyOwner(String(business.id), chatId, 'message');
  }
  await mutate(
    `UPDATE channel_inbox SET status='handled' WHERE id IN (${items.map(() => '?').join(',')})`,
    items.map((item) => item.id),
  );
  await deliver(chatId);
}

/**
 * The sender's open chat: the latest that hasn't been turned down, run out or filled up.
 * Otherwise a new one, which starts with the name and number Meta passes on.
 */
async function openChat(account: Row, business: Row, first: Inbound) {
  const [open] = await rows(
    `SELECT c.*,(SELECT COUNT(*) FROM lead_messages m WHERE m.chat_id=c.id) AS message_count FROM lead_chats c
     WHERE c.channel_account_id=? AND c.channel_user_id=? AND c.expires_at>UTC_TIMESTAMP(3) AND c.status<>'closed'
     ORDER BY c.created_at DESC LIMIT 1`,
    [account.id, first.sender],
  );
  if (open && Number(open.message_count) < MAX_MESSAGES - 5) return open;
  // The owner trying their own line is a test, like trying their own quote link.
  const tests = String(account.test_numbers ?? '').split(',');
  const owner = Boolean(first.phone) && tests.includes(String(first.phone).replace(/\D/g, ''));
  const { chatId } = await startChat(business, owner ? 'test' : 'whatsapp', {
    accountId: String(account.id),
    userId: first.sender,
    name: first.name,
    phone: first.phone,
  });
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  return chat;
}

/** A line from the Charm that stays out of what the AI reads: an acknowledgement or a limit. */
function note(business: Row, chatId: string, text: string) {
  return addMessage(undefined, {
    businessId: String(business.id),
    chatId,
    sender: 'assistant',
    kind: 'status',
    text,
  });
}

/** While the Charm is still gathering details it answers; once there's a quote, the owner does. */
const nextFor = (chat: Row) =>
  chat.status === 'chatting' && !chat.human_handoff
    ? ('charm' as const)
    : chat.status !== 'chatting' && chat.status !== 'contact'
      ? ('owner' as const)
      : null;

/** Puts one message in the chat. Says who answers it: the Charm, the owner, or no one yet. */
async function take(
  line: Line,
  business: Row,
  chat: Row,
  message: Inbound,
  asker: Asker,
  owner: string,
): Promise<'charm' | 'owner' | null> {
  const businessId = String(business.id),
    chatId = String(chat.id);
  const says = async (text: string) => {
    await addMessage(undefined, { businessId, chatId, sender: 'customer', text });
    return nextFor(chat);
  };
  try {
    switch (message.kind) {
      case 'text':
      case 'location':
        return message.text.trim() ? await says(message.text.trim().slice(0, 2000)) : null;
      case 'choice':
        return await chose(line, business, chat, message, owner, says);
      case 'photo': {
        if (!message.mediaId) return null;
        const { bytes } = await download(line, message.mediaId, MAX_PHOTO_BYTES);
        const saved = await storeImage(bytes, 'whatsapp-photo.jpg', businessId, {
          conversationId: chatId,
        });
        await addMessage(undefined, {
          businessId,
          chatId,
          sender: 'customer',
          text: message.text.trim().slice(0, 2000),
          photoIds: [String(saved.id)],
        });
        return nextFor(chat);
      }
      case 'video':
        return await video(line, business, chat, message, asker);
      case 'voice':
        await addMessage(undefined, {
          businessId,
          chatId,
          sender: 'customer',
          kind: 'status',
          text: 'Sent a voice note.',
        });
        await note(
          business,
          chatId,
          'I can’t listen to voice notes yet. Could you type that instead?',
        );
        return null;
      case 'file':
        await note(business, chatId, 'I can read messages, photos and videos here, but not files.');
        return null;
      default:
        return null;
    }
  } catch (error) {
    // A limit the chat page would show, like a fourth photo, is said in the chat instead.
    if (!(error instanceof ApiError) && !(error instanceof WhatsAppError)) throw error;
    if (error instanceof WhatsAppError)
      reportError(error, { event: 'whatsapp_media', code: String(error.code ?? error.status) });
    await note(
      business,
      chatId,
      error instanceof ApiError
        ? error.message
        : 'That didn’t come through. Could you send it again?',
    );
    return null;
  }
}

/** A tap on a suggestion reads as typed; a tap on the quote's buttons answers the quote. */
async function chose(
  line: Line,
  business: Row,
  chat: Row,
  message: Inbound,
  owner: string,
  says: (text: string) => Promise<'charm' | 'owner' | null>,
) {
  const choice = message.choice ?? '';
  const chatId = String(chat.id);
  if (choice.startsWith(CHIP)) return says(choice.slice(CHIP.length));
  if (choice === QUOTE.accept) {
    await decide(chatId, 'accept');
    return null;
  }
  if (choice.startsWith(REASON)) {
    const reason = choice.slice(REASON.length);
    await decide(chatId, 'decline', {
      reason: (lossReasons as string[]).includes(reason) ? (reason as LossReason) : 'other',
      note: '',
    });
    return null;
  }
  if (choice === QUOTE.decline) {
    // Like the chat page, the reasons are asked for but aren't part of the chat.
    await send(line, addressee(chat), reasonsMessage(owner));
    return null;
  }
  if (choice === QUOTE.question) {
    await note(business, chatId, `Sure, what would you like to know? I’ll pass it on to ${owner}.`);
    return null;
  }
  return message.text.trim() ? says(message.text.trim()) : null;
}

const run = promisify(execFile);

/**
 * Five stills spread through a video, as the browser takes them on the chat page, when ffmpeg is
 * installed. Without it the video still goes, as it does from a browser that can't play it.
 */
async function stillsFrom(bytes: Buffer) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-video-'));
  const stills: { bytes: Buffer; ms: number }[] = [];
  try {
    const file = path.join(folder, 'video');
    await fs.writeFile(file, bytes);
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 20_000 },
    );
    const seconds = Number(stdout.trim());
    if (!(seconds > 0)) return { durationMs: null, stills };
    for (let index = 0; index < 5; index++) {
      const at = seconds * ((index + 0.5) / 5);
      const still = path.join(folder, `${index}.jpg`);
      await run(
        'ffmpeg',
        ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-q:v', '3', still],
        { timeout: 30_000 },
      );
      stills.push({ bytes: await fs.readFile(still), ms: Math.round(at * 1000) });
    }
    return { durationMs: Math.round(seconds * 1000), stills };
  } catch {
    return { durationMs: null, stills };
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

/** A walk-around video is saved and measured like one from the chat page, then the Charm carries on. */
async function video(line: Line, business: Row, chat: Row, message: Inbound, asker: Asker) {
  const chatId = String(chat.id);
  if (!message.mediaId) return null;
  if (chat.status !== 'chatting' || chat.human_handoff) {
    await addMessage(undefined, {
      businessId: String(business.id),
      chatId,
      sender: 'customer',
      kind: 'status',
      text: 'Sent a video.',
    });
    return nextFor(chat);
  }
  if (aiProvider !== 'meta' && aiMode !== 'demo') {
    await note(
      business,
      chatId,
      'I can’t watch videos here yet. Could you send a photo or two instead?',
    );
    return null;
  }
  const { bytes } = await download(line, message.mediaId, MAX_VIDEO_BYTES);
  const { durationMs, stills } = await stillsFrom(bytes);
  await storeVideo(business, chat, { bytes, durationMs, stills, requester: String(asker.ip) });
  await note(
    business,
    chatId,
    'Got your video. I’m counting what’s in it now, which takes a minute or two.',
  );
  await kickVideos(chatId);
  return null;
}

/** Messages after the quote go to the owner, and the customer hears that once. */
async function passToOwner(business: Row, chatId: string, owner: string) {
  const [chat] = await rows('SELECT source FROM lead_chats WHERE id=?', [chatId]);
  if (chat?.source !== 'test') await notifyOwner(String(business.id), chatId, 'message');
  const text = `I’ve passed that on to ${owner}. They’ll reply to you here.`;
  const [last] = await rows(
    "SELECT text FROM lead_messages WHERE chat_id=? AND sender IN ('assistant','owner') ORDER BY created_at DESC,id DESC LIMIT 1",
    [chatId],
  );
  if (last?.text !== text) await note(business, chatId, text);
}

const addressee = (chat: Row): Addressee => ({
  phone: chat.customer_phone ? String(chat.customer_phone) : null,
  userId: String(chat.channel_user_id),
});

/** Sends one message. Null when it's worth trying again on the next pass. */
async function attempt(line: Line, to: Addressee, message: Outbound) {
  try {
    return { id: await send(line, to, message), refused: null };
  } catch (error) {
    if (!(error instanceof WhatsAppError)) throw error;
    if (error.passing) return null;
    reportError(error, { event: 'whatsapp_send', code: String(error.code ?? error.status) });
    return { id: null, refused: error.code === ERRORS.windowClosed ? 'window_closed' : 'failed' };
  }
}

/** What the owner writes goes out under their name, so the customer can tell it's them. */
function outboundFor(message: Row, owner: string): Outbound | null {
  const text = String(message.text).trim();
  if (!text) return null;
  if (message.sender === 'owner') return { kind: 'text', text: `*${owner}*\n${text}` };
  return withChoices(text, json<string[]>(message.chips_json, []));
}

/**
 * Sends what's been said in a chat that hasn't gone out on WhatsApp yet, in order: the Charm's and
 * the owner's messages, the quote once it's shown, and its after picture once it's drawn. Stops at
 * the first message WhatsApp can't take right now, so nothing goes out of order.
 */
async function deliver(chatId: string): Promise<void> {
  const [chat] = await rows(
    `SELECT c.*,a.platform_id,a.status AS account_status FROM lead_chats c
     JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=?`,
    [chatId],
  );
  if (!chat || chat.account_status !== 'connected') return;
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [chat.business_id]);
  const line = lineFor(chat);
  const to = addressee(chat);
  const owner = (await contactName(business)) || String(business.name);
  const messages = await rows(
    "SELECT * FROM lead_messages WHERE chat_id=? AND sender IN ('assistant','owner') AND channel_sent_at IS NULL AND channel_status IS NULL ORDER BY created_at,id",
    [chatId],
  );
  const [quote] = await rows(
    "SELECT * FROM live_quotes WHERE chat_id=? AND status IN ('sent','expired') AND channel_sent_at IS NULL",
    [chatId],
  );
  const quoteAfter = quote ? new Date(quote.sent_at).getTime() + QUOTE_INTRO_MS : Infinity;
  let quoteDone = !quote;
  const sendQuote = async () => {
    const card = json<Quote | null>(quote.quote_json, null);
    if (!card) return true;
    const { link } = await chatEmailLink(undefined, String(business.slug), chatId);
    const result = await attempt(
      line,
      to,
      quoteMessage({
        quote: card,
        totalCents: Number(quote.total_cents),
        business: String(business.name),
        owner,
        acceptLabel: String(quote.accept_label || DEFAULT_ACCEPT_LABEL),
        link,
      }),
    );
    if (!result) return false;
    await mutate(
      'UPDATE live_quotes SET channel_message_id=?,channel_sent_at=UTC_TIMESTAMP(3) WHERE id=?',
      [result.id, quote.id],
    );
    return true;
  };
  for (const message of messages) {
    if (!quoteDone && new Date(message.created_at).getTime() > quoteAfter) {
      if (!(await sendQuote())) return;
      quoteDone = true;
    }
    const outbound = outboundFor(message, owner);
    const result = outbound ? await attempt(line, to, outbound) : { id: null, refused: 'empty' };
    if (!result) return;
    await mutate(
      'UPDATE lead_messages SET channel_message_id=?,channel_sent_at=?,channel_status=? WHERE id=?',
      [result.id, result.id ? new Date() : null, result.refused ?? 'sent', message.id],
    );
  }
  if (!quoteDone && !(await sendQuote())) return;
  await sendPreview(line, to, business, chatId);
}

/** The after picture follows the quote once Muse Image has drawn it. */
async function sendPreview(line: Line, to: Addressee, business: Row, chatId: string) {
  if (!business.after_preview) return;
  const [quote] = await rows(
    "SELECT * FROM live_quotes WHERE chat_id=? AND channel_sent_at IS NOT NULL AND channel_preview_sent_at IS NULL AND preview_status='ready'",
    [chatId],
  );
  if (!quote) return;
  let mediaId: string;
  try {
    mediaId = await upload(line, await previewFile(quote, 'after'), 'image/jpeg');
  } catch (error) {
    if (error instanceof WhatsAppError && error.passing) return;
    reportError(error, { event: 'whatsapp_preview' });
    mediaId = '';
  }
  const result = mediaId
    ? await attempt(line, to, { kind: 'image', mediaId, caption: PREVIEW_CAPTION })
    : { id: null, refused: 'failed' };
  if (!result) return;
  await mutate('UPDATE live_quotes SET channel_preview_sent_at=UTC_TIMESTAMP(3) WHERE id=?', [
    quote.id,
  ]);
}

const STATUS_ORDER = "'','sent','delivered','read','failed'";

/**
 * What became of what we sent. Updates can arrive out of order, so one never goes back. A quote
 * that reached the customer counts as seen, which is when its accept wording starts to count.
 */
export async function recordDeliveries(deliveries: Delivery[]) {
  for (const delivery of deliveries) {
    await mutate(
      `UPDATE lead_messages SET channel_status=? WHERE channel_message_id=? AND FIELD(COALESCE(channel_status,''),${STATUS_ORDER})<FIELD(?,${STATUS_ORDER})`,
      [delivery.status, delivery.id, delivery.status],
    );
    if (delivery.status !== 'delivered' && delivery.status !== 'read') continue;
    // Any quote that's gone out: a quick tap can answer it before WhatsApp's receipt arrives.
    const [quote] = await rows(
      `SELECT q.id,q.business_id,q.accept_variant,q.total_cents,q.sent_by,c.source FROM live_quotes q
       JOIN lead_chats c ON c.id=q.chat_id
       WHERE q.channel_message_id=? AND q.seen_at IS NULL AND q.status IN ('sent','expired','accepted','visit_requested','lost')`,
      [delivery.id],
    );
    if (!quote) continue;
    const seen = await mutate(
      'UPDATE live_quotes SET seen_at=UTC_TIMESTAMP(3) WHERE id=? AND seen_at IS NULL',
      [quote.id],
    );
    if (!seen.affectedRows) continue;
    await recordActivity(undefined, String(quote.business_id), 'quote_seen', {
      ref: String(quote.id),
      detail: String(quote.accept_variant ?? ''),
      value: Number(quote.total_cents),
    });
    if (quote.source !== 'test') await billShown(quote);
  }
}

/**
 * A quote on WhatsApp is shown once it reaches the customer, so that's when it's billed, once.
 * It went out when the owner's billing allowed it, so a limit reached since doesn't charge it.
 */
async function billShown(quote: Row) {
  await transaction(async (connection) => {
    try {
      await recordLiveDelivery(connection, {
        businessId: String(quote.business_id),
        quoteId: String(quote.id),
        totalCents: Number(quote.total_cents),
        sentBy: quote.sent_by === 'owner' ? 'owner' : 'auto',
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'BILLING_LIMIT')) throw error;
    }
  });
}

/**
 * Sends what's waiting in WhatsApp chats still inside their 24 hours: an owner's reply, a quote
 * they approved, an after picture that finished drawing. Messages a restart left behind are
 * answered too. The worker runs this every couple of seconds.
 */
export async function deliverWaiting(): Promise<void> {
  for (const chat of await rows(
    'SELECT id,channel_account_id,channel_user_id FROM lead_chats WHERE last_inbound_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR) AND channel_account_id IS NOT NULL',
  ))
    await holding(String(chat.channel_account_id), String(chat.channel_user_id), () =>
      deliver(String(chat.id)),
    );
  await mutate(
    "UPDATE channel_inbox SET status='waiting' WHERE status='handling' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)",
  );
  for (const left of await rows(
    "SELECT DISTINCT account_id,sender FROM channel_inbox WHERE status='waiting' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE)",
  ))
    await answer(String(left.account_id), String(left.sender));
}
