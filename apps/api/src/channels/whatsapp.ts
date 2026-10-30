import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { lossReasonLabel, lossReasons, type LossReason } from '../live/outcomes.js';
import { discountCents, type Quote } from '../practice/types.js';
import { money, priceText } from '../pricing/style.js';

/**
 * WhatsApp's Cloud API: reading what Meta sends us, and shaping and sending the Charm's messages.
 * Nothing here touches the database, so it's the same for every business's number.
 */

const graph = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v26.0'}`;

/** What WhatsApp allows in a message with buttons or a list. */
export const LIMITS = {
  text: 4096,
  body: 1024,
  footer: 60,
  buttons: 3,
  buttonTitle: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  choiceId: 200,
} as const;

/** WhatsApp's error codes we act on. */
export const ERRORS = {
  /** More than 24 hours since the customer last wrote. */
  windowClosed: 131047,
  /** Too many messages to one person too quickly. */
  pairRate: 131056,
} as const;

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message);
  }

  /** Worth trying again shortly, as opposed to a message WhatsApp will never take. */
  get passing() {
    return (
      this.status === 0 ||
      this.status === 429 ||
      this.status >= 500 ||
      this.code === ERRORS.pairRate ||
      this.code === 4 ||
      this.code === 80007
    );
  }
}

/** Meta signs each webhook with the app secret: "sha256=" and the HMAC of the raw body. */
export function signedByMeta(body: Buffer, header: unknown, secret: string): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** One thing a customer sent, flattened out of Meta's webhook. */
export type Inbound = {
  id: string;
  /** The business's number it came to. */
  phoneNumberId: string;
  /** Who sent it: Meta's ID for them on this business's number, or their number before those IDs. */
  sender: string;
  /** Their number, when Meta passes it on. */
  phone: string | null;
  name: string;
  at: string;
  kind: 'text' | 'choice' | 'photo' | 'video' | 'location' | 'voice' | 'file' | 'ignored';
  /** What they wrote, the caption on a photo or video, the place they shared, or what they tapped. */
  text: string;
  /** The ID of the button or list row they tapped. */
  choice?: string;
  mediaId?: string;
};

/** What became of something we sent. */
export type Delivery = {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error: number | null;
};

const media = z.object({ id: z.string(), caption: z.string().optional() });
const choice = z.object({ id: z.string(), title: z.string() });
const messageSchema = z.object({
  id: z.string(),
  from: z.string().optional(),
  from_user_id: z.string().optional(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: media.optional(),
  video: media.optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
  interactive: z
    .object({ button_reply: choice.optional(), list_reply: choice.optional() })
    .optional(),
  button: z.object({ payload: z.string().optional(), text: z.string() }).optional(),
});
const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }),
  contacts: z
    .array(
      z.object({
        wa_id: z.string().optional(),
        user_id: z.string().optional(),
        profile: z.object({ name: z.string().optional() }).optional(),
      }),
    )
    .default([]),
  messages: z.array(messageSchema).default([]),
  statuses: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(),
        errors: z.array(z.object({ code: z.number() })).optional(),
      }),
    )
    .default([]),
});
const webhookSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z.array(z.object({ field: z.string(), value: z.unknown() })).default([]),
      }),
    )
    .default([]),
});

/** A kind of message we don't read becomes a short note of what it was. */
function readMessage(
  message: z.infer<typeof messageSchema>,
): Pick<Inbound, 'kind' | 'text' | 'choice' | 'mediaId'> {
  switch (message.type) {
    case 'text':
      return { kind: 'text', text: message.text?.body ?? '' };
    case 'interactive': {
      const tapped = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return tapped
        ? { kind: 'choice', text: tapped.title, choice: tapped.id }
        : { kind: 'ignored', text: '' };
    }
    case 'button':
      return {
        kind: 'choice',
        text: message.button?.text ?? '',
        choice: message.button?.payload ?? '',
      };
    case 'image':
      return { kind: 'photo', text: message.image?.caption ?? '', mediaId: message.image?.id };
    case 'video':
      return { kind: 'video', text: message.video?.caption ?? '', mediaId: message.video?.id };
    case 'location': {
      const place = message.location;
      if (!place) return { kind: 'ignored', text: '' };
      const named = [place.name, place.address].filter(Boolean).join(', ');
      return {
        kind: 'location',
        text: `My location: ${named || `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`}`,
      };
    }
    case 'audio':
      return { kind: 'voice', text: '' };
    case 'document':
      return { kind: 'file', text: '' };
    default:
      // Reactions, stickers and anything newer.
      return { kind: 'ignored', text: '' };
  }
}

