import { expect, test, type Page } from '@playwright/test';

const firstId = 'a2500000-0000-4000-8000-000000000001';
const secondId = 'a2500000-0000-4000-8000-000000000002';
const at = '2026-10-28T12:00:00.000Z';
const sharePath = `/dashboard?service=${firstId}&step=share`;
const area = (page: Page) =>
  page.getByRole('textbox', { name: 'Where do you offer this service?', exact: true });

async function harness(
  page: Page,
  options: { existingArea?: string; omitSuggestions?: boolean } = {},
) {
  const business = {
    id: 'fictional-area-business',
    name: 'Fictional Cedar Table Catering',
    slug: 'fictional-cedar-table',
    industry: 'Catering',
    description: '',
    serviceArea: options.existingArea || '',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const user = {
    id: 'fictional-area-owner',
    name: business.name,
    email: 'fictional-area-owner@example.test',
    emailVerified: false,
  };
  const services = [firstId, secondId].map((id, index) => ({
    id,
    businessId: business.id,
    name: index ? 'Event catering' : 'Office lunches',
    description: 'Buffet and drop-off catering.',
    unitLabel: 'guest',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['Number of guests', 'Event location', 'Dietary requirements'],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    publishedAt: null as string | null,
    version: 2,
  }));
  const suggestions: Record<string, string> = { [firstId]: 'Austin', [secondId]: 'Georgetown' };
  const requests = {
    dashboardReads: 0,
    writes: [] as { path: string; body: Record<string, unknown> }[],
    unexpected: [] as string[],
  };
  let failPatch: number | false = false;
  let abortPatch = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') requests.writes.push({ path, body: request.postDataJSON() });
    let data: unknown;
    if (method === 'GET' && path === '/api/v1/auth/me') data = { user, business };
    else if (method === 'GET' && path === '/api/v1/settings')
      data = { aiMode: 'live', providers: { openai: true }, billingConfigured: false };
    else if (method === 'GET' && path === '/api/v1/dashboard') {
      requests.dashboardReads++;
      data = {
        business,
        services,
        ...(!options.omitSuggestions ? { serviceAreaSuggestions: suggestions } : {}),
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    } else if (method === 'GET' && path === '/api/v1/billing')
      data = {
        provider: 'local',
        configured: false,
        status: 'trial',
        canIssue: true,
        trial: { remainingQuotes: 10, quoteLimit: 10, endsAt: '2099-01-01T00:00:00.000Z' },
        usage: { deliveredQuotes: 0, billableQuotes: 0, feesCents: 0, month: '2026-10' },
        tariff: {
          basisPoints: 100,
          minimumFeeCents: 100,
          maximumFeeCents: 2500,
          currency: 'USD',
          version: 'fixture',
        },
        spendingCapCents: 0,
        subscription: null,
        checkoutAvailable: false,
        portalAvailable: false,
      };
    else if (method === 'GET' && /^\/api\/v1\/services\/[^/]+\/test-cases$/.test(path)) data = [];
    else if (method === 'GET' && /^\/api\/v1\/services\/[^/]+\/readiness$/.test(path)) {
      const service = services.find((item) => path.includes(item.id))!;
      data = {
        serviceId: service.id,
        serviceVersion: service.version,
        evaluation: null,
        evaluationCurrent: false,
        invalidation: 'not_evaluated',
        approvalCurrent: false,
        published: !!service.publishedAt,
        autoQuoteEnabled: false,
      };
    } else if (method === 'PATCH' && path === '/api/v1/business') {
      if (abortPatch) {
        abortPatch = false;
        return route.abort('failed');
      }
      if (failPatch) {
        const status = failPatch;
        failPatch = false;
        return route.fulfill({
          status,
          json: { error: { message: 'The service area could not be saved. Your draft is kept.' } },
        });
      }
      Object.assign(business, request.postDataJSON());
      data = business;
    } else if (method === 'POST' && /^\/api\/v1\/services\/[^/]+\/publish$/.test(path)) {
      const service = services.find((item) => path.includes(item.id))!;
      service.publishedAt = at;
      data = service;
    }
    if (data !== undefined) return route.fulfill({ json: { data } });
    requests.unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected mocked service-area request.' } },
    });
  });
  return {
    business,
    user,
    services,
    suggestions,
    requests,
    draftKey: (id = firstId) => `quotient:share-area:${business.id}:${user.id}:${id}`,
    failNextPatch: (status = 503) => {
      failPatch = status;
    },
    abortNextPatch: () => {
      abortPatch = true;
    },
  };
}

