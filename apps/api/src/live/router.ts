import { Router } from 'express';
import { z } from 'zod';
import { devTokensAllowed } from '../config.js';
import { ApiError, ok, rateLimit } from '../http.js';
import { verifyHuman } from '../human-check.js';
import { imageUpload, saveImage, uploadSlot } from '../uploads.js';
import { workspaceFromRequest } from '../workspace.js';
import {
  afterPhoto,
  businessBySlug,
  chatAccess,
  chatPhoto,
  chatView,
  customerDecision,
  customerMessage,
  publicProfile,
  requestContact,
  startChat,
  verifyContact,
} from './chat.js';

/** The customer side: the quote link and the website widget. */
export const chatRouter = Router();
chatRouter.use('/chat', rateLimit(120, 60_000));

chatRouter.get('/chat/:slug', async (req, res) => {
  res.json(ok(await publicProfile(await businessBySlug(req.params.slug))));
});

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
  if (!test) await verifyHuman(req, 'quote_chat');
  const { token, chatId } = await startChat(business, test ? 'test' : source);
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
  res.json(ok(await customerMessage(req, text)));
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
    res.status(201).json(ok(await afterPhoto(req, saved.id)));
  },
);

chatRouter.get('/chat/:slug/:chatId/photos/:photoId', async (req, res) => {
  const photo = await chatPhoto(req);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(photo);
});

chatRouter.post('/chat/:slug/:chatId/contact', rateLimit(10, 15 * 60_000), async (req, res) => {
  const input = z
    .object({ name: z.string().trim().min(1).max(160), email: z.string().max(254) })
    .strict()
    .parse(req.body);
  res.json(ok(await requestContact(req, input, devTokensAllowed(req))));
});

chatRouter.post('/chat/:slug/:chatId/verify', rateLimit(20, 15 * 60_000), async (req, res) => {
  const input = z
    .object({ verificationId: z.uuid(), code: z.string().trim().max(10) })
    .strict()
    .parse(req.body);
  res.json(ok(await verifyContact(req, input)));
});

chatRouter.post('/chat/:slug/:chatId/accept', async (req, res) => {
  res.json(ok(await customerDecision(req, 'accept')));
});

chatRouter.post('/chat/:slug/:chatId/visit', async (req, res) => {
  res.json(ok(await customerDecision(req, 'visit')));
});
