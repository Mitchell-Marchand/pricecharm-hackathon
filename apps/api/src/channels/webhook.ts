import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { reportError } from '../error-reporting.js';
import { ApiError, ok } from '../http.js';
import { answer, receive } from './conversation.js';
import { signedByMeta } from './whatsapp.js';

/** Meta's webhook for WhatsApp, at /api/v1/hooks/meta. Messenger and Instagram can share it later. */

const same = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/** When the webhook is set up, Meta sends our verify token and expects its challenge back. */
export const verifyMetaWebhook: RequestHandler = (req, res) => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? '';
  const challenge = req.query['hub.challenge'];
  if (
    req.query['hub.mode'] !== 'subscribe' ||
    !expected ||
    !same(String(req.query['hub.verify_token'] ?? ''), expected) ||
    typeof challenge !== 'string' ||
    !/^[\w-]{1,200}$/.test(challenge)
  )
    throw new ApiError(403, 'WEBHOOK_NOT_VERIFIED', 'This webhook isn’t set up for that token.');
  res.type('text/plain').send(challenge);
};

/** Customers' messages and what became of ours. Meta gets its answer straight away; the Charm replies after. */
export const metaWebhook: RequestHandler = async (req, res) => {
  const secret = process.env.META_APP_SECRET?.trim() ?? '';
  if (
    !Buffer.isBuffer(req.body) ||
    !signedByMeta(req.body, req.headers['x-hub-signature-256'], secret)
  )
    throw new ApiError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'WEBHOOK_BODY_INVALID', 'Webhook body isn’t JSON.');
  }
  const senders = await receive(payload);
  res.json(ok({ received: true }));
  for (const { accountId, sender } of senders)
    void answer(accountId, sender).catch((error) =>
      reportError(error, { event: 'whatsapp_answer' }),
    );
};