async function storedDraft(page: Page, key: string) {
  return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null'), key);
}

async function refreshOnFocus(page: Page, app: Awaited<ReturnType<typeof harness>>) {
  const before = app.requests.dashboardReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => app.requests.dashboardReads).toBeGreaterThan(before);
}

test('a coverage suggestion fills the existing Share field without persisting or publishing it before an explicit action', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(sharePath);
  await expect(area(page)).toHaveValue('Austin');
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.writes).toEqual([]);
  app.suggestions[firstId] = 'Greater Austin';
  await refreshOnFocus(page, app);
  await expect(area(page)).toHaveValue('Greater Austin');
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.writes).toEqual([]);
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(page.getByLabel('Your quote link', { exact: true })).toHaveValue(
    new RegExp('/q/fictional-cedar-table$'),
  );
  expect(app.requests.writes).toEqual([
    {
      path: '/api/v1/business',
      body: {
        serviceArea: 'Greater Austin',
        description: 'Buffet and drop-off catering.',
        onboardingComplete: true,
      },
    },
    { path: `/api/v1/services/${firstId}/publish`, body: { mode: 'review' } },
  ]);
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.unexpected).toEqual([]);
});

test('owner corrections and an explicit empty area survive failed publication, refresh, navigation and reload', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(sharePath);
  await expect(area(page)).toHaveValue('Austin');
  await area(page).fill('Austin and Round Rock');
  app.failNextPatch();
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(
    page.getByText('The service area could not be saved. Your draft is kept.'),
  ).toBeVisible();
  expect(app.requests.writes).toHaveLength(1);
  expect(await storedDraft(page, app.draftKey())).toEqual({
    version: 1,
    value: 'Austin and Round Rock',
  });
  app.suggestions[firstId] = 'Dallas';
  app.services[0].version++;
  await refreshOnFocus(page, app);
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  await page.reload();
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  await area(page).fill('');
  await refreshOnFocus(page, app);
  await expect(area(page)).toHaveValue('');
  await page.reload();
  await expect(area(page)).toHaveValue('');
  expect(await storedDraft(page, app.draftKey())).toEqual({ version: 1, value: '' });
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  expect(
    await area(page).evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
  ).toBe(true);
  expect(app.requests.writes).toHaveLength(1);
  await area(page).fill('  Austin and Cedar Park  ');
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(page.getByLabel('Your quote link', { exact: true })).toBeVisible();
  expect(app.requests.writes.slice(1)).toEqual([
    {
      path: '/api/v1/business',
      body: {
        serviceArea: 'Austin and Cedar Park',
        description: 'Buffet and drop-off catering.',
        onboardingComplete: true,
      },
    },
    { path: `/api/v1/services/${firstId}/publish`, body: { mode: 'review' } },
  ]);
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.unexpected).toEqual([]);
});

