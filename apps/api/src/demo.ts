import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { TRADES_BY_ID } from '@pricecharm/trades';
import { DEMOS_BY_TRADE, type Demo } from '@pricecharm/trades/demos';
import { aiMode } from './ai/index.js';
import { fitsReady, intakeTurn, readyLine } from './ai/intake.js';
import { draftQuote, type PricingHistory } from './ai/quote-engine.js';
import { hashingSecret } from './config.js';
import { ApiError, ok, rateLimit } from './http.js';
import { verifyHuman } from './human-check.js';
import { quoteTotal, type Quote } from './practice/types.js';
import { withDemoAiUsage } from './usage.js';
import { recordRequestEvent } from './metrics.js';

/**
 * The live demo on the marketing site: a visitor chats with a sample business's assistant and
 * gets a quote, the way a real customer would. Nothing is stored. Abuse is held off by:
 * - a bot check before each demo chat starts, which earns a signed pass that expires in an hour
 * - per-chat, per-visitor and app-wide demo allowances (see reserveDemoAiCall)
 * - short messages and short chats
 * - the business, its services and prices coming from the server's own sample data, never the
 *   visitor, and quote totals added up here
 * - no uploads: a visitor can send the sample business's own photos, by name, and the assistant
 *   reads what they show from the server's captions
 * - replies and quote lines carrying links, emails or phone numbers being replaced
 */
export const demoRouter = Router();
demoRouter.use('/demo', rateLimit(30, 60_000));

const PASS_MS = 60 * 60_000;
/** Customer messages in one demo chat. */
const MAX_CUSTOMER_MESSAGES = 10;
const MAX_CUSTOMER_TEXT = 300;

function passKey(): Buffer {
  const secret = hashingSecret();
  if (!secret) throw new ApiError(503, 'DEMO_UNAVAILABLE', 'The live demo is unavailable.');
  return createHmac('sha256', secret).update('pricecharm-demo-pass-v1').digest();
}

function issuePass(): string {
  const payload = `${randomUUID()}.${Date.now() + PASS_MS}`;
  return `${payload}.${createHmac('sha256', passKey()).update(payload).digest('base64url')}`;
}

