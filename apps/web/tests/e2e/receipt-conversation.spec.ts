import { expect, test, type Page } from '@playwright/test';
import type { Message, PublicProfile, PublicSession, Quote } from '../../src/lib/types';

const slug = 'fictional-receipt-conversation';
const serviceId = 'd2800000-0000-4000-8000-000000000001';
const sessionId = 'd2800000-0000-4000-8000-000000000002';
const quoteId = 'd2800000-0000-4000-8000-000000000003';
const markerId = 'd2800000-0000-4000-8000-000000000004';
const token = 'c'.repeat(43);
const at = '2026-10-28T12:00:00.000Z';
const original = 'Please clean the interior of my SUV in Round Rock.';
const completion = 'This deliberately distinct event text identifies the submitted fixture.';
const ownerReply =
  'Please leave the passenger seat clear. I will review the photos before confirming the scope. The exact condition of the fabric, carpet and trim will help me decide which cleaning steps are suitable.';
type DetailQuote = Quote & { receiptAfterMessageId?: string | null };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function harness(
  page: Page,
  options: { fresh?: boolean; held?: boolean; marker?: string | null; issued?: boolean } = {},
) {
  await page.clock.install();
  const profile: PublicProfile = {
    business: {
      name: 'Fictional Conversation Detailing',
      slug,
      description: 'Mobile vehicle detailing.',
      serviceArea: 'Austin and Round Rock',
      currency: 'USD',
    },
    services: [
      {
        id: serviceId,
        name: 'Mobile detailing',
        description: 'Mobile vehicle detailing.',
        unitLabel: 'vehicle',
        requiredInputs: ['vehicle_type', 'condition'],
        exclusions: [],
        mode: 'review',
        version: 1,
        pricingQuantityRequired: false,
        publishedAt: at,
      },
    ],
  };
  const messages: Message[] = [
    {
      id: 'd2800000-0000-4000-8000-000000000005',
      role: 'assistant',
      author: 'ai',
      content: 'Tell us which vehicle needs cleaning and anything that needs special attention.',
      createdAt: at,
    },
    {
      id: 'd2800000-0000-4000-8000-000000000006',
      role: 'user',
      author: 'customer',
      content: original,
      createdAt: at,
    },
  ];
  const event: Message = {
    id: markerId,
    role: 'assistant',
    author: 'ai',
    content: completion,
    createdAt: at,
  };
  function makeQuote(): DetailQuote {
    return {
      id: quoteId,
      serviceId,
      customerName: 'Fictional Casey',
      customerEmail: 'fictional-casey@example.test',
      description: original,
      quantity: 1,
      status: options.issued ? 'issued' : 'review',
      totalCents: options.issued ? 18000 : 0,
      currency: 'USD',
      manualPriceRequired: !options.issued,
      assumptions: [],
      lineItems: options.issued
        ? [{ description: 'Project price', quantity: 1, unitPriceCents: 18000, totalCents: 18000 }]
        : [],
      issuedBy: options.issued ? 'owner' : undefined,
      createdAt: at,
      submittedIntake: {
        inputs: {
          location: 'Round Rock',
          vehicle_type: 'SUV',
          condition: 'unknown',
          access: 'The vehicle is parked at the curb outside the house.',
          special_attention: 'Please check the seats, carpet, trim and luggage area.',
        },
        quantityUnknown: true,
      },
      receiptAfterMessageId: Object.hasOwn(options, 'marker') ? options.marker : markerId,
    };
  }
  let quote = options.fresh ? undefined : makeQuote();
  if (quote) messages.push(event);
  const session: PublicSession = {
    id: sessionId,
    serviceId,
    serviceVersion: 1,
    source: 'live',
    status: quote?.status === 'issued' ? 'issued' : quote ? 'submitted' : 'active',
    quoteMode: 'review',
    pricingQuantityRequired: false,
    requiredInputs: ['location', 'vehicle_type', 'condition'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    collectedInputs: { location: 'Round Rock', vehicle_type: 'SUV', condition: 'unknown' },
    messages,
    contact: { verified: false },
  };
  const requests = {
    quotes: [] as Record<string, unknown>[],
    messages: [] as string[],
    decisions: [] as string[],
    unexpected: [] as string[],
  };
  const errors: string[] = [];
  let sequence = 10;
  let holdRead: ReturnType<typeof gate> | undefined;
  let holdSend: ReturnType<typeof gate> | undefined;
  let heldCompletion = false;
  let waitingRead = false;
  let waitingSend = false;
  page.on('pageerror', (error) => errors.push(error.message));
  const append = (content: string, author: 'owner' | 'customer' = 'owner') => {
    const message: Message = {
      id: `d2800000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      role: author === 'customer' ? 'user' : 'assistant',
      author,
      content,
      createdAt: at,
    };
    messages.push(message);
    return message;
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const base = `/api/v1/public/${slug}/sessions/${sessionId}`;
    let data: unknown;
    if (method === 'GET' && pathname === `/api/v1/public/${slug}`) data = profile;
    else if (method === 'GET' && pathname === `${base}/uploads`) data = [];
    else if (method === 'GET' && pathname === base) {
      if (quote && options.held && !heldCompletion) {
        heldCompletion = true;
        holdRead = gate();
      }
      if (holdRead) {
        const pending = holdRead;
        waitingRead = true;
        await pending.promise;
        if (holdRead === pending) holdRead = undefined;
        waitingRead = false;
      }
      data = { ...session, quote };
    } else if (method === 'POST' && pathname === `${base}/quote`) {
      const body = request.postDataJSON();
      requests.quotes.push(body);
      quote = {
        ...makeQuote(),
        customerName: body.customerName,
        customerEmail: body.customerEmail,
      };
      messages.push(event);
      session.status = 'submitted';
      data = quote;
    } else if (method === 'POST' && pathname === `${base}/messages`) {
      const { content } = request.postDataJSON();
      requests.messages.push(content);
      if (holdSend) {
        const pending = holdSend;
        waitingSend = true;
        await pending.promise;
        if (holdSend === pending) holdSend = undefined;
        waitingSend = false;
      }
      append(content, 'customer');
      data = { session: { ...session, quote } };
    } else if (method === 'POST' && pathname === `${base}/decision` && quote) {
      const { decision } = request.postDataJSON();
      requests.decisions.push(decision);
      quote = { ...quote, status: decision };
      session.status = decision;
      append('Your quote decision was recorded.', 'customer');
      data = quote;
    } else {
      requests.unexpected.push(`${method} ${pathname}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: 'Unexpected fixture route' } },
      });
    }
    return route.fulfill({ json: { data } });
  });
  return {
    session,
    requests,
    errors,
    append,
    setMarker: (marker: string | null | undefined) =>
      (quote = { ...quote!, receiptAfterMessageId: marker }),
    holdRead: () => (holdRead = gate()),
    releaseRead: () => holdRead?.release(),
    waitingRead: () => waitingRead,
    holdSend: () => (holdSend = gate()),
    releaseSend: () => holdSend?.release(),
    waitingSend: () => waitingSend,
    issue: () => {
      quote = {
        ...quote!,
        status: 'issued',
        totalCents: 18000,
        manualPriceRequired: false,
        issuedBy: 'owner',
        lineItems: [
          { description: 'Project price', quantity: 1, unitPriceCents: 18000, totalCents: 18000 },
        ],
      };
      session.status = 'issued';
      append('The scope and price are ready for your review.');
    },
  };
}

