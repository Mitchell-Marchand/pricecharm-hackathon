import { Router } from 'express';
import { z } from 'zod';
import { owner } from '../auth.js';
import { mutate, rows, type Sql } from '../db.js';
import { ApiError, ok, rateLimit } from '../http.js';
import type { Row } from '../models.js';
import { recordRequestEvent } from '../metrics.js';
import { getPhoto } from '../storage.js';
import { logoUpload, removeLogo, saveLogo, uploadSlot } from '../uploads.js';
import { ACCEPT_WORDINGS } from './accept-wording.js';

/**
 * What customers see on the quote link and the website widget that the owner can change: their
 * logo, the name the chat says will follow up, what it says after a customer accepts or asks for a
 * visit, and the words on the accept button. Empty text means the default.
 */

export type Logo = { url: string; width: number; height: number };

export async function ownerFirstName(businessId: string, connection?: Sql) {
  const [user] = await rows(
    'SELECT first_name,name FROM users WHERE business_id=? ORDER BY created_at LIMIT 1',
    [businessId],
    connection,
  );
  return String(user?.first_name || String(user?.name ?? '').split(' ')[0] || '');
}

/** The person customers hear from: the name the owner chose, or their first name. */
export async function contactName(business: Row, connection?: Sql) {
  return (
    String(business.contact_name ?? '').trim() ||
    (await ownerFirstName(String(business.id), connection))
  );
}

/** What the chat says after a customer accepts, unless the owner wrote their own. */
export const defaultAcceptedMessage = (who: string, range = false) =>
  range
    ? `You’re all set. ${who} will confirm the final price and be in touch to schedule.`
    : `You’re all set. ${who} will be in touch to schedule.`;
export const defaultVisitMessage = (who: string) =>
  `Got it. ${who} will get in touch to set up a visit.`;

export async function acceptedMessage(business: Row, range: boolean, connection?: Sql) {
  const own = String(business.accepted_message ?? '').trim();
  return (
    own ||
    defaultAcceptedMessage(
      (await contactName(business, connection)) || String(business.name),
      range,
    )
  );
}

export async function visitMessage(business: Row, connection?: Sql) {
  const own = String(business.visit_message ?? '').trim();
  return (
    own || defaultVisitMessage((await contactName(business, connection)) || String(business.name))
  );
}

export async function businessLogo(business: Row, connection?: Sql): Promise<Logo | null> {
  if (!business.logo_id) return null;
  const [logo] = await rows(
    "SELECT id,width,height FROM attachments WHERE id=? AND business_id=? AND purpose='logo'",
    [business.logo_id, business.id],
    connection,
  );
  return logo
    ? {
        url: `/api/v1/chat/${business.slug}/logo/${logo.id}`,
        width: Number(logo.width),
        height: Number(logo.height),
      }
    : null;
}

async function quotePage(businessId: string) {
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const firstName = await ownerFirstName(businessId);
  const who = String(business.contact_name ?? '').trim() || firstName || String(business.name);
  return {
    logo: await businessLogo(business),
    contactName: String(business.contact_name ?? ''),
    /** The name the chat uses while contactName is empty. */
    ownerFirstName: firstName,
    acceptedMessage: String(business.accepted_message ?? ''),
    visitMessage: String(business.visit_message ?? ''),
    /** What customers read while a message is empty. */
    defaults: {
      acceptedMessage: defaultAcceptedMessage(who),
      visitMessage: defaultVisitMessage(who),
    },
    acceptLabel: String(business.accept_label ?? ''),
    /** The wordings PriceCharm tries while acceptLabel is empty. */
    wordings: ACCEPT_WORDINGS.map((wording) => wording.label),
  };
}

/** One line of text: runs of spaces and line breaks become single spaces. */
const oneLine = (max: number, message: string) =>
  z
    .string()
    .max(2000)
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, message));

