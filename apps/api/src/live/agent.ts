import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { questionChecklist } from '../charm-notes.js';
import { rows } from '../db.js';
import { ApiError, ok, rateLimit } from '../http.js';
import { json, type Row } from '../models.js';
import type { Quote } from '../practice/types.js';
import { currentFormula, priceDrivers } from '../pricing/formula-draft.js';
import { loadPricingData } from '../pricing/history.js';
import type { JobSpec } from '../pricing/spec.js';
import { priceText } from '../pricing/style.js';
import { imageUpload, saveImage, uploadSlot } from '../uploads.js';
import {
  afterPhoto,
  appOrigin,
  businessBySlug,
  chatAccess,
  customerMessage,
  leaveContact,
  publicProfile,
  startChat,
} from './chat.js';
import { readingPhotos } from './photo-readings.js';
import { currencyOf } from '../money.js';

/**
 * For an AI agent asking for a quote on someone's behalf: the same Charm and the same prices as
 * the quote link, in JSON. The agent can describe the job and answer the Charm's questions, but
 * only the person it's for can say yes, on the quote page it's handed. That yes is when the quote
 * is billed (`decide` in chat.ts), so an agent asking around costs owners nothing.
 *
 * Off unless AGENT_API_KEYS lists the keys agents send in X-Agent-Key.
 */
export const agentRouter = Router();

const agentKeys = () =>
  (process.env.AGENT_API_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

const digest = (value: string) => createHash('sha256').update(value).digest();

agentRouter.use('/agent', (req, _res, next) => {
  const keys = agentKeys();
  if (!keys.length) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  const given = req.headers['x-agent-key'];
  if (typeof given !== 'string' || !keys.some((key) => timingSafeEqual(digest(key), digest(given))))
    throw new ApiError(401, 'AGENT_KEY_REQUIRED', 'Send your agent key in X-Agent-Key.');
  next();
});

/** What a chat's status means to an agent, and what it should do next. */
const progress: Record<string, { status: string; next: string }> = {
  chatting: { status: 'asking', next: 'answer' },
  quoting: { status: 'pricing', next: 'wait' },
  contact: { status: 'needs_contact', next: 'send_contact' },
  review: { status: 'waiting_for_owner', next: 'wait' },
  sent: { status: 'quoted', next: 'hand_to_person' },
  accepted: { status: 'accepted', next: 'done' },
  visit: { status: 'visit_requested', next: 'done' },
  closed: { status: 'declined', next: 'done' },
};

/** Statuses where the quote is out, so the agent can see it. */
const OUT = ['sent', 'accepted', 'visit_requested', 'lost', 'expired'];

/**
 * Where the request is, the Charm's last words, the job as the Charm understood it, and the quote
 * once it's out, with what it holds for and the link for the person to answer it.
 */
async function agentView(business: Row, chat: Row, token: string) {
  const [last] = await rows(
    "SELECT text,chips_json FROM lead_messages WHERE chat_id=? AND sender='assistant' ORDER BY created_at DESC,id DESC LIMIT 1",
    [chat.id],
  );
  const [quote] = await rows('SELECT * FROM live_quotes WHERE chat_id=?', [chat.id]);
  const spec = json<JobSpec | null>(chat.spec_json, null);
  // Photos are read outside the request; the Charm answers once they are.
  const reading = chat.status === 'chatting' && (await readingPhotos(chat));
  // A job the owner doesn't take on ends with the Charm's reply, which says why.
  const step = chat.turned_down
    ? { status: 'turned_down', next: 'done' }
    : chat.human_handoff
      ? { status: 'with_owner', next: 'wait' }
      : reading
        ? { status: 'reading_photos', next: 'wait' }
        : (progress[String(chat.status)] ?? { status: String(chat.status), next: 'wait' });
  const out = quote && OUT.includes(String(quote.status));
  const card = out ? json<Quote>(quote.quote_json, {} as Quote) : null;
  const totalCents = Number(quote?.total_cents ?? 0);
  const currency = currencyOf(business.currency);
  const validUntil =
    card && quote.sent_at
      ? new Date(new Date(quote.sent_at).getTime() + card.validDays * 86_400_000).toISOString()
      : null;
  return {
    id: String(chat.id),
    ...step,
    reply: String(last?.text ?? ''),
    choices: json<string[]>(last?.chips_json, []),
    job: {
      service: String(chat.service_name),
      quantity: spec?.quantity ?? null,
      unit: spec?.unit ?? '',
      condition: spec?.condition ?? '',
      access: spec?.access ?? '',
      extras: spec?.extras ?? [],
      timing: spec?.timing ?? '',
      /** Where the job is: a ZIP or postcode, a town or a neighborhood. */
      location: spec?.location ?? '',
    },
    quote: card
      ? {
          number: Number(quote.number),
          status: String(quote.status),
          /** What every amount is in, in hundredths of it. */
          currency,
          price:
            card.style === 'range' && card.range
              ? { kind: 'range', lowCents: card.range.lowCents, highCents: card.range.highCents }
              : { kind: card.style === 'estimate' ? 'estimate' : 'firm', cents: totalCents },
          text: priceText(card, totalCents, currency),
          lines: card.lines.map((line) => ({ label: line.label, cents: line.amountCents })),
          discount: card.discount,
          included: card.included,
          excluded: card.excluded,
          start: card.start,
          duration: card.duration,
          validUntil,
          /** What the price is for. A different job is a new request. */
          assumes: card.assumes ?? [],
          /** What each condition or extra the person couldn't settle would add to the price. */
          ifs: (card.ifs ?? []).map((item) => ({
            when: item.when,
            addCents: item.cents,
            each: Boolean(item.each),
          })),
          /** For the person: they look it over and say yes there, with how to reach them. */
          confirmUrl: `${appOrigin()}/q/${business.slug}#chat=${chat.id}&token=${token}`,
        }
      : null,
  };
}

/** The chat's own token, which the agent got when it started the request. */
const chatToken = (req: Request) =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] ?? '';