/** What a webhook brings: customers' messages, and what became of ours. Anything else is skipped. */
export function readWebhook(payload: unknown): { messages: Inbound[]; deliveries: Delivery[] } {
  const messages: Inbound[] = [],
    deliveries: Delivery[] = [];
  const parsed = webhookSchema.safeParse(payload);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account')
    return { messages, deliveries };
  for (const change of parsed.data.entry.flatMap((entry) => entry.changes)) {
    if (change.field !== 'messages') continue;
    const value = valueSchema.safeParse(change.value);
    if (!value.success) continue;
    const { metadata, contacts, statuses } = value.data;
    for (const message of value.data.messages) {
      const sender = message.from_user_id ?? message.from;
      if (!sender) continue;
      const contact =
        contacts.find(
          (item) =>
            (message.from_user_id && item.user_id === message.from_user_id) ||
            (message.from && item.wa_id === message.from),
        ) ?? contacts[0];
      const digits = (message.from ?? contact?.wa_id ?? '').replace(/\D/g, '');
      messages.push({
        id: message.id,
        phoneNumberId: metadata.phone_number_id,
        sender,
        phone: digits ? `+${digits}` : null,
        name: (contact?.profile?.name ?? '').trim().slice(0, 160),
        at: new Date(Number(message.timestamp) * 1000 || Date.now()).toISOString(),
        ...readMessage(message),
      });
    }
    for (const status of statuses)
      if (['sent', 'delivered', 'read', 'failed'].includes(status.status))
        deliveries.push({
          id: status.id,
          status: status.status as Delivery['status'],
          error: status.errors?.[0]?.code ?? null,
        });
  }
  return { messages, deliveries };
}

/** A business's number, and the token that sends from it. */
export type Line = { phoneNumberId: string; token: string };
/** Who a message goes to: their number when we have it, or Meta's ID for them. */
export type Addressee = { phone: string | null; userId: string };

export type Choice = { id: string; title: string; description?: string };
export type Outbound =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; footer?: string; buttons: Choice[] }
  | { kind: 'list'; text: string; button: string; rows: Choice[] }
  | { kind: 'image'; mediaId: string; caption: string };

/** The part of a send request that's the message itself. */
export function messageBody(message: Outbound) {
  switch (message.kind) {
    case 'text':
      return {
        type: 'text',
        text: {
          body: message.text.slice(0, LIMITS.text),
          preview_url: /https?:\/\//.test(message.text),
        },
      };
    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.text },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            buttons: message.buttons.map((button) => ({
              type: 'reply',
              reply: { id: button.id, title: button.title },
            })),
          },
        },
      };
    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: message.text },
          action: {
            button: message.button,
            sections: [
              {
                rows: message.rows.map((row) => ({
                  id: row.id,
                  title: row.title,
                  ...(row.description ? { description: row.description } : {}),
                })),
              },
            ],
          },
        },
      };
    case 'image':
      return { type: 'image', image: { id: message.mediaId, caption: message.caption } };
  }
}

async function call(line: Line, path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${graph()}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${line.token}`, ...init.headers },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new WhatsAppError('WhatsApp couldn’t be reached.', null, 0);
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  };
  if (!response.ok)
    throw new WhatsAppError(
      body.error?.message || `WhatsApp answered ${response.status}.`,
      body.error?.code ?? null,
      response.status,
    );
  return body;
}

/** Sends one message and returns WhatsApp's ID for it. */
export async function send(line: Line, to: Addressee, message: Outbound): Promise<string> {
  const body = await call(line, `${line.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Not every kind of message can go to Meta's ID for someone yet, so their number comes first.
      ...(to.phone ? { to: to.phone.replace(/\D/g, '') } : { recipient: to.userId }),
      ...messageBody(message),
    }),
  });
  return z.object({ messages: z.array(z.object({ id: z.string() })).min(1) }).parse(body)
    .messages[0].id;
}