/** The demo chat's id, if its pass is genuine and current. */
function checkPass(pass: string): string {
  const match = /^([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(pass);
  const expired = () =>
    new ApiError(401, 'DEMO_PASS', 'This demo chat has expired. Start over to try again.');
  if (!match || Number(match[2]) <= Date.now()) throw expired();
  const expected = createHmac('sha256', passKey()).update(`${match[1]}.${match[2]}`).digest();
  const given = Buffer.from(match[3], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw expired();
  return match[1];
}

/** Links, emails and phone numbers have no place in a demo, and would make it useful to scammers. */
const LINK_OR_EMAIL =
  /https?:\/\/|www\.|\b[\w.-]+\.(?:com|net|org|io|co|biz|info|xyz|ly|me|app)\b|[\w.+-]+@[\w-]+\./i;
const NUMBER_RUN = /\+?\(?\d[\d\s().-]{8,}\d/g;
export function hasContactDetails(text: string): boolean {
  if (LINK_OR_EMAIL.test(text)) return true;
  // A phone number has at least ten digits; "10 - 15 - 20" doesn't count.
  return (text.match(NUMBER_RUN) ?? []).some((run) => run.replace(/\D/g, '').length >= 10);
}
const clean = (text: string, fallback: string) => (hasContactDetails(text) ? fallback : text);

const message = z
  .object({
    from: z.enum(['customer', 'assistant']),
    text: z
      .string()
      .transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
      .pipe(z.string().min(1).max(600)),
    /** Sample photo keys the visitor sent with this message. */
    photos: z
      .array(z.string().regex(/^[a-z0-9-]{1,60}$/))
      .max(2)
      .optional(),
  })
  .strict();
const chatSchema = z
  .object({
    tradeId: z.string().max(40),
    pass: z.string().max(200),
    serviceName: z.string().trim().max(80).default(''),
    messages: z
      .array(message)
      .min(1)
      .max(2 * MAX_CUSTOMER_MESSAGES + 4),
  })
  .strict()
  .superRefine((value, context) => {
    const customer = value.messages.filter((item) => item.from === 'customer');
    if (customer.length > MAX_CUSTOMER_MESSAGES)
      context.addIssue({ code: 'custom', message: 'This demo chat is full.' });
    if (customer.some((item) => item.text.length > MAX_CUSTOMER_TEXT))
      context.addIssue({ code: 'custom', message: 'Keep messages under 300 characters.' });
    if (value.messages.at(-1)?.from !== 'customer')
      context.addIssue({ code: 'custom', message: 'The customer speaks last.' });
    if (value.messages.some((item) => item.from !== 'customer' && item.photos?.length))
      context.addIssue({ code: 'custom', message: 'Only the customer sends photos.' });
  });

function chatFrom(req: Request) {
  const input = chatSchema.parse(req.body);
  const demo = DEMOS_BY_TRADE[input.tradeId];
  if (!demo) throw new ApiError(404, 'DEMO_NOT_FOUND', 'That demo isn’t here.');
  const sessionId = checkPass(input.pass);
  const services = Object.keys(demo.prices);
  // The service the visitor mentioned, else the first the conversation names, else the first.
  const customerText = input.messages
    .filter((item) => item.from === 'customer')
    .map((item) => item.text.toLowerCase())
    .join(' ');
  const serviceName =
    services.find((name) => name === input.serviceName) ??
    services.find((name) => customerText.includes(name.toLowerCase())) ??
    '';
  // Photos are the sample business's own, named by key. Their captions stand in for the pictures.
  const captions = new Map(demo.photos?.items.map((photo) => [photo.key, photo.caption]));
  const sent = input.messages.flatMap((item) => item.photos ?? []);
  if (sent.some((key) => !captions.has(key)))
    throw new ApiError(400, 'DEMO_PHOTO', 'Those photos aren’t part of this demo.');
  const sentWith = (item: (typeof input.messages)[number], describe: boolean) => {
    const keys = item.photos ?? [];
    if (!keys.length) return item.text;
    const what = keys.length === 1 ? 'a photo' : `${keys.length} photos`;
    if (!describe) return `${item.text} [sent ${what}]`;
    const shown = keys.map((key, index) => `Photo ${index + 1}: ${captions.get(key)}`);
    return `${item.text}\n[The customer sent ${what}. ${shown.join(' ')}]`;
  };
  return {
    demo,
    sessionId,
    services,
    serviceName,
    messages: input.messages.map((item) => ({ from: item.from, text: sentWith(item, false) })),
    /** With what the photos show written in, for the quote. */
    described: input.messages.map((item) => ({ from: item.from, text: sentWith(item, true) })),
    photoNotes: sent.map((key) => captions.get(key) ?? ''),
    photosSent: sent.length,
    // The demo asks for photos only where it has some of the right kind of job to send.
    photosAllowed: Boolean(demo.photos?.services.includes(serviceName)),
    usage: { sessionId, ip: req.ip || req.socket.remoteAddress || 'unknown' },
  };
}

/** The extra question's answer the visitor's photos gave, when they sent the sample photos. */
function photoAnswer(demo: Demo, photosSent: number) {
  const answer = photosSent ? demo.photos?.shows?.answer : undefined;
  return demo.extra?.options.find((option) => option.label === answer);
}

/** The sample business's prices, written up as past jobs, so the quote engine prices from them. */
function sampleHistory(demo: Demo, photosSent = 0): PricingHistory {
  const shown = photoAnswer(demo, photosSent);
  const trade = TRADES_BY_ID[demo.tradeId];
  return {
    business: {
      name: demo.business,
      trade: trade?.name.toLowerCase() ?? '',
      services: Object.keys(demo.prices),
      area: demo.area,
      radiusMiles: null,
    },
    pastJobs: Object.entries(demo.prices).flatMap(([service, cents]) =>
      demo.size.options
        .filter((option) => option.label !== 'Not sure')
        .map((option) => ({
          service,
          description: `${service}, ${option.line}`,
          priceCents: Math.max(Math.round((cents * option.factor) / 500) * 500, 2500),
          size: option.line,
          duration: demo.duration,
          when: '',
          materialsCents: null,
          discount: null,
          notes: '',
        })),
    ),
    practice: [],
    liveQuotes: [],
    rates: [],
    notes: [
      ...(demo.extra?.options ?? [])
        .filter((option) => option.add)
        .map(
          (option) =>
            `When the customer asks "${demo.extra?.ask}" and answers "${option.label}", add a separate line "${option.add?.label}" for ${option.add?.amountCents} cents.`,
        ),
      ...(shown
        ? [
            `The customer's photos answer "${demo.extra?.ask}" with "${shown.label}", so price it as that answer.`,
          ]
        : []),
      `Usually starts ${demo.start.toLowerCase()} and takes about ${demo.duration}.`,
    ],
  };
}

/** Starts a demo chat once the bot check passes. */
demoRouter.post('/demo/start', rateLimit(10, 10 * 60_000), async (req, res) => {
  z.object({})
    .strict()
    .parse(req.body ?? {});
  await verifyHuman(req, 'demo');
  await recordRequestEvent(req, null, 'demo_started');
  res.status(201).json(ok({ pass: issuePass() }));
});

/** The assistant's next message. */
demoRouter.post('/demo/turn', async (req, res) => {
  const chat = chatFrom(req);
  const { demo } = chat;
  // Once the photos have answered the extra question, it isn't asked again.
  const checklist = [
    demo.size.ask,
    ...(demo.extra && !photoAnswer(demo, chat.photosSent) ? [demo.extra.ask] : []),
  ];
  const turn = await withDemoAiUsage(chat.usage, () =>
    intakeTurn(
      {
        business: sampleHistory(demo).business,
        checklist,
        serviceName: chat.serviceName,
        conversation: chat.messages,
        photosReceived: chat.photosSent,
        photosAllowed: chat.photosAllowed,
        shortChat: true,
        photoNotes: [
          ...chat.photoNotes,
          // What the photos settle, so it isn't asked as well.
          ...(photoAnswer(demo, chat.photosSent)
            ? [
                `So "${demo.extra?.ask}" is already answered: ${photoAnswer(demo, chat.photosSent)?.label}.`,
              ]
            : []),
        ],
      },
      [],
    ),
  );
  // The photo buttons go only under a reply that really asks for photos.
  const askPhoto =
    turn.askPhoto &&
    chat.photosAllowed &&
    !chat.photosSent &&
    /photo|picture|pic\b/i.test(turn.reply);
  const customerCount = chat.messages.filter((item) => item.from === 'customer').length;
  // A demo chat stays short: once there's been a message for the service, the photos and each
  // question, plus one to spare, it quotes what it has rather than think up more questions.
  const enough = 1 + Number(chat.photosAllowed) + checklist.length + 1;
  const ready = turn.ready || customerCount >= Math.min(enough, MAX_CUSTOMER_MESSAGES - 2);
  // Once it has enough, the last word says the quote is on its way, not another question.
  const reply = ready
    ? turn.ready && fitsReady(turn.reply) && !hasContactDetails(turn.reply)
      ? turn.reply
      : readyLine()
    : clean(
        turn.reply,
        'Thanks! Tell me a little more about the job and I’ll put your quote together.',
      );
  await recordRequestEvent(req, null, 'demo_turn', {
    trade: String(req.body.tradeId),
    service: chat.serviceName,
    messages: (req.body.messages as unknown[]).length,
    photos: chat.photosSent,
  });
  res.json(
    ok({
      reply,
      // The page adds its own photo answers: send the sample photos, or skip them.
      chips: turn.chips
        .filter((chip) => !hasContactDetails(chip) && !/photo|pic|skip/i.test(chip))
        .slice(0, 4),
      askPhoto: !ready && askPhoto,
      ready,
      serviceName: turn.serviceName || chat.serviceName,
    }),
  );
});

/** The quote, drafted from the sample business's prices and added up here. */
demoRouter.post('/demo/quote', async (req, res) => {
  const chat = chatFrom(req);
  const { demo } = chat;
  const serviceName = chat.serviceName || chat.services[0];
  const shown = photoAnswer(demo, chat.photosSent);
  const drafted =
    aiMode === 'demo'
      ? {
          decision: 'quote' as const,
          reason: '',
          lines: [
            {
              label: `${serviceName}, ${demo.size.options.find((option) => option.factor === 1)?.line ?? 'as described'}`,
              amountCents: demo.prices[serviceName],
            },
            ...(shown?.add ? [shown.add] : []),
          ],
          discount: null,
          start: demo.start,
          duration: demo.duration,
        }
      : await withDemoAiUsage(chat.usage, () =>
          draftQuote({
            history: sampleHistory(demo, chat.photosSent),
            request: {
              serviceName,
              conversation: chat.described.map((item) => ({
                from: item.from === 'customer' ? ('customer' as const) : ('owner' as const),
                text: item.text,
              })),
            },
            images: [],
          }),
        );
  const lines = drafted.lines
    .filter((line) => line.amountCents > 0)
    .slice(0, 6)
    .map((line, index) => ({
      id: `demo-${index}`,
      label: clean(line.label, serviceName).slice(0, 120),
      amountCents: line.amountCents,
    }));
  await recordRequestEvent(req, null, 'demo_quote', {
    trade: String(req.body.tradeId),
    service: serviceName,
    site_visit: drafted.decision === 'site_visit' || !lines.length,
    total_cents: lines.reduce((sum, line) => sum + line.amountCents, 0),
  });
  if (drafted.decision === 'site_visit' || !lines.length) {
    res.json(
      ok({
        quote: null,
        visit:
          clean(drafted.reason, 'They’d want to see the job first.') ||
          'They’d want to see the job first.',
      }),
    );
    return;
  }
  const quote: Quote = {
    number: 1001,
    customer: 'You',
    place: demo.area,
    lines,
    discount: drafted.discount,
    start: clean(drafted.start, '') || demo.start,
    duration: clean(drafted.duration, '') || demo.duration,
    included: demo.included,
    excluded: demo.excluded,
    validDays: 14,
    note: '',
    issuedAt: new Date().toISOString(),
  };
  if (quoteTotal(quote) <= 0) throw new ApiError(422, 'DEMO_QUOTE_EMPTY', 'Try that again.');
  res.json(ok({ quote, visit: null }));
});
