import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PublicSession } from '../../src/lib/types';

const serviceId = 'a2200000-0000-4000-8000-000000000011';
const sessionId = 'a2200000-0000-4000-8000-000000000012';
const slug = 'fictional-project-review';
const at = '2026-10-28T12:00:00.000Z';
const followup = 'Please also include the hallway. The painter can confirm its measurements.';
const fullCondition = 'Peeling paint near the window, with no visible water damage.';

async function harness(
  page: Page,
  privatePreview: boolean,
  options: {
    clock?: boolean;
    emptyDescription?: boolean;
    unknownMeasurement?: boolean;
    venueLocation?: boolean;
  } = {},
) {
  if (options.clock) await page.clock.install();
  const business = {
    id: 'a2200000-0000-4000-8000-000000000013',
    name: 'Fictional Project Review Painting',
    slug,
    industry: 'Painting',
    description: 'Interior painting.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: !privatePreview,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Interior painting',
    description: 'Interior wall painting.',
    unitLabel: 'room',
    unitPriceCents: privatePreview ? 0 : 10000,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: privatePreview ? 0 : 100000,
    requiredInputs: ['Rooms', 'Wall condition'],
    pricingRules: [],
    exclusions: [],
    mode: privatePreview ? 'review' : 'automatic',
    publishedAt: privatePreview ? null : at,
    version: 2,
  };
  const messages: PublicSession['messages'] = [];
  for (let i = 0; i < 7; i++) {
    messages.push({
      id: `customer-${i}`,
      role: 'user',
      content:
        i === 6
          ? 'Please repaint 2 rooms in Austin. I am not sure what preparation the walls need.'
          : `The fictional room ${i + 1} has existing painted walls and ordinary access. Furniture can be moved before the painter visits.`,
      createdAt: at,
    });
    messages.push({
      id: `assistant-${i}`,
      role: 'assistant',
      content:
        'The painter can confirm preparation and measurements. Please add what you know about the wall condition.',
      createdAt: at,
    });
  }
  const session: PublicSession = {
    id: sessionId,
    serviceId,
    serviceVersion: 2,
    source: privatePreview ? 'playground' : 'live',
    quoteMode: privatePreview ? 'review' : 'automatic',
    pricingQuantityRequired: !privatePreview,
    requiredInputs: ['location', 'Rooms', 'Wall condition'],
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    contact: { verified: true, email: 'fictional-customer@example.test' },
    collectedInputs: { location: 'Austin', Rooms: '2', 'Wall condition': 'unknown' },
    missingInputs: ['Wall condition'],
    messages,
  };
  if (options.emptyDescription) {
    session.messages = [];
    session.collectedInputs = {
      location: 'Austin',
      Rooms: '2',
      'Wall condition': 'Previously painted, no visible damage',
    };
    session.missingInputs = [];
  }
  if (options.unknownMeasurement) {
    session.messages = [
      {
        id: 'unmeasured-project',
        role: 'user',
        content:
          'Please repaint the two bedroom walls in Austin. I do not know their measurements or what preparation the walls need.',
        createdAt: at,
      },
    ];
    session.collectedInputs = {
      location: 'Austin',
      Rooms: 'Two bedrooms',
      'Wall condition': 'unknown',
    };
  }
  if (options.venueLocation) {
    service.requiredInputs = ['venueLocation'];
    session.requiredInputs = ['location', 'venueLocation'];
    session.collectedInputs = { location: 'Austin', venueLocation: 'unknown' };
    session.missingInputs = ['venueLocation'];
  }
  const initialContent = options.emptyDescription ? '' : followup;
  const key = privatePreview ? `quotient:playground:${slug}:${serviceId}@2` : `quotient:${slug}`;
  const requests = {
    reads: [] as string[],
    submissions: [] as Record<string, unknown>[],
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') requests.reads.push(pathname);
    let data: unknown;
    if (request.method() === 'GET' && pathname === '/api/v1/auth/me')
      data = {
        business,
        user: {
          id: 'fictional-project-owner',
          name: business.name,
          email: 'fictional-owner@example.test',
          emailVerified: true,
        },
      };
    else if (request.method() === 'GET' && pathname === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          examplesCount: 0,
          trainingCompleted: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (request.method() === 'GET' && pathname === '/api/v1/settings')
      data = {
        aiMode: 'live',
        providers: { openai: true, anthropic: false },
        billingConfigured: false,
      };
    else if (request.method() === 'GET' && pathname === `/api/v1/public/${slug}`)
      data = {
        business,
        services: [
          {
            id: serviceId,
            name: service.name,
            description: service.description,
            unitLabel: 'room',
            requiredInputs: session.requiredInputs,
            exclusions: [],
            mode: service.mode,
            pricingQuantityRequired: true,
          },
        ],
      };
    else if (
      request.method() === 'GET' &&
      pathname === `/api/v1/public/${slug}/sessions/${sessionId}`
    )
      data = session;
    else if (
      request.method() === 'GET' &&
      pathname === `/api/v1/public/${slug}/sessions/${sessionId}/uploads`
    )
      data = [];
    else if (
      request.method() === 'POST' &&
      pathname === `/api/v1/public/${slug}/sessions/${sessionId}/quote`
    ) {
      requests.submissions.push(request.postDataJSON());
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'TEMPORARY_FAILURE',
            message: 'The request could not be confirmed. Your details are kept.',
          },
        },
      });
    }
    if (data !== undefined) return route.fulfill({ json: { data } });
    requests.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected mocked project-review request.' } },
    });
  });
  await page.addInitScript(
    ({ key, id, serviceId, followup }) => {
      if (!sessionStorage.getItem('fictional-project-seeded')) {
        localStorage.setItem(key, JSON.stringify({ id, serviceId, token: 'j'.repeat(43) }));
        sessionStorage.setItem(
          `${key}:draft:${id}`,
          JSON.stringify({ content: followup, requesting: false }),
        );
        sessionStorage.setItem('fictional-project-seeded', '1');
      }
    },
    { key, id: sessionId, serviceId, followup: initialContent },
  );
  await page.goto(privatePreview ? `/dashboard?service=${serviceId}&step=try` : `/q/${slug}`);
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveValue(
    initialContent,
  );
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  const form = page.locator('.public-request-form');
  await expect(form).toBeVisible();
  return { session, requests, key, form };
}

