import { createDecipheriv, createHash } from 'node:crypto';
import { expect, request, type Browser, type Locator } from '@playwright/test';
import mysql from 'mysql2/promise';

export const OWNER_PASSWORD = 'test password strong123';

/**
 * A signed-up business with three past driveway jobs, set up through the API. It's live unless
 * asked otherwise, done the way an owner does it: a plan, a card, then going live. New accounts
 * quote on their own; this owner has their Charm check with them first unless asked otherwise.
 */
export async function createBusiness(
  browser: Browser,
  baseURL: string,
  { billing = true, autoSend = false }: { billing?: boolean; autoSend?: boolean } = {},
) {
  const context = await browser.newContext({ baseURL });
  const owner = context.request;
  const headers = { Origin: new URL(baseURL).origin };
  const send = async (method: 'post' | 'patch', url: string, data: object) => {
    const response = await owner[method](url, { headers, data });
    expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  };
  await send('post', '/api/v1/onboarding/start', {});
  await send('patch', '/api/v1/onboarding/business', {
    tradeId: 'pressure-washing',
    services: ['Driveways', 'House wash'],
    name: 'Moss & Stone Exterior Care',
    area: 'Portland, OR',
  });
  for (const priceCents of [25000, 27500, 30000])
    await send('post', '/api/v1/onboarding/jobs', {
      serviceName: 'Driveways',
      description: 'Two-car driveway wash.',
      priceCents,
      size: '600 sq ft',
    });
  const account = await send('post', '/api/v1/auth/register', {
    firstName: 'Maya',
    lastName: 'Lopez',
    email: `maya-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    password: OWNER_PASSWORD,
  });
  if (!autoSend) await send('patch', '/api/v1/app/settings', { autoSend });
  if (billing) {
    await send('post', '/api/v1/app/billing/plan', { plan: 'per_quote' });
    await send('post', '/api/v1/billing/checkout', {});
    await send('post', '/api/v1/app/deploy', {});
  }
  const slug = String(account.business.slug);
  const approveWaiting = async () => {
    const response = await owner.get('/api/v1/app/quotes?filter=review');
    const [waiting] = (await response.json()).data;
    return send('post', `/api/v1/app/quotes/${waiting.id}/approve`, {});
  };
  return {
    slug,
    email: String(account.user.email),
    context,
    autoSend: (on: boolean) => send('patch', '/api/v1/app/settings', { autoSend: on }),
    approveWaiting,
    /** Two driveway quotes the owner sends as drafted, so driveway quotes can go out on their own. */
    learnDriveways: async () => {
      for (const name of ['Lee Park', 'Ana Ruiz']) {
        await waitingQuote(baseURL, slug, name);
        await approveWaiting();
      }
    },
  };
}

/** A customer asks for a quote through the API, so it waits for the owner. Returns the chat. */
export async function waitingQuote(baseURL: string, slug: string, name: string) {
  const customer = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: new URL(baseURL).origin },
  });
  const started = (await (await customer.post(`/api/v1/chat/${slug}/start`, { data: {} })).json())
    .data;
  const auth = { Authorization: `Bearer ${started.token}` };
  const base = `/api/v1/chat/${slug}/${started.chat.id}`;
  for (const text of ['Driveways', 'About 600 sq ft, two cars.', 'Skip photos'])
    await customer.post(`${base}/messages`, { headers: auth, data: { text } });
  const contact = (
    await (
      await customer.post(`${base}/contact`, {
        headers: auth,
        data: { name, email: `${name.split(' ')[0].toLowerCase()}@example.test` },
      })
    ).json()
  ).data;
  const verified = await customer.post(`${base}/verify`, {
    headers: auth,
    data: { verificationId: contact.verificationId, code: contact.devCode },
  });
  expect(verified.ok(), await verified.text()).toBe(true);
  await customer.dispose();
  return String(started.chat.id);
}

/**
 * The one-tap Approve link from the "needs your OK" email for a chat, read from the test
 * database's outbox. Local runs encrypt queued email with a fixed key, never used in production.
 */
export async function approveLinkFor(chatId: string): Promise<string> {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'quoting_engine',
    password: process.env.DB_PASS ?? 'local-dev-only',
    database: process.env.DB_NAME ?? 'quoting_test',
  });
  try {
    const [found] = await db.query<mysql.RowDataPacket[]>(
      'SELECT payload_encrypted FROM email_outbox WHERE dedupe_key=?',
      [`owner-review:${chatId}:once`],
    );
    const bytes = Buffer.from(String(found[0].payload_encrypted), 'base64');
    const key = createHash('sha256')
      .update('quotient-local-email-provider-never-production')
      .digest();
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const email = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    ) as { text: string };
    const link = /https?:\/\/\S+\/approve\/\S+/.exec(email.text)?.[0];
    expect(link, email.text).toBeTruthy();
    return link!;
  } finally {
    await db.end();
  }
}

/**
 * Waits until a quote in a chat shows from its top: its first line sits just under the top of
 * the chat's scrolling area, rather than above it with only the buttons in view.
 */
export async function expectQuoteFromTop(quote: Locator) {
  await expect
    .poll(() =>
      quote.evaluate((card) => {
        let scroller = card.parentElement;
        while (scroller && getComputedStyle(scroller).overflowY !== 'auto')
          scroller = scroller.parentElement;
        const offset = card.getBoundingClientRect().top - scroller!.getBoundingClientRect().top;
        return offset >= 0 && offset < 60;
      }),
    )
    .toBe(true);
}