const quotePageInput = z
  .object({
    contactName: oneLine(40, 'Keep the name to 40 characters or fewer.'),
    acceptedMessage: oneLine(280, 'Keep this to 280 characters or fewer.'),
    visitMessage: oneLine(280, 'Keep this to 280 characters or fewer.'),
    acceptLabel: oneLine(24, 'Keep the button to 24 characters or fewer, so it fits on a phone.'),
  })
  .partial()
  .strict();

export const quotePageRouter = Router();

quotePageRouter.get('/app/quote-page', async (req, res) => {
  res.json(ok(await quotePage(owner(req).businessId)));
});

quotePageRouter.patch('/app/quote-page', async (req, res) => {
  const { businessId } = owner(req);
  const input = quotePageInput.parse(req.body);
  if (input.contactName !== undefined)
    await mutate('UPDATE businesses SET contact_name=? WHERE id=?', [
      input.contactName,
      businessId,
    ]);
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const who = (await contactName(business)) || String(business.name);
  // A message that reads like the default is saved as the default, so it follows a new name.
  const changes: [string, string][] = [];
  if (input.acceptedMessage !== undefined)
    changes.push([
      'accepted_message',
      [defaultAcceptedMessage(who), defaultAcceptedMessage(who, true)].includes(
        input.acceptedMessage,
      )
        ? ''
        : input.acceptedMessage,
    ]);
  if (input.visitMessage !== undefined)
    changes.push([
      'visit_message',
      input.visitMessage === defaultVisitMessage(who) ? '' : input.visitMessage,
    ]);
  if (input.acceptLabel !== undefined) changes.push(['accept_label', input.acceptLabel]);
  if (changes.length)
    await mutate(
      `UPDATE businesses SET ${changes.map(([column]) => `${column}=?`).join(',')} WHERE id=?`,
      [...changes.map(([, value]) => value), businessId],
    );
  const saved = Object.fromEntries(changes);
  // The button's words are a label, like a service name. The messages are only measured.
  await recordRequestEvent(req, businessId, 'quote_page_changed', {
    fields: Object.keys(input).join(','),
    own_contact_name: input.contactName === undefined ? undefined : Boolean(input.contactName),
    accepted_message_chars: saved.accepted_message?.length,
    visit_message_chars: saved.visit_message?.length,
    accept_label: input.acceptLabel,
  });
  res.json(ok(await quotePage(businessId)));
});

quotePageRouter.post(
  '/app/quote-page/logo',
  rateLimit(10, 60_000),
  uploadSlot,
  logoUpload,
  async (req, res) => {
    const { businessId } = owner(req);
    await saveLogo(req, businessId);
    const page = await quotePage(businessId);
    await recordRequestEvent(req, businessId, 'logo_uploaded', {
      kb: Math.round((req.file?.size ?? 0) / 1024),
      width: page.logo?.width,
      height: page.logo?.height,
    });
    res.json(ok(page));
  },
);

quotePageRouter.delete('/app/quote-page/logo', async (req, res) => {
  const { businessId } = owner(req);
  await removeLogo(businessId);
  await recordRequestEvent(req, businessId, 'logo_removed');
  res.json(ok(await quotePage(businessId)));
});

/**
 * The logo on the quote link and the website widget. Its address changes with every upload, so
 * browsers can keep it for a year.
 */
export const logoRouter = Router();

logoRouter.get('/chat/:slug/logo/:logoId', async (req, res) => {
  const slug = z
    .string()
    .regex(/^[a-z0-9-]{1,180}$/)
    .safeParse(req.params.slug);
  const logoId = z.uuid().safeParse(req.params.logoId);
  const [logo] =
    slug.success && logoId.success
      ? await rows(
          `SELECT a.storage_key FROM businesses b JOIN attachments a ON a.id=b.logo_id AND a.business_id=b.id
           WHERE b.slug=? AND b.logo_id=? AND b.status='active' AND b.deletion_requested_at IS NULL`,
          [slug.data, logoId.data],
        )
      : [];
  if (!logo) throw new ApiError(404, 'NOT_FOUND', 'Logo not found.');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/png').send(await getPhoto(String(logo.storage_key)));
});
