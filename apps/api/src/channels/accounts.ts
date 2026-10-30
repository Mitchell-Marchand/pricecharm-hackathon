import { randomInt, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { owner } from '../auth.js';
import { mutate, rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError, ok } from '../http.js';
import { openSecret, sealSecret } from '../integrations/email.js';
import { recordRequestEvent } from '../metrics.js';
import { consumeAuthRateLimit } from '../verification.js';
import {
  WhatsAppError,
  createQuoteTemplate,
  keyFromSignup,
  numberDetails,
  registerNumber,
  subscribeApp,
} from './whatsapp.js';

/**
 * Owners connect their business's own WhatsApp number in Settings, through Meta's sign-up
 * (Embedded Signup): they log in to Facebook, pick or create their WhatsApp account and number, and
 * Meta hands back a one-time code for a key that's the business's own. Until Meta approves
 * PriceCharm to serve other businesses, only people with a role on its Meta app can finish it.
 */
export const channelRouter = Router();

/** The sign-up needs PriceCharm's Meta app and the configuration made for it in Meta. */
function signup() {
  const appId = process.env.META_APP_ID?.trim(),
    configId = process.env.WHATSAPP_SIGNUP_CONFIG_ID?.trim();
  return appId && configId && process.env.META_APP_SECRET?.trim()
    ? { appId, configId, graphVersion: process.env.META_GRAPH_VERSION || 'v26.0' }
    : null;
}

async function whatsappView(businessId: string) {
  const [account] = await rows(
    "SELECT display_name FROM channel_accounts WHERE business_id=? AND kind='whatsapp' AND status='connected' ORDER BY updated_at DESC LIMIT 1",
    [businessId],
  );
  return {
    /** What the page needs to open Meta's sign-up, or null while PriceCharm isn't set up for it. */
    signup: signup(),
    connected: account ? { number: String(account.display_name) } : null,
  };
}

channelRouter.get('/app/whatsapp', async (req, res) => {
  res.json(ok(await whatsappView(owner(req).businessId)));
});

const connectInput = z
  .object({
    code: z.string().min(10).max(2000),
    wabaId: z.string().regex(/^\d{5,30}$/),
    phoneNumberId: z.string().regex(/^\d{5,30}$/),
  })
  .strict();

/** Meta's code for a number whose two-step PIN doesn't match the one it's registered with. */
const PIN_MISMATCH = 133005;

channelRouter.post('/app/whatsapp', async (req, res) => {
  const { businessId } = owner(req);
  if (!signup())
    throw new ApiError(503, 'WHATSAPP_UNAVAILABLE', 'WhatsApp isn’t set up on PriceCharm yet.');
  await consumeAuthRateLimit(`whatsapp-connect:${businessId}`, 10, 3600_000);
  const input = connectInput.parse(req.body);
  const [earlier] = await rows(
    "SELECT pin_ciphertext FROM channel_accounts WHERE kind='whatsapp' AND platform_id=? AND business_id=?",
    [input.phoneNumberId, businessId],
  );
  // A number connected before keeps its PIN, since Meta asks for the same one again.
  const pin = earlier?.pin_ciphertext
    ? openSecret(String(earlier.pin_ciphertext))
    : String(randomInt(0, 1_000_000)).padStart(6, '0');
  let token: string, number: string;
  try {
    token = await keyFromSignup(input.code);
    const line = { phoneNumberId: input.phoneNumberId, token };
    await registerNumber(line, pin);
    await subscribeApp(token, input.wabaId);
    number = (await numberDetails(line)).display_phone_number;
  } catch (error) {
    if (!(error instanceof WhatsAppError)) throw error;
    if (error.code === PIN_MISMATCH)
      throw new ApiError(
        409,
        'WHATSAPP_PIN',
        'This number already has a two-step verification PIN. Turn it off in WhatsApp Manager, then connect again.',
      );
    throw new ApiError(502, 'WHATSAPP_CONNECT_FAILED', `Meta didn’t connect it: ${error.message}`);
  }
  // The template a late quote goes out on. Meta reviews it, and a quote can still go without it
  // within 24 hours of the customer's last message.
  await createQuoteTemplate(token, input.wabaId).catch((error) =>
    reportError(error, { event: 'whatsapp_template' }),
  );
  // One number per business: a new one takes over from the last.
  await mutate(
    "UPDATE channel_accounts SET status='off' WHERE business_id=? AND kind='whatsapp' AND platform_id<>?",
    [businessId, input.phoneNumberId],
  );
  await mutate(
    `INSERT INTO channel_accounts (id,business_id,kind,platform_id,display_name,token_ciphertext,waba_id,pin_ciphertext)
     VALUES (?,?,'whatsapp',?,?,?,?,?)
     ON DUPLICATE KEY UPDATE business_id=VALUES(business_id),display_name=VALUES(display_name),
       token_ciphertext=VALUES(token_ciphertext),waba_id=VALUES(waba_id),pin_ciphertext=VALUES(pin_ciphertext),status='connected'`,
    [
      randomUUID(),
      businessId,
      input.phoneNumberId,
      number,
      sealSecret(token),
      input.wabaId,
      sealSecret(pin),
    ],
  );
  await recordRequestEvent(req, businessId, 'whatsapp_connected');
  res.json(ok(await whatsappView(businessId)));
});

/** The business's WhatsApp stops coming to PriceCharm. The number itself stays theirs. */
channelRouter.delete('/app/whatsapp', async (req, res) => {
  const { businessId } = owner(req);
  for (const account of await rows(
    "SELECT id,waba_id,token_ciphertext FROM channel_accounts WHERE business_id=? AND kind='whatsapp' AND status='connected'",
    [businessId],
  )) {
    if (account.waba_id && account.token_ciphertext)
      await subscribeApp(
        openSecret(String(account.token_ciphertext)),
        String(account.waba_id),
        false,
      ).catch((error) => reportError(error, { event: 'whatsapp_disconnect' }));
    await mutate("UPDATE channel_accounts SET status='off',token_ciphertext=NULL WHERE id=?", [
      account.id,
    ]);
  }
  await recordRequestEvent(req, businessId, 'whatsapp_disconnected');
  res.json(ok(await whatsappView(businessId)));
});