async function view(req: Request, token = chatToken(req)) {
  const { business, chat } = await chatAccess(req);
  return agentView(business, chat, token);
}

/**
 * The business, what its Charm asks about, and what its price depends on, from the owner's own
 * quotes: each service's size, the conditions and the extras. An agent that says these in its
 * first message gets a quote without more questions.
 */
agentRouter.get('/agent/businesses/:slug', async (req, res) => {
  const business = await businessBySlug(req.params.slug);
  const id = String(business.id);
  const { name, trade, currency, services, taking } = await publicProfile(business);
  const drivers = priceDrivers(
    await loadPricingData(id)
      .then((data) => currentFormula(id, data))
      .catch(() => null),
  );
  res.json(
    ok({
      name,
      trade,
      currency,
      services,
      serviceArea: String(business.service_area ?? ''),
      taking,
      asksAbout: await questionChecklist(id),
      priceDependsOn: {
        sizes: drivers.services.map((service) => ({
          service: service.name,
          unit: service.unit,
          alsoCounts: service.count,
        })),
        conditions: drivers.conditions,
        extras: drivers.extras.map((extra) => ({ name: extra.name, counted: extra.counted })),
      },
    }),
  );
});

const text = z.string().trim().min(1).max(2000);

/** Starts a request with the agent's first message, and answers it like the quote link would. */
agentRouter.post('/agent/businesses/:slug/requests', rateLimit(20, 60_000), async (req, res) => {
  const business = await businessBySlug(req.params.slug);
  const { message } = z.object({ message: text }).strict().parse(req.body);
  if (!business.link_on)
    throw new ApiError(
      409,
      'NOT_TAKING_REQUESTS',
      `${business.name} isn’t taking quote requests right now.`,
    );
  const { token, chatId } = await startChat(business, 'agent');
  req.headers.authorization = `Bearer ${token}`;
  req.params.chatId = chatId;
  await customerMessage(req, message);
  res.status(201).json(ok({ token, request: await view(req, token) }));
});

agentRouter.get('/agent/businesses/:slug/requests/:chatId', async (req, res) => {
  res.json(ok(await view(req)));
});

agentRouter.post(
  '/agent/businesses/:slug/requests/:chatId/messages',
  rateLimit(20, 60_000),
  async (req, res) => {
    const { message } = z.object({ message: text }).strict().parse(req.body);
    await customerMessage(req, message);
    res.json(ok(await view(req)));
  },
);

/**
 * A photo of the job, from the person's own photos: one JPEG, PNG or WebP under 8 MB, as the
 * multipart field "file". It's read outside the request, so the request says reading_photos
 * until the Charm has looked and answered.
 */
agentRouter.post(
  '/agent/businesses/:slug/requests/:chatId/photos',
  rateLimit(12, 60_000),
  uploadSlot,
  imageUpload,
  async (req, res) => {
    const { business, chat } = await chatAccess(req);
    if (!['chatting', 'contact'].includes(String(chat.status)))
      throw new ApiError(409, 'CHAT_DONE', 'Photos can’t be added to this request anymore.');
    const saved = await saveImage(req, String(business.id), { conversationId: String(chat.id) });
    await afterPhoto(req, saved.id);
    res.status(201).json(ok(await view(req)));
  },
);

/**
 * The person's name and a phone number or an email, for a business that asks for them before
 * the price, or a quote that waits for the owner and needs somewhere to go.
 */
agentRouter.post(
  '/agent/businesses/:slug/requests/:chatId/contact',
  rateLimit(10, 15 * 60_000),
  async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(160),
        email: z.string().trim().max(254).default(''),
        phone: z.string().trim().max(40).default(''),
      })
      .strict()
      .parse(req.body);
    await leaveContact(req, input, 'copy');
    res.json(ok(await view(req)));
  },
);