async function typeInSameFocusedNode(page: Page, text: string, label = 'Wall condition') {
  const field = page
    .locator('.public-request-form')
    .getByRole('textbox', { name: label, exact: true });
  const node = await field.elementHandle();
  if (!node) throw new Error('The unanswered field was not rendered.');
  await field.focus();
  await field.press('ControlOrMeta+A');
  let expected = '';
  for (const character of text) {
    await page.keyboard.type(character);
    expected += character;
    expect(
      await node.evaluate((input) => input.isConnected && document.activeElement === input),
    ).toBe(true);
    await expect(field).toHaveValue(expected);
  }
  await node.dispose();
  return field;
}

async function checkUnknownAndDone(page: Page) {
  const form = page.locator('.public-request-form');
  const condition = form.getByRole('textbox', { name: 'Wall condition', exact: true });
  const unsure = form.getByLabel('I’m not sure about wall condition.', { exact: true });
  await unsure.check();
  await expect(condition).toHaveCount(0);
  await unsure.uncheck();
  await expect(condition).toHaveValue(fullCondition);
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await expect(condition).toHaveCount(0);
  await expect(
    form.getByRole('region', { name: 'Your project summary', exact: true }),
  ).toContainText(fullCondition);
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(condition).toHaveValue(fullCondition);
}

async function boundsAfterTwoFrames(target: Locator) {
  return target.evaluate(
    (element) =>
      new Promise<{ top: number; bottom: number; connected: boolean }>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const bounds = element.getBoundingClientRect();
            resolve({ top: bounds.top, bottom: bounds.bottom, connected: element.isConnected });
          }),
        );
      }),
  );
}

