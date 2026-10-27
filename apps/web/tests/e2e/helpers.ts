import { expect, request, type Browser, type Locator } from '@playwright/test';

export const OWNER_PASSWORD = 'test password strong123';

/**
 * A signed-up business with three past driveway jobs, set up through the API. Billing is on
 * unless asked otherwise, done the way an owner does it: confirm the email, then add a card.
 */
export async function createBusiness(
  browser: Browser,
  baseURL: string,
  { billing = true }: { billing?: boolean } = {},
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
  if (billing) {
    const { devToken } = await send('post', '/api/v1/auth/request-verification', {});
    await send('post', '/api/v1/auth/verify-email', { token: devToken });
    await send('post', '/api/v1/billing/checkout', {});
  }
  return {
    slug: String(account.business.slug),
    email: String(account.user.email),
    context,
    autoSend: (on: boolean) => send('patch', '/api/v1/app/settings', { autoSend: on }),
    approveWaiting: async () => {
      const response = await owner.get('/api/v1/app/quotes?filter=review');
      const [waiting] = (await response.json()).data;
      return send('post', `/api/v1/app/quotes/${waiting.id}/approve`, {});
    },
  };
}

/** A customer asks for a quote through the API, so it waits for the owner. */
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
