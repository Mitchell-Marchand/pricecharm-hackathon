import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows } from './db.js';
import { isDisposableEmail } from './email-domains.js';
import { ApiError, ok, rateLimit } from './http.js';
import { queueEmail } from './integrations/email.js';
import { consumeAuthRateLimit } from './verification.js';

/** The quote link, the website widget, and the one website allowed to show it. */
export const shareRouter = Router();

function appOrigin() {
  return (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
}

/** "https://www.MossAndStone.com/contact" becomes "mossandstone.com". */
export function websiteDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0];
}

export function embedCode(slug: string, style: 'floating' | 'inline') {
  const script = `<script src="${appOrigin()}/widget.js" data-pricecharm="${slug}" data-style="${style}" async></script>`;
  return style === 'inline' ? `<div data-pricecharm-inline="${slug}"></div>\n${script}` : script;
}

async function shareState(businessId: string) {
  const [business] = await rows(
    'SELECT name,slug,website_domain,widget_style FROM businesses WHERE id=?',
    [businessId],
  );
  const style = business.widget_style === 'inline' ? 'inline' : 'floating';
  return {
    slug: String(business.slug),
    url: `${appOrigin()}/q/${business.slug}`,
    websiteDomain: String(business.website_domain ?? ''),
    widgetStyle: style as 'floating' | 'inline',
    embedCode: embedCode(String(business.slug), style),
  };
}

shareRouter.get('/share', async (req, res) => {
  res.json(ok(await shareState(owner(req).businessId)));
});

shareRouter.patch('/share', async (req, res) => {
  const input = z
    .object({
      website: z
        .string()
        .max(300)
        .transform(websiteDomain)
        .refine(
          (domain) =>
            domain === '' ||
            /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain),
          'Enter a website like mossandstone.com.',
        ),
      widgetStyle: z.enum(['floating', 'inline']),
    })
    .partial()
    .strict()
    .parse(req.body);
  const businessId = owner(req).businessId;
  if (input.website !== undefined)
    await mutate('UPDATE businesses SET website_domain=? WHERE id=?', [input.website, businessId]);
  if (input.widgetStyle)
    await mutate('UPDATE businesses SET widget_style=? WHERE id=?', [
      input.widgetStyle,
      businessId,
    ]);
  res.json(ok(await shareState(businessId)));
});

const GUIDE = `WordPress: open the page in the editor, add a Custom HTML block, paste the code, then Update.
Squarespace: edit the page, add a Code block where you want it, paste the code, then Save.
Wix: click Add, then Embed Code, choose Embed HTML, paste the code, then Publish.
Webflow: drag an Embed element onto the page, paste the code, then Save and Publish.
Shopify: go to Online Store, then Themes, then Customize. Add a Custom Liquid section, paste the code, then Save.
GoDaddy: edit the site, add a section, choose HTML, paste the code, then Publish.`;

/** "Email these steps to the person who runs my website." */
shareRouter.post('/share/instructions', rateLimit(10, 15 * 60_000), async (req, res) => {
  const { email } = z
    .object({
      email: z
        .email()
        .max(254)
        .transform((value) => value.trim().toLowerCase()),
    })
    .strict()
    .parse(req.body);
  if (isDisposableEmail(email))
    throw new ApiError(422, 'DISPOSABLE_EMAIL', 'Please use an email address they’ll keep.');
  const context = owner(req);
  await consumeAuthRateLimit(`share-instructions:${context.businessId}`, 5, 24 * 60 * 60_000);
  const share = await shareState(context.businessId);
  const [business] = await rows('SELECT name FROM businesses WHERE id=?', [context.businessId]);
  await queueEmail({
    businessId: context.businessId,
    dedupeKey: `share-instructions:${context.businessId}:${randomUUID()}`,
    to: email,
    subject: `Add a quote button to ${business.name}’s website`,
    text: `${context.name} asked us to send you this. It adds a "Get a quote" button to ${business.name}’s website, so visitors can get a quote in a couple of minutes.

Paste this code into the page${share.websiteDomain ? ` on ${share.websiteDomain}` : ''} where you want it:

${share.embedCode}

How to add code in common website builders:
${GUIDE}

The button only works on ${share.websiteDomain || 'the website the owner lists in their settings'}. Questions about it can go to ${context.email}.`,
  });
  res.json(ok({ ok: true }));
});
