import { expect, test, type Page } from '@playwright/test';
import type { Message, PublicProfile, PublicSession, Quote } from '../../src/lib/types';

const businessName = 'Fictional Conversation Detailing and Interior Cleaning for Family Vehicles';
const slug = 'fictional-followup-space';
const serviceId = 'd2900000-0000-4000-8000-000000000001';
const sessionId = 'd2900000-0000-4000-8000-000000000002';
const markerId = 'd2900000-0000-4000-8000-000000000003';
const at = '2026-10-28T12:00:00.000Z';
const reply =
  'Please leave the passenger seat clear. I will review the photos before confirming the cleaning scope. Let me know if the seats or carpet need special attention.';

async function harness(page: Page, issued = false) {
  await page.clock.install();
  const profile: PublicProfile = {
    business: {
      name: businessName,
      slug,
      description: 'Mobile vehicle detailing.',
      serviceArea: 'Austin',
      currency: 'USD',
    },
    services: [
      {
        id: serviceId,
        name: 'Vehicle detailing',
        description: 'Mobile vehicle detailing.',
        unitLabel: 'vehicle',
        requiredInputs: ['vehicle'],
        exclusions: [],
        mode: 'review',
        publishedAt: at,
        version: 1,
        pricingQuantityRequired: false,
      },
    ],
  };
  let quote: Quote = {
    id: 'd2900000-0000-4000-8000-000000000004',
    serviceId,
    customerName: 'Fictional Alex',
    customerEmail: 'fictional-alex@example.test',
    status: issued ? 'issued' : 'review',
    description: 'Please clean the interior of my SUV in Austin.',
    quantity: 1,
    totalCents: issued ? 18000 : 0,
    currency: 'USD',
    assumptions: [],
    lineItems: issued
      ? [{ description: 'Project price', quantity: 1, unitPriceCents: 18000, totalCents: 18000 }]
      : [],
    manualPriceRequired: !issued,
    issuedBy: issued ? 'owner' : undefined,
    createdAt: at,
    receiptAfterMessageId: markerId,
    submittedIntake: {
      inputs: {
        location: 'Austin',
        vehicle: 'SUV',
        condition: 'unknown',
        access: 'Parked at the curb outside the house.',
      },
      quantityUnknown: true,
    },
  };
  const messages: Message[] = [
    {
      id: 'd2900000-0000-4000-8000-000000000005',
      role: 'user',
      author: 'customer',
      content: quote.description,
      createdAt: at,
    },
    {
      id: markerId,
      role: 'assistant',
      author: 'ai',
      content: 'Your request is with the business for review.',
      createdAt: at,
    },
  ];
  const session: PublicSession = {
    id: sessionId,
    serviceId,
    serviceVersion: 1,
    source: 'live',
    status: issued ? 'issued' : 'submitted',
    quoteMode: 'review',
    pricingQuantityRequired: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
    requiredInputs: ['location', 'vehicle'],
    collectedInputs: { location: 'Austin', vehicle: 'SUV' },
    messages,
    contact: { verified: false },
  };
  let sequence = 10;
  const append = (content: string, customer = false) => {
    const message: Message = {
      id: `d2900000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      role: customer ? 'user' : 'assistant',
      author: customer ? 'customer' : 'owner',
      content,
      createdAt: at,
    };
    messages.push(message);
    return message.id;
  };
  const firstReply = append(reply);
  const requests = {
    messages: [] as string[],
    decisions: [] as string[],
    unexpected: [] as string[],
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      method = request.method(),
      pathname = new URL(request.url()).pathname;
    const base = `/api/v1/public/${slug}/sessions/${sessionId}`;
    let data: unknown;
    if (method === 'GET' && pathname === `/api/v1/public/${slug}`) data = profile;
    else if (method === 'GET' && pathname === `${base}/uploads`) data = [];
    else if (method === 'GET' && pathname === base) data = { ...session, quote };
    else if (method === 'POST' && pathname === `${base}/messages`) {
      const { content } = request.postDataJSON();
      requests.messages.push(content);
      append(content, true);
      data = { session: { ...session, quote } };
    } else if (method === 'POST' && pathname === `${base}/decision`) {
      const { decision } = request.postDataJSON();
      requests.decisions.push(decision);
      quote = { ...quote, status: decision };
      session.status = decision;
      append('Your quote decision is recorded.', true);
      data = quote;
    } else {
      requests.unexpected.push(`${method} ${pathname}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: 'Unexpected fictional followup route.' } },
      });
    }
    return route.fulfill({ json: { data } });
  });
  return {
    requests,
    errors,
    append,
    firstReply,
    issue: () => {
      quote = {
        ...quote,
        status: 'issued',
        totalCents: 18000,
        manualPriceRequired: false,
        issuedBy: 'owner',
        lineItems: [
          { description: 'Project price', quantity: 1, unitPriceCents: 18000, totalCents: 18000 },
        ],
      };
      session.status = 'issued';
      append('Review the scope and price, then accept or decline.');
    },
  };
}

const composer = (page: Page) =>
  page.getByRole('textbox', { name: 'Tell us about your project', exact: true });
