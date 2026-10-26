import { expect, test, type Page } from '@playwright/test';
import type { PublicProfile, PublicSession, Quote } from '../../src/lib/types';

const slug = 'fictional-receipt-position';
const serviceId = 'd2700000-0000-4000-8000-000000000001';
const sessionId = 'd2700000-0000-4000-8000-000000000002';
const quoteId = 'd2700000-0000-4000-8000-000000000003';
const token = 'p'.repeat(43);
const at = '2026-10-28T12:00:00.000Z';
const note = 'I would like my hatchback cleaned in Austin.';
const completion =
  'Your request has been sent to the business owner for review. You can continue this conversation to clarify the project.';

async function harness(page: Page, holdRefresh: boolean) {
  const profile: PublicProfile = {
    business: {
      name: 'Fictional Mobile Detailing',
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
        requiredInputs: ['vehicle_type', 'interior_condition'],
        exclusions: [],
        mode: 'review',
        version: 1,
        publishedAt: at,
        pricingQuantityRequired: false,
      },
    ],
  };
  let quote: Quote | undefined;
  const session: PublicSession = {
    id: sessionId,
    serviceId,
    serviceVersion: 1,
    source: 'live',
    quoteMode: 'review',
    pricingQuantityRequired: false,
    requiredInputs: ['location', 'vehicle_type', 'interior_condition'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'active',
    contact: { verified: false },
    collectedInputs: {
      location: 'Round Rock',
      vehicle_type: 'SUV',
      interior_condition: 'unknown',
    },
    messages: [
      { id: 'customer', role: 'user', content: note, createdAt: at },
      {
        id: 'scope-question',
        role: 'assistant',
        content:
          'What would you like cleaned inside the vehicle? Include anything that needs special attention, and add any useful photos before sending your request.',
        createdAt: at,
      },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'You can add photos and send your request.',
        createdAt: at,
      },
    ],
  };
  const errors: string[] = [];
  const requests = { submissions: [] as Record<string, unknown>[], unexpected: [] as string[] };
  let waiting = false;
  let release!: () => void;
  let held = false;
  const refreshGate = new Promise<void>((resolve) => (release = resolve));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    const base = `/api/v1/public/${slug}/sessions/${sessionId}`;
    let data: unknown;
    if (method === 'GET' && pathname === `/api/v1/public/${slug}`) data = profile;
    else if (method === 'GET' && pathname === `${base}/uploads`) data = [];
    else if (method === 'GET' && pathname === base) {
      if (quote && holdRefresh && !held) {
        held = true;
        waiting = true;
        await refreshGate;
      }
      data = { ...session, quote };
    } else if (method === 'POST' && pathname === `${base}/quote`) {
      const body = request.postDataJSON();
      requests.submissions.push(body);
      quote = {
        id: quoteId,
        serviceId,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        description: body.description,
        quantity: body.quantity,
        status: 'review',
        totalCents: 0,
        currency: 'USD',
        manualPriceRequired: true,
        assumptions: [],
        lineItems: [],
        createdAt: at,
        submittedIntake: { inputs: body.inputs, quantityUnknown: body.quantityUnknown },
      };
      session.status = 'submitted';
      session.messages.push({
        id: 'submission-complete',
        role: 'assistant',
        content: completion,
        createdAt: at,
      });
      data = quote;
    } else {
      requests.unexpected.push(`${method} ${pathname}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: 'Unexpected fictional receipt request.' } },
      });
    }
    return route.fulfill({ json: { data } });
  });
  return {
    requests,
    errors,
    waiting: () => waiting,
    release,
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
    },
  };
}

async function committedFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function receiptStartsInViewport(page: Page, heading: string) {
  await expect(page.locator('.public-quote-result h3')).toHaveText(heading);
  await committedFrames(page);
  const position = await page.evaluate(() => {
    const body = document.querySelector('.public-chat-body')!;
    const heading = document.querySelector('.public-quote-result h3')!;
    const bodyBox = body.getBoundingClientRect();
    const headingBox = heading.getBoundingClientRect();
    return {
      top: headingBox.top,
      bottom: headingBox.bottom,
      visibleTop: Math.max(0, bodyBox.top),
      visibleBottom: Math.min(innerHeight, bodyBox.bottom),
      overflow: body.scrollHeight - body.clientHeight,
    };
  });
  expect(position.overflow).toBeGreaterThan(60);
  expect(position.top).toBeGreaterThanOrEqual(position.visibleTop - 1);
  expect(position.bottom).toBeLessThanOrEqual(position.visibleBottom + 1);
}

for (const scenario of [
  { route: 'q', width: 390, height: 844, held: false },
  { route: 'embed', width: 320, height: 400, held: false },
  { route: 'q', width: 320, height: 400, held: true },
  { route: 'embed', width: 390, height: 480, held: true },
])
  test(`${scenario.route} ${scenario.width}×${scenario.height} receipt entry survives ${scenario.held ? 'held' : 'immediate'} completion refresh and reload`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    const app = await harness(page, scenario.held);
    const url = `/${scenario.route}/${slug}#session=${sessionId}&token=${token}`;
    await page.goto(url);
    await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Alex');
    await page
      .getByRole('textbox', { name: 'Email address', exact: true })
      .fill('fictional-alex@example.test');
    await page.getByLabel(/I agree to share/).check();
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    if (scenario.held) {
      await expect.poll(app.waiting).toBe(true);
      await receiptStartsInViewport(page, 'Request sent');
      app.release();
    }
    await expect(page.locator('.message').last()).toContainText(completion);
    await receiptStartsInViewport(page, 'Request sent');
    const details = page.getByRole('region', { name: 'Submitted project details', exact: true });
    await expect(details).toContainText('SUV');
    await expect(details).toContainText('Round Rock');
    await page.reload();
    await receiptStartsInViewport(page, 'Request sent');
    if (scenario.route === 'q' && !scenario.held) {
      app.issue();
      await receiptStartsInViewport(page, 'Your quote');
      await expect(page.locator('.public-final-price')).toHaveText('$180');
    }
    expect(app.requests.submissions).toHaveLength(1);
    expect(app.requests.unexpected).toEqual([]);
    expect(app.errors).toEqual([]);
  });