/** Marks their message read and shows the Charm typing, until it answers or for 25 seconds. */
export async function showTyping(line: Line, messageId: string): Promise<void> {
  await call(line, `${line.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  });
}

/**
 * Fetches a photo or video a customer sent. Its download link lasts five minutes, so this runs
 * when the message is handled, not later.
 */
export async function download(
  line: Line,
  mediaId: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const info = z
    .object({
      url: z.url(),
      mime_type: z.string(),
      file_size: z.coerce.number().optional(),
    })
    .parse(await call(line, mediaId));
  if (info.file_size && info.file_size > maxBytes)
    throw new WhatsAppError('That file is too big.', null, 413);
  let response: Response;
  try {
    response = await fetch(info.url, {
      headers: { Authorization: `Bearer ${line.token}` },
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new WhatsAppError('WhatsApp couldn’t be reached.', null, 0);
  }
  if (!response.ok)
    throw new WhatsAppError(`WhatsApp answered ${response.status}.`, null, response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new WhatsAppError('That file is too big.', null, 413);
  return { bytes, mimeType: info.mime_type };
}

/** Uploads a picture so it can be sent, since ours aren't at public links. */
export async function upload(line: Line, bytes: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), 'picture.jpg');
  const body = await call(line, `${line.phoneNumberId}/media`, { method: 'POST', body: form });
  return z.object({ id: z.string() }).parse(body).id;
}

/** Shortens a label to fit, at a word where it can. */
function fit(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** A suggestion's ID holds what it says, so a tap reads like the customer typed it. */
export const CHIP = 'chip:';

/**
 * A Charm message with the suggestions under it: up to three short ones as buttons, more as a list.
 * The customer can always type instead.
 */
export function withChoices(text: string, chips: string[]): Outbound {
  const options = [...new Set(chips.map((chip) => chip.trim()).filter(Boolean))].filter(
    (option) => CHIP.length + option.length <= LIMITS.choiceId,
  );
  if (!options.length || !text.trim() || text.length > LIMITS.body) return { kind: 'text', text };
  const ids = options.map((option) => `${CHIP}${option}`);
  if (
    options.length <= LIMITS.buttons &&
    options.every((option) => option.length <= LIMITS.buttonTitle)
  )
    return {
      kind: 'buttons',
      text,
      buttons: options.map((option, index) => ({ id: ids[index], title: option })),
    };
  return {
    kind: 'list',
    text,
    button: 'Pick one',
    rows: options.slice(0, LIMITS.rows).map((option, index) => ({
      id: ids[index],
      title: fit(option, LIMITS.rowTitle),
      ...(option.length > LIMITS.rowTitle
        ? { description: fit(option, LIMITS.rowDescription) }
        : {}),
    })),
  };
}

/** The buttons on a quote. */
export const QUOTE = {
  accept: 'quote:accept',
  question: 'quote:question',
  decline: 'quote:decline',
} as const;
export const REASON = 'reason:';

/** What the customer sent with their request, which the quote says it's based on. */
export type Sent = { photos: boolean; video: boolean };

const basedOn = (sent: Sent) =>
  sent.photos && sent.video
    ? 'your photos and video'
    : sent.video
      ? 'your video'
      : sent.photos
        ? 'your photos'
        : 'what you told us';

/** Under the price: the same note the quote card on the web carries. */
function footnote(quote: Pick<Quote, 'style' | 'range'>, sent: Sent) {
  const from = basedOn(sent);
  if (quote.style === 'range' && quote.range)
    return `A price range based on ${from}. You’ll know the exact price before any work starts.`;
  if (quote.style === 'estimate')
    return `An estimate based on ${from}. You’ll know the exact price before any work starts.`;
  return from === 'what you told us'
    ? 'Based on what you told us.'
    : `Based on ${from} and what you told us.`;
}

/**
 * The quote as one message: what's in it, the price, a link to the full quote, and the buttons the
 * quote card has on the web. A price range shows what's included, not what each part costs.
 */
export function quoteMessage(input: {
  quote: Quote;
  totalCents: number;
  business: string;
  /** Who books the job, as customers hear it: "Mitch at Some Window Co". */
  owner: string;
  sent: Sent;
  acceptLabel: string;
  link: string;
}): Outbound {
  const { quote } = input;
  const range = quote.style === 'range' && quote.range ? quote.range : null;
  const lines = quote.lines.map((line) =>
    range ? `• ${line.label}` : `• ${line.label}: ${money(line.amountCents)}`,
  );
  const off = discountCents(quote);
  if (off > 0 && !range) lines.push(`• ${quote.discount?.reason || 'Discount'}: −${money(off)}`);
  const when = [
    quote.start ? `Can start: ${quote.start}` : '',
    quote.duration ? `Takes about ${quote.duration.replace(/^about\s+/i, '')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const compose = (shown: string[]) =>
    [
      `*${quote.style === 'estimate' ? 'Estimate' : 'Quote'} from ${input.business}*`,
      '',
      ...shown,
      '',
      `*${range ? 'Price range' : 'Total'}: ${priceText(quote, input.totalCents)}*`,
      ...(when ? [when] : []),
      footnote(quote, input.sent),
      '',
      `See the full quote: ${input.link}`,
    ].join('\n');
  // A long quote keeps its first lines and points to the full quote for the rest.
  let shown = lines.length,
    text = compose(lines);
  while (text.length > LIMITS.body && shown > 1) {
    shown--;
    text = compose([...lines.slice(0, shown), `• and ${lines.length - shown} more`]);
  }
  // The longest that fits WhatsApp's footer.
  const footer =
    [
      `No payment now. ${input.owner} will reach out to book a time.`,
      `No payment now. ${input.owner} will reach out to book.`,
      `No payment now. ${input.business} will reach out to book.`,
    ].find((line) => line.length <= LIMITS.footer) ?? 'No payment now.';
  return {
    kind: 'buttons',
    text: text.slice(0, LIMITS.body),
    footer,
    buttons: [
      {
        id: QUOTE.accept,
        title:
          input.acceptLabel.length <= LIMITS.buttonTitle ? input.acceptLabel : 'Looks good to me',
      },
      { id: QUOTE.question, title: 'Ask a question' },
      { id: QUOTE.decline, title: 'Not going ahead' },
    ],
  };
}

/** Reasons whose web wording is too long for a list row. */
const SHORT_REASONS: Partial<Record<LossReason, string>> = { price: 'Over my budget' };

/** Asked after "Not going ahead", with the reasons the web asks for. */
export function reasonsMessage(owner: string): Outbound {
  return {
    kind: 'list',
    text: `Mind saying why? It helps ${owner}.`,
    button: 'Pick a reason',
    rows: lossReasons.map((reason) => ({
      id: `${REASON}${reason}`,
      title: fit(SHORT_REASONS[reason] ?? lossReasonLabel(reason), LIMITS.rowTitle),
    })),
  };
}