const message = (page: Page, id: string) => page.locator(`.message[data-message-id="${id}"]`);
const cue = (page: Page) => page.getByRole('button', { name: 'Latest message ↓', exact: true });
const composer = (page: Page) =>
  page.getByRole('textbox', { name: 'Tell us about your project', exact: true });
const entry = (embedded = false) =>
  `/${embedded ? 'embed' : 'q'}/${slug}#session=${sessionId}&token=${token}`;

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
async function headingAtStart(page: Page, text = 'Request sent') {
  await expect(page.locator('.public-quote-result h3')).toHaveText(text);
  await frames(page);
  const position = await page.locator('.public-quote-result h3').evaluate((element) => {
    const body = document.querySelector('.public-chat-body')!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      min: Math.max(0, body.top),
      max: Math.min(innerHeight, body.bottom),
    };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.min - 1);
  expect(position.bottom).toBeLessThanOrEqual(position.max + 1);
}
async function messageStartsInViewport(page: Page, id: string) {
  await expect(message(page, id)).toBeAttached();
  await frames(page);
  const position = await message(page, id).evaluate((element) => {
    const body = document.querySelector('.public-chat-body')!.getBoundingClientRect();
    const role = element.querySelector('.message-role')!.getBoundingClientRect();
    const paragraph = element.querySelector('p')!;
    const start = paragraph.getBoundingClientRect();
    return {
      top: role.top,
      bottom: Math.max(role.bottom, start.top + parseFloat(getComputedStyle(paragraph).lineHeight)),
      min: Math.max(0, body.top),
      max: Math.min(innerHeight, body.bottom),
    };
  });
  expect(position.top).toBeGreaterThanOrEqual(position.min - 1);
  expect(position.bottom).toBeLessThanOrEqual(position.max + 1);
}
async function order(page: Page, id: string, beforeReceipt: boolean) {
  expect(
    await message(page, id).evaluate(
      (element) =>
        !!(
          element.compareDocumentPosition(document.querySelector('.public-quote-anchor')!) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(beforeReceipt);
}
async function sendRequest(page: Page) {
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Casey');
  await page
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('casey@example.test');
  await page.getByLabel(/I agree to share/).check();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
}
function clean(app: Awaited<ReturnType<typeof harness>>) {
  expect(app.errors).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
}

for (const held of [false, true])
  test(`${held ? 'held' : 'immediate'} exact marker arrival keeps one receipt between tied-time intake and later replies`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const app = await harness(page, { fresh: true, held });
    await page.goto(entry());
    await sendRequest(page);
    if (held) {
      await expect.poll(app.waitingRead).toBe(true);
      await headingAtStart(page);
      await expect(page.locator('.message')).toHaveCount(2);
      app.releaseRead();
    }
    await expect(message(page, markerId)).toContainText(completion);
    await headingAtStart(page);
    await order(page, app.session.messages[0].id, true);
    await order(page, markerId, true);
    const later = app.append(ownerReply);
    await poll(page);
    await expect(message(page, later.id)).toContainText(ownerReply);
    await order(page, later.id, false);
    await expect(page.locator('.public-quote-anchor')).toHaveCount(1);
    await headingAtStart(page);
    expect(new Set(app.session.messages.map((item) => item.createdAt)).size).toBe(1);
    expect(app.requests.quotes).toHaveLength(1);
    clean(app);
  });

test('legacy, malformed and unmatched receipt boundaries keep every message after one receipt without guessing from time or prose', async ({
  page,
}) => {
  const app = await harness(page, { marker: null });
  const tail = app.append(ownerReply);
  for (const marker of [null, undefined, 'not-a-uuid', 'd2800000-0000-4000-8000-999999999999']) {
    app.setMarker(marker);
    const restored = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/v1/public/${slug}/sessions/${sessionId}`,
    );
    await page.goto(entry());
    await restored;
    await headingAtStart(page);
    await expect(page.locator('.public-quote-anchor')).toHaveCount(1);
    await expect(page.locator('.message')).toHaveCount(app.session.messages.length);
    for (const item of app.session.messages) {
      await expect(message(page, item.id)).toContainText(item.content);
      await order(page, item.id, false);
    }
    await expect(cue(page)).toBeVisible();
    if (marker === undefined) {
      await cue(page).focus();
      await cue(page).press('Enter');
    } else await cue(page).click();
    await messageStartsInViewport(page, tail.id);
    await expect(message(page, tail.id)).toBeFocused();
    await expect(composer(page)).not.toBeFocused();
  }
  expect(app.requests.quotes).toEqual([]);
  clean(app);
});

test('fresh return opens the receipt while history and receipt readers retain position and draft until an explicit latest-message jump', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const app = await harness(page);
  app.append(ownerReply);
  await page.goto(entry());
  await headingAtStart(page);
  await composer(page).fill('I will leave a note at the house.');
  await page.locator('.public-chat-body').hover();
  await page.mouse.wheel(0, -10000);
  await expect
    .poll(() => page.locator('.public-chat-body').evaluate((body) => body.scrollTop))
    .toBe(0);
  const historyReply = app.append(
    'The cleaning equipment will be suitable for the fabric shown in your photos.',
  );
  await poll(page);
  await expect(message(page, historyReply.id)).toBeAttached();
  await frames(page);
  expect(await page.locator('.public-chat-body').evaluate((body) => body.scrollTop)).toBe(0);
  await expect(cue(page)).toBeVisible();
  await page.reload();
  await headingAtStart(page);
  await expect(composer(page)).toHaveValue('I will leave a note at the house.');
  const before = await page
    .locator('.public-quote-result h3')
    .evaluate((element) => element.getBoundingClientRect().top);
  const latest = app.append(ownerReply);
  await poll(page);
  await expect(message(page, latest.id)).toBeAttached();
  await frames(page);
  expect(
    await page
      .locator('.public-quote-result h3')
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBeCloseTo(before, 0);
  await composer(page).focus();
  await cue(page).click();
  await messageStartsInViewport(page, latest.id);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue('I will leave a note at the house.');
  expect(app.requests.messages).toEqual([]);
  clean(app);
});

test('following a live conversation reveals new owner and own messages at their start without losing a newer draft or leaking a reset context', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 400 });
  const app = await harness(page);
  const first = app.append(ownerReply);
  await page.goto(entry(true));
  await cue(page).click();
  await messageStartsInViewport(page, first.id);
  await page.locator('.public-chat-body').hover();
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() =>
      page
        .locator('.public-chat-body')
        .evaluate((body) => body.scrollHeight - body.scrollTop - body.clientHeight),
    )
    .toBeLessThanOrEqual(1);
  const next = app.append('The passenger seat and boot are included in the scope I am reviewing.');
  await poll(page);
  await messageStartsInViewport(page, next.id);
  await composer(page).fill('The boot will be empty too.');
  app.holdSend();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(app.waitingSend).toBe(true);
  await composer(page).fill('A new unsent detail while that reply is sent.');
  app.releaseSend();
  await expect(page.locator('.message').last()).toContainText('The boot will be empty too.');
  await messageStartsInViewport(page, app.session.messages.at(-1)!.id);
  await expect(composer(page)).toHaveValue('A new unsent detail while that reply is sent.');
  app.holdRead();
  const stale = app.append('This old conversation response must not reopen after reset.');
  const polling = poll(page);
  await expect.poll(app.waitingRead).toBe(true);
  await page.getByRole('button', { name: 'Start another request', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Start another request?', exact: true })
    .getByRole('button', { name: 'Start another request', exact: true })
    .click();
  app.releaseRead();
  await polling;
  await frames(page);
  await expect(message(page, stale.id)).toHaveCount(0);
  await expect(page.locator('.public-quote-anchor')).toHaveCount(0);
  await expect(cue(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue('');
  expect(app.requests.messages).toEqual(['The boot will be empty too.']);
  expect(app.requests.quotes).toEqual([]);
  clean(app);
});

test('issued and accepted status changes take receipt priority in a short embed and closed requests retain later messages without a composer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 400 });
  const app = await harness(page);
  app.append(ownerReply);
  await page.goto(entry(true));
  await cue(page).click();
  app.issue();
  await poll(page);
  await headingAtStart(page, 'Your quote');
  await expect(page.locator('.public-final-price')).toHaveText('$180');
  await expect(composer(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Accept quote', exact: true }).click();
  await expect(page.locator('.message').last()).toContainText('Your quote decision was recorded.');
  await headingAtStart(page, 'Quote accepted');
  await expect(composer(page)).toHaveCount(0);
  await expect(cue(page)).toBeVisible();
  await page.locator('.public-final-price').scrollIntoViewIfNeeded();
  await frames(page);
  const occlusion = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'Latest message ↓',
    )!;
    const cue = button.getBoundingClientRect();
    const body = document.querySelector('.public-chat-body')!.getBoundingClientRect();
    const price = document.querySelector('.public-final-price')!.getBoundingClientRect();
    const overlaps = (rect: DOMRect, clipTop = 0, clipBottom = innerHeight) =>
      Math.min(rect.right, cue.right) > Math.max(rect.left, cue.left) &&
      Math.min(rect.bottom, cue.bottom, clipBottom) > Math.max(rect.top, cue.top, clipTop);
    const collisions: string[] = [];
    if (overlaps(price, body.top, body.bottom)) collisions.push('price');
    const restart = document.querySelector('.public-restart-button')!;
    if (overlaps(restart.getBoundingClientRect())) collisions.push('restart control');
    for (const selector of [
      '.public-chat-header strong',
      '.public-request-heading',
      '.public-quote-result h3',
    ]) {
      const element = document.querySelector(selector)!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (
          [...range.getClientRects()].some((rect) =>
            selector.includes('public-quote-result')
              ? overlaps(rect, body.top, body.bottom)
              : overlaps(rect),
          )
        )
          collisions.push(selector);
      }
    }
    return {
      priceInViewport:
        price.top >= Math.max(0, body.top) - 1 &&
        price.bottom <= Math.min(innerHeight, body.bottom) + 1,
      collisions,
    };
  });
  expect(occlusion.priceInViewport).toBe(true);
  expect(occlusion.collisions).toEqual([]);
  await cue(page).click();
  await messageStartsInViewport(page, app.session.messages.at(-1)!.id);
  await expect(page.locator('.public-quote-anchor')).toHaveCount(1);
  expect(app.requests.decisions).toEqual(['accepted']);
  expect(app.requests.messages).toEqual([]);
  clean(app);
});
