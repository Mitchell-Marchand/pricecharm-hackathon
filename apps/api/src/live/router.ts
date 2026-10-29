import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError, ok, rateLimit } from '../http.js';
import { verifyHuman } from '../human-check.js';
import { imageUpload, saveImage, uploadSlot } from '../uploads.js';
import { workspaceFromRequest } from '../workspace.js';
import { lossReasons } from './outcomes.js';
import {
  afterPhoto,
  businessBySlug,
  chatAccess,
  chatPhoto,
  chatView,
  customerDecision,
  customerMessage,
  leaveContact,
  publicProfile,
  startChat,
} from './chat.js';
import { recordEvent, recordRequestEvent, type EventProps } from '../metrics.js';

/** The customer side: the quote link and the website widget. */
export const chatRouter = Router();
const chatLimit = rateLimit(120, 60_000);
chatRouter.use('/chat', (req, res, next) =>
  req.method === 'GET' && fromWebServer(req) ? next() : chatLimit(req, res, next),
);

/**
 * The web app reads business profiles to build the quote link and widget pages. It calls from
 * this machine, while nginx always adds the visitor's address, so these reads would otherwise
 * share one rate limit bucket across every visitor.
 */
function fromWebServer(req: Request) {
  const address = req.socket.remoteAddress ?? '';
  return (
    !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
  );
}

chatRouter.get('/chat/:slug', async (req, res) => {
  res.json(ok(await publicProfile(await businessBySlug(req.params.slug))));
});

/**
 * Whether the person looking is this business's signed-in owner. Before the agent is deployed,
 * or while it's paused, they still get their test chat; everyone else is told it isn't open.
 */
chatRouter.get('/chat/:slug/viewer', async (req, res) => {
  const business = await businessBySlug(req.params.slug);
  const viewer = await workspaceFromRequest(req);
  res.json(ok({ owner: Boolean(viewer && !viewer.draft && viewer.businessId === business.id) }));
});

/** What a business's customer did, counted against the business. Never what they wrote. */
async function customerEvent(req: Request, name: string, props: EventProps = {}) {
  const { business, chat } = await chatAccess(req);
  await recordEvent(
    undefined,
    String(business.id),
    name,
    { ...props, source: String(chat.source), status: String(chat.status) },
    { ref: String(chat.id) },
  );
}

/**
 * Starts a chat. When the business's own owner is signed in, it's a test: no bot check, and the
 * quote is never billed or emailed.
 */
chatRouter.post('/chat/:slug/start', rateLimit(20, 60_000), async (req, res) => {
  const business = await businessBySlug(req.params.slug);
  const { source } = z
    .object({ source: z.enum(['link', 'widget']).default('link') })
    .strict()
    .parse(req.body ?? {});
  const viewer = await workspaceFromRequest(req);
  const test = Boolean(viewer && !viewer.draft && viewer.businessId === business.id);
  if (!test && !business.link_on)
    throw new ApiError(
      409,
      'NOT_TAKING_REQUESTS',
      `${business.name} isn’t taking quote requests here right now.`,
    );
  if (!test) await verifyHuman(req, 'quote_chat');
  const { token, chatId } = await startChat(business, test ? 'test' : source);
  // The owner trying their own link shows up in their setup's trail.
  if (test)
    await recordRequestEvent(req, String(business.id), 'owner_test_chat', {}, { ref: chatId });
  req.headers.authorization = `Bearer ${token}`;
  req.params.chatId = chatId;
  const { chat } = await chatAccess(req);
  res.status(201).json(ok({ token, chat: await chatView(business, chat) }));
});

chatRouter.get('/chat/:slug/:chatId', async (req, res) => {
  const { business, chat } = await chatAccess(req);
  res.json(ok(await chatView(business, chat)));
});

chatRouter.post('/chat/:slug/:chatId/messages', rateLimit(20, 60_000), async (req, res) => {
  const { text } = z
    .object({ text: z.string().trim().min(1).max(2000) })
    .strict()
    .parse(req.body);
  const reply = await customerMessage(req, text);
  await customerEvent(req, 'customer_message', { chars: text.length });
  res.json(ok(reply));
});

chatRouter.post(
  '/chat/:slug/:chatId/photos',
  rateLimit(12, 60_000),
  uploadSlot,
  imageUpload,
  async (req, res) => {
    const { business, chat } = await chatAccess(req);
    if (!['chatting', 'contact'].includes(String(chat.status)))
      throw new ApiError(409, 'CHAT_DONE', 'Photos can’t be added to this request anymore.');
    const saved = await saveImage(req, String(business.id), { conversationId: String(chat.id) });
    const reply = await afterPhoto(req, saved.id);
    await customerEvent(req, 'customer_photo', { kb: Math.round((req.file?.size ?? 0) / 1024) });
    res.status(201).json(ok(reply));
  },
);

chatRouter.get('/chat/:slug/:chatId/photos/:photoId', async (req, res) => {
  const photo = await chatPhoto(req);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(photo);
});

/** A name and an email or a phone number. Nothing is sent to check them. */
const contactInput = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).default(''),
  phone: z.string().trim().max(40).default(''),
});

chatRouter.post('/chat/:slug/:chatId/contact', rateLimit(10, 15 * 60_000), async (req, res) => {
  const { purpose, ...input } = contactInput
    .extend({ purpose: z.enum(['copy', 'question']).default('copy') })
    .strict()
    .parse(req.body);
  const result = await leaveContact(req, input, purpose);
  await customerEvent(req, 'customer_contact_given', {
    purpose,
    email: Boolean(input.email),
    phone: Boolean(input.phone),
  });
  res.json(ok(result));
});

/**
 * The customer opened a form to leave their details: for a yes, a visit, a copy or a question.
 * Counted, so it shows how many finish it.
 */
chatRouter.post('/chat/:slug/:chatId/opened', rateLimit(30, 60_000), async (req, res) => {
  const { form } = z
    .object({ form: z.enum(['yes', 'visit', 'copy', 'question']) })
    .strict()
    .parse(req.body);
  await customerEvent(req, 'customer_contact_opened', { form });
  res.json(ok({ ok: true }));
});

/** A yes or a visit request, with the customer's details if they haven't left them yet. */
const answerInput = contactInput.strict().optional();

chatRouter.post('/chat/:slug/:chatId/accept', async (req, res) => {
  const contact = answerInput.parse(Object.keys(req.body ?? {}).length ? req.body : undefined);
  res.json(ok(await customerDecision(req, 'accept', undefined, contact)));
});

chatRouter.post('/chat/:slug/:chatId/visit', async (req, res) => {
  const contact = answerInput.parse(Object.keys(req.body ?? {}).length ? req.body : undefined);
  res.json(ok(await customerDecision(req, 'visit', undefined, contact)));
});

/** Not going ahead, and why. It's how the business learns which prices lose jobs. */
chatRouter.post('/chat/:slug/:chatId/decline', async (req, res) => {
  const why = z
    .object({ reason: z.enum(lossReasons), note: z.string().trim().max(600).default('') })
    .strict()
    .parse(req.body ?? {});
  res.json(ok(await customerDecision(req, 'decline', why)));
});