for (const size of [
  { width: 390, height: 480 },
  { width: 320, height: 400 },
])
  test(`private review keeps sequential typing and exact drafts while entry, primary and Back work at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const app = await harness(page, true);
    const heading = app.form.getByRole('heading', {
      name: 'Check the project details',
      exact: true,
    });
    const entryBounds = await boundsAfterTwoFrames(heading);
    expect(entryBounds.connected).toBe(true);
    expect(entryBounds.top).toBeGreaterThanOrEqual(0);
    expect(entryBounds.bottom).toBeLessThanOrEqual(size.height);
    expect(
      await page
        .locator('.public-chat-body')
        .evaluate((body) => body.scrollHeight <= body.clientHeight + 2),
    ).toBe(true);
    await expect(app.form.getByRole('textbox', { name: 'City or area', exact: true })).toHaveCount(
      0,
    );
    await expect(app.form.getByRole('textbox', { name: 'Rooms', exact: true })).toHaveCount(0);
    await expect(
      app.form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
    ).not.toBeChecked();
    await expect(
      app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ }),
    ).toHaveValue('2');
    const condition = app.form.getByRole('textbox', { name: 'Wall condition', exact: true });
    const documentTop = await condition.evaluate(
      (field) => field.getBoundingClientRect().top + scrollY,
    );
    await typeInSameFocusedNode(page, fullCondition);
    await expect(
      app.form.getByRole('region', { name: 'Your project summary', exact: true }),
    ).not.toContainText(fullCondition);
    expect(
      Math.abs(
        (await condition.evaluate((field) => field.getBoundingClientRect().top + scrollY)) -
          documentTop,
      ),
    ).toBeLessThanOrEqual(1);
    await checkUnknownAndDone(page);
    await app.form.getByLabel('I don’t know the quantity or measurement.', { exact: true }).check();
    const primary = app.form.getByRole('button', { name: 'Run this customer test', exact: true });
    await primary.click({ trial: true });
    await app.form.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(app.form).toHaveCount(0);
    const composerBounds = await boundsAfterTwoFrames(page.locator('.public-composer'));
    expect(composerBounds.connected).toBe(true);
    expect(composerBounds.top).toBeGreaterThanOrEqual(0);
    expect(composerBounds.bottom).toBeLessThanOrEqual(size.height);
    const composer = page.getByLabel('Tell us about your project', { exact: true });
    await expect(composer).toHaveValue(followup);
    await expect(composer).toBeFocused();
    await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
    await expect(
      app.form.getByRole('region', { name: 'Your project summary', exact: true }),
    ).toContainText(fullCondition);
    await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
    await expect(
      app.form.getByRole('textbox', { name: 'Wall condition', exact: true }),
    ).toHaveValue(fullCondition);
    await expect(
      app.form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
    ).toBeChecked();
    expect(app.requests.submissions).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });

test('location facts stay in their own editor or summary before deduplication and preserve distinct submitted values', async ({
  page,
}) => {
  const app = await harness(page, true, { venueLocation: true });
  const summary = app.form.getByRole('region', { name: 'Your project summary', exact: true });
  const city = app.form.getByRole('textbox', { name: 'City or area', exact: true });
  const venue = app.form.getByRole('textbox', { name: 'Venue Location', exact: true });
  const cityRow = summary.locator('dt').filter({ hasText: /^City or area$/ });
  const venueRow = summary.locator('dt').filter({ hasText: /^Venue Location$/ });
  await expect(cityRow).toBeVisible();
  await expect(summary.locator('dd').filter({ hasText: /^Austin$/ })).toHaveCount(1);
  await typeInSameFocusedNode(page, 'Austin', 'Venue Location');
  await expect(cityRow).toBeVisible();
  await expect(venueRow).toHaveCount(0);
  await expect(venue).toHaveValue('Austin');

  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(city).toHaveValue('Austin');
  await expect(venue).toHaveValue('Austin');
  await expect(summary.locator('dt')).toHaveCount(0);
  await app.form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await expect(cityRow).toHaveCount(0);
  await expect(venueRow).toBeVisible();
  await expect(summary.locator('dd').filter({ hasText: /^Austin$/ })).toHaveCount(1);
  await expect(app.form.getByRole('group', { name: 'Project details', exact: true })).toHaveCount(
    0,
  );

  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(city).toHaveValue('Austin');
  await typeInSameFocusedNode(page, 'San Marcos', 'Venue Location');
  await expect(summary.locator('dt')).toHaveCount(0);
  await app.form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await expect(cityRow).toBeVisible();
  await expect(venueRow).toBeVisible();
  await expect(summary.locator('dd').filter({ hasText: /^Austin$/ })).toHaveCount(1);
  await expect(summary.locator('dd').filter({ hasText: /^San Marcos$/ })).toHaveCount(1);
  expect(app.requests.submissions).toEqual([]);
  await app.form.getByRole('button', { name: 'Run this customer test', exact: true }).click();
  await expect(app.form).toContainText(
    'The request could not be confirmed. Your details are kept.',
  );
  expect(app.requests.submissions).toEqual([
    expect.objectContaining({ inputs: { location: 'Austin', venueLocation: 'San Marcos' } }),
  ]);
  await page.reload();
  await expect(cityRow).toBeVisible();
  await expect(venueRow).toBeVisible();
  await expect(summary.locator('dd').filter({ hasText: /^Austin$/ })).toHaveCount(1);
  await expect(summary.locator('dd').filter({ hasText: /^San Marcos$/ })).toHaveCount(1);
  expect(app.requests.submissions).toHaveLength(1);
  expect(app.requests.unexpected).toEqual([]);
});

test('an unpriced private review keeps unknown measurements honest while preserving deliberate corrections and raw room details', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const app = await harness(page, true, { unknownMeasurement: true });
  const unknown = app.form.getByLabel('I don’t know the quantity or measurement.', { exact: true });
  const quantity = app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ });
  const summary = app.form.getByRole('region', { name: 'Your project summary', exact: true });
  await expect(unknown).toBeChecked();
  await expect(quantity).toHaveCount(0);
  await expect(summary).toContainText('Two bedrooms');
  const condition = await typeInSameFocusedNode(page, fullCondition);
  const node = await condition.elementHandle();
  if (!node) throw new Error('The unanswered condition field was not rendered.');
  await condition.press('ControlOrMeta+A');
  await condition.pressSequentially(fullCondition, { delay: 0 });
  expect(
    await node.evaluate((input) => input.isConnected && document.activeElement === input),
  ).toBe(true);
  await expect(condition).toHaveValue(fullCondition);
  await node.dispose();
  expect(pageErrors).toEqual([]);
  await expect(unknown).toBeChecked();
  await expect(quantity).toHaveCount(0);
  expect(app.requests.submissions).toEqual([]);

  await unknown.uncheck();
  await expect(quantity).toHaveValue('');
  await quantity.fill('3');
  await app.form.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveValue(
    followup,
  );
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(unknown).not.toBeChecked();
  await expect(quantity).toHaveValue('3');
  await expect(summary).toContainText('Two bedrooms');
  await expect(summary).toContainText(fullCondition);

  await unknown.check();
  await expect(quantity).toHaveCount(0);
  await app.form.getByRole('button', { name: 'Run this customer test', exact: true }).click();
  await expect(app.form).toContainText(
    'The request could not be confirmed. Your details are kept.',
  );
  expect(app.requests.submissions).toEqual([
    expect.objectContaining({
      quantity: 1,
      quantityUnknown: true,
      contactConsent: true,
      inputs: { location: 'Austin', Rooms: 'Two bedrooms', 'Wall condition': fullCondition },
    }),
  ]);
  await expect(summary).toContainText('Two bedrooms');
  await expect(summary).toContainText(fullCondition);
  await page.reload();
  await expect(app.form).toBeVisible();
  await expect(unknown).toBeChecked();
  await expect(quantity).toHaveCount(0);
  await expect(summary).toContainText('Two bedrooms');
  await expect(summary).toContainText(fullCondition);
  expect(app.requests.submissions).toHaveLength(1);
  expect(app.requests.unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('live automatic review retains full typing, verified contact and quantity through a failed submission and reload', async ({
  page,
}) => {
  const app = await harness(page, false);
  await typeInSameFocusedNode(page, fullCondition);
  await checkUnknownAndDone(page);
  await app.form
    .getByRole('textbox', { name: 'Your name', exact: true })
    .fill('Fictional Customer');
  await expect(app.form.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(
    'fictional-customer@example.test',
  );
  await expect(
    app.form.getByText('Email verified for this request.', { exact: true }),
  ).toBeVisible();
  await expect(
    app.form.getByRole('button', { name: 'Send verification code', exact: true }),
  ).toHaveCount(0);
  await app.form.getByLabel('I don’t know the quantity or measurement.', { exact: true }).uncheck();
  await app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ }).fill('2');
  await app.form.getByLabel(/I agree to share/).check();
  await app.form.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(app.form).toContainText(
    'The request could not be confirmed. Your details are kept.',
  );
  expect(app.requests.submissions).toEqual([
    expect.objectContaining({
      quantity: 2,
      quantityUnknown: false,
      customerName: 'Fictional Customer',
      customerEmail: 'fictional-customer@example.test',
      contactConsent: true,
      inputs: { location: 'Austin', Rooms: '2', 'Wall condition': fullCondition },
    }),
  ]);
  await page.reload();
  await expect(app.form).toBeVisible();
  await expect(
    app.form.getByRole('region', { name: 'Your project summary', exact: true }),
  ).toContainText(fullCondition);
  await expect(app.form.getByRole('textbox', { name: 'Wall condition', exact: true })).toHaveCount(
    0,
  );
  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(app.form.getByRole('textbox', { name: 'Wall condition', exact: true })).toHaveValue(
    fullCondition,
  );
  await expect(
    app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ }),
  ).toHaveValue('2');
  await expect(app.form.getByLabel(/I agree to share/)).not.toBeChecked();
  expect(app.requests.submissions).toHaveLength(1);
  expect(app.requests.unexpected).toEqual([]);
});

test('an empty live project description keeps the same focused textarea through typing, Done, failed submission and reload', async ({
  page,
}) => {
  const app = await harness(page, false, { emptyDescription: true });
  const description =
    'Repaint the two ground-floor rooms with washable paint and protect the furniture.';
  const field = app.form.getByRole('textbox', { name: 'Project description', exact: true });
  await expect(field).toHaveValue('');
  await typeInSameFocusedNode(page, description, 'Project description');
  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await app.form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(
    app.form.getByRole('region', { name: 'Your project summary', exact: true }),
  ).toContainText(description);
  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(field).toHaveValue(description);
  await app.form
    .getByRole('textbox', { name: 'Your name', exact: true })
    .fill('Fictional Customer');
  await app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ }).fill('2');
  await app.form.getByLabel(/I agree to share/).check();
  await app.form.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(app.form).toContainText(
    'The request could not be confirmed. Your details are kept.',
  );
  expect(app.requests.submissions).toEqual([
    expect.objectContaining({
      description,
      quantity: 2,
      quantityUnknown: false,
      customerName: 'Fictional Customer',
      customerEmail: 'fictional-customer@example.test',
      contactConsent: true,
      inputs: {
        location: 'Austin',
        Rooms: '2',
        'Wall condition': 'Previously painted, no visible damage',
      },
    }),
  ]);
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(
            sessionStorage.getItem(`${key}:draft:a2200000-0000-4000-8000-000000000012:details`) ||
              'null',
          )?.draft.description,
        app.key,
      ),
    )
    .toBe(description);
  await page.reload();
  await expect(app.form).toBeVisible();
  await expect(field).toHaveCount(0);
  await expect(
    app.form.getByRole('region', { name: 'Your project summary', exact: true }),
  ).toContainText(description);
  await app.form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(field).toHaveValue(description);
  await expect(
    app.form.getByRole('spinbutton', { name: /^Approximate quantity \(room\)/ }),
  ).toHaveValue('2');
  await expect(app.form.getByLabel(/I agree to share/)).not.toBeChecked();
  expect(app.requests.submissions).toHaveLength(1);
  expect(app.requests.unexpected).toEqual([]);
});

test('a changed required field set prunes removed editors and adds only newly unanswered fields', async ({
  page,
}) => {
  const app = await harness(page, true, { clock: true });
  await typeInSameFocusedNode(page, fullCondition);
  app.session.requiredInputs = ['location', 'Rooms', 'Access notes'];
  app.session.missingInputs = ['Access notes'];
  await page.clock.runFor(8100);
  const access = app.form.getByRole('textbox', { name: 'Access notes', exact: true });
  await expect(access).toBeVisible();
  await expect(app.form.getByRole('textbox', { name: 'Wall condition', exact: true })).toHaveCount(
    0,
  );
  await expect(app.form.getByRole('textbox', { name: 'City or area', exact: true })).toHaveCount(0);
  await access.pressSequentially('Ground floor');
  await expect(access).toHaveValue('Ground floor');
  await expect(access).toBeFocused();
  const stored = await page.evaluate(
    (key) =>
      JSON.parse(
        sessionStorage.getItem(`${key}:draft:a2200000-0000-4000-8000-000000000012:details`) ||
          'null',
      ),
    app.key,
  );
  expect(stored.draft.inputs['Wall condition']).toBe(fullCondition);
  expect(stored.draft.inputs['Access notes']).toBe('Ground floor');
  expect(app.requests.submissions).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});