test('an interrupted Share write keeps the exact owner edit and empty draft without retrying or publishing until an explicit action', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(sharePath);
  await expect(area(page)).toHaveValue('Austin');
  await area(page).fill('Round Rock and Cedar Park');
  app.abortNextPatch();
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(
    page.getByText('We couldn’t confirm the result. Check before trying again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Failed to fetch', { exact: true })).toHaveCount(0);
  expect(app.requests.writes).toEqual([
    {
      path: '/api/v1/business',
      body: {
        serviceArea: 'Round Rock and Cedar Park',
        description: 'Buffet and drop-off catering.',
        onboardingComplete: true,
      },
    },
  ]);
  expect(app.services[0].publishedAt).toBeNull();
  expect(await storedDraft(page, app.draftKey())).toEqual({
    version: 1,
    value: 'Round Rock and Cedar Park',
  });
  await refreshOnFocus(page, app);
  await page.reload();
  await expect(area(page)).toHaveValue('Round Rock and Cedar Park');
  expect(app.requests.writes).toHaveLength(1);
  await area(page).fill('');
  await page.reload();
  await expect(area(page)).toHaveValue('');
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  expect(
    await area(page).evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
  ).toBe(true);
  expect(app.requests.writes).toHaveLength(1);
  await area(page).fill('Austin and Round Rock');
  app.failNextPatch(422);
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(
    page.getByText('The service area could not be saved. Your draft is kept.', { exact: true }),
  ).toBeVisible();
  expect(app.requests.writes).toHaveLength(2);
  expect(app.services[0].publishedAt).toBeNull();
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(page.getByLabel('Your quote link', { exact: true })).toBeVisible();
  expect(app.requests.writes.slice(2)).toEqual([
    {
      path: '/api/v1/business',
      body: {
        serviceArea: 'Austin and Round Rock',
        description: 'Buffet and drop-off catering.',
        onboardingComplete: true,
      },
    },
    { path: `/api/v1/services/${firstId}/publish`, body: { mode: 'review' } },
  ]);
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.unexpected).toEqual([]);
});

test('service and account scopes keep owner area drafts separate without resetting them on a policy version change', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(sharePath);
  await area(page).fill('Austin and Round Rock');
  const firstKey = app.draftKey();
  await page.locator('.service-menu > summary').click();
  await page.getByRole('button', { name: 'Event catering', exact: true }).click();
  await expect(area(page)).toHaveValue('Georgetown');
  await area(page).fill('');
  await page.locator('.service-menu > summary').click();
  await page.getByRole('button', { name: 'Office lunches', exact: true }).click();
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  app.services[0].version++;
  await refreshOnFocus(page, app);
  await expect(area(page)).toHaveValue('Austin and Round Rock');
  expect(await storedDraft(page, app.draftKey(secondId))).toEqual({ version: 1, value: '' });
  app.user.id = 'fictional-different-owner';
  await refreshOnFocus(page, app);
  await expect(area(page)).toHaveValue('Austin');
  expect(await storedDraft(page, firstKey)).toEqual({ version: 1, value: 'Austin and Round Rock' });
  expect(await storedDraft(page, app.draftKey())).toBeNull();
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('an existing business area stays authoritative over both a suggestion and an older local edit', async ({
  page,
}) => {
  const app = await harness(page, { existingArea: 'Austin metro' });
  await page.addInitScript((key) => {
    sessionStorage.setItem(key, JSON.stringify({ version: 1, value: 'An older unsubmitted edit' }));
  }, app.draftKey());
  app.suggestions[firstId] = 'Dallas';
  await page.goto(sharePath);
  await expect(
    page.getByRole('button', { name: 'Create my quote link', exact: true }),
  ).toBeEnabled();
  await expect(area(page)).toHaveCount(0);
  expect(app.requests.writes).toEqual([]);
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(page.getByLabel('Your quote link', { exact: true })).toBeVisible();
  expect(app.requests.writes[0]).toEqual({
    path: '/api/v1/business',
    body: {
      serviceArea: 'Austin metro',
      description: 'Buffet and drop-off catering.',
      onboardingComplete: true,
    },
  });
  expect(app.business.serviceArea).toBe('Austin metro');
  expect(app.requests.unexpected).toEqual([]);
});

test('an older dashboard response without suggestions retains the existing manual area entry flow', async ({
  page,
}) => {
  const app = await harness(page, { omitSuggestions: true });
  await page.goto(sharePath);
  await expect(area(page)).toHaveValue('');
  expect(app.requests.writes).toEqual([]);
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  expect(app.requests.writes).toEqual([]);
  await area(page).fill('Anywhere online');
  await page.getByRole('button', { name: 'Create my quote link', exact: true }).click();
  await expect(page.getByLabel('Your quote link', { exact: true })).toBeVisible();
  expect(app.business.serviceArea).toBe('Anywhere online');
  expect(app.requests.unexpected).toEqual([]);
});