const cue = (page: Page) => page.getByRole('button', { name: 'Latest message ↓', exact: true });
const url = (embedded: boolean) =>
  `/${embedded ? 'embed' : 'q'}/${slug}#session=${sessionId}&token=${'f'.repeat(43)}`;
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function poll(page: Page) {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/v1/public/${slug}/sessions/${sessionId}`,
  );
  await page.clock.fastForward(8100);
  await response;
}
async function followupControls(page: Page) {
  const header = page.locator('.public-chat-header');
  await expect(header.getByRole('heading', { name: businessName, exact: true })).toHaveCount(1);
  await expect(header.getByRole('heading', { name: 'Your request', exact: true })).toHaveCount(0);
  const input = await composer(page).evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    font: Number.parseFloat(getComputedStyle(element).fontSize),
  }));
  expect(input.height).toBeGreaterThanOrEqual(48);
  expect(input.font).toBeGreaterThanOrEqual(16);
  for (const button of [
    page.getByRole('button', { name: 'Add photo', exact: true }),
    page.getByRole('button', { name: 'Send message', exact: true }),
  ])
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
}
async function twoLinesReadable(page: Page, id: string) {
  const message = page.locator(`.message[data-message-id="${id}"]`);
  await expect(message).toBeAttached();
  await frames(page);
  const position = await message.evaluate((element) => {
    const body = document.querySelector('.public-chat-body')!.getBoundingClientRect();
    const role = element.querySelector('.message-role')!.getBoundingClientRect();
    const text = element.querySelector('p')!;
    const box = text.getBoundingClientRect();
    return {
      top: role.top,
      twoLinesBottom: box.top + 2 * Number.parseFloat(getComputedStyle(text).lineHeight),
      min: Math.max(0, body.top),
      max: Math.min(innerHeight, body.bottom),
    };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.min - 1);
  expect(position.twoLinesBottom).toBeLessThanOrEqual(position.max + 1);
}

test('a named business and readable followup retain the same phone controls, focused draft and sent reply through polling and reload', async ({
  context,
}) => {
  for (const layout of [
    { embedded: true, width: 320, height: 400 },
    { embedded: false, width: 390, height: 480 },
  ]) {
    const page = await context.newPage();
    await page.setViewportSize({ width: layout.width, height: layout.height });
    const app = await harness(page);
    await page.goto(url(layout.embedded));
    await followupControls(page);
    await expect(
      page.locator('.public-chat-header').getByRole('heading', { name: businessName, exact: true }),
    ).toHaveJSProperty('tagName', layout.embedded ? 'H2' : 'H1');
    await cue(page).click();
    await twoLinesReadable(page, app.firstReply);
    const draft = 'I can leave the keys with the concierge.';
    await composer(page).fill(draft);
    await page.locator('.public-chat-body').hover();
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() =>
        page
          .locator('.public-chat-body')
          .evaluate((body) => body.scrollHeight - body.scrollTop - body.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    const next = app.append(reply);
    await poll(page);
    await twoLinesReadable(page, next);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue(draft);
    await followupControls(page);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message').last()).toContainText(draft);
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('Please keep the boot mat in place.');
    app.issue();
    await poll(page);
    await expect(page.locator('.public-final-price')).toHaveText('$180');
    await followupControls(page);
    await expect(composer(page)).toHaveValue('Please keep the boot mat in place.');
    await expect(composer(page)).toBeFocused();
    await page.reload();
    await followupControls(page);
    await expect(composer(page)).toHaveValue('Please keep the boot mat in place.');
    expect(app.requests.messages).toEqual([draft]);
    expect(app.requests.decisions).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
    expect(app.errors).toEqual([]);
    await page.close();
  }
});

test('a closed short embed restores its original request heading and unobstructed price without a composer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 400 });
  const app = await harness(page, true);
  await page.goto(url(true));
  await followupControls(page);
  await page.getByRole('button', { name: 'Accept quote', exact: true }).click();
  await expect(page.locator('.public-quote-result h3')).toHaveText('Quote accepted');
  await expect(
    page.locator('.public-chat-header').getByRole('heading', { name: 'Your request', exact: true }),
  ).toHaveCount(1);
  await expect(page.locator('.public-chat-header strong')).toHaveText(businessName);
  await expect(composer(page)).toHaveCount(0);
  await expect(cue(page)).toBeVisible();
  await page.locator('.public-final-price').scrollIntoViewIfNeeded();
  await frames(page);
  const geometry = await cue(page).evaluate((button) => {
    const cue = button.getBoundingClientRect();
    const body = document.querySelector('.public-chat-body')!.getBoundingClientRect();
    const price = document.querySelector('.public-final-price')!.getBoundingClientRect();
    const restart = document.querySelector('.public-restart-button')!.getBoundingClientRect();
    const intersects = (box: DOMRect) =>
      Math.min(box.right, cue.right) > Math.max(box.left, cue.left) &&
      Math.min(box.bottom, cue.bottom) > Math.max(box.top, cue.top);
    return {
      priceVisible: price.top >= body.top - 1 && price.bottom <= body.bottom + 1,
      priceCovered: intersects(price),
      restartCovered: intersects(restart),
      bodyCovered: intersects(body),
    };
  });
  expect(geometry).toEqual({
    priceVisible: true,
    priceCovered: false,
    restartCovered: false,
    bodyCovered: false,
  });
  await page.reload();
  await expect(
    page.locator('.public-chat-header').getByRole('heading', { name: 'Your request', exact: true }),
  ).toHaveCount(1);
  await expect(composer(page)).toHaveCount(0);
  await expect(page.locator('.public-final-price')).toHaveText('$180');
  expect(app.requests.decisions).toEqual(['accepted']);
  expect(app.requests.messages).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
  expect(app.errors).toEqual([]);
});
