import { expect, test, type Page } from '@playwright/test';
import type { Quote } from '../../src/lib/types';

const ids = {
  service: 'c1600000-0000-4000-8000-000000000001',
  manual: 'c1600000-0000-4000-8000-000000000002',
  priced: 'c1600000-0000-4000-8000-000000000003',
  old: 'c1600000-0000-4000-8000-000000000004',
  accepted: 'c1600000-0000-4000-8000-000000000005',
  declined: 'c1600000-0000-4000-8000-000000000006',
  missing: 'c1600000-0000-4000-8000-000000000007',
};
const at = '2026-10-28T12:00:00.000Z';
const cachedGuestApproval = { previewId: 'c1600000-0000-4000-8000-000000000099', version: 1 };
const approvalKey = 'quotient:guest-preview:approval';

async function harness(
  page: Page,
  options: {
    signedIn?: boolean;
    firstRead?: '401' | '503' | 'delayed';
    delayPriceSave?: boolean;
    delayApproval?: 'success' | 'failure';
  } = {},
) {
  const business = {
    id: 'fictional-request-links-business',
    name: 'Fictional Oak Repair',
    slug: 'fictional-oak-repair',
    industry: 'Repair',
    description: 'Household repairs.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const user = {
    id: 'fictional-request-links-user',
    name: business.name,
    email: 'fictional-request-links@example.test',
    emailVerified: true,
  };
  const service = {
    id: ids.service,
    businessId: business.id,
    name: 'Household repair',
    description: business.description,
    unitLabel: 'project',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['model', 'symptoms'],
    pricingRules: [],
    exclusions: [],
    mode: 'review',
    publishedAt: at,
    version: 1,
  };
  const make = (
    id: string,
    name: string,
    status: Quote['status'] = 'review',
    manual = false,
  ): Quote => ({
    id,
    serviceId: ids.service,
    customerName: name,
    customerEmail: `${name.toLowerCase()}@example.test`,
    status,
    manualPriceRequired: manual,
    totalCents: manual ? 0 : 24500,
    quantity: 1,
    currency: 'USD',
    description: `Inspect the appliance for ${name}. The door seal leaks and the model number is known.`,
    assumptions: ['Inspect the door seal before proceeding.'],
    lineItems: manual
      ? []
      : [{ description: 'Project price', quantity: 1, unitPriceCents: 24500, totalCents: 24500 }],
    createdAt: at,
    issuedBy: status === 'review' ? undefined : 'owner',
  });
  const rows = [
    make(ids.manual, 'FictionalMaya', 'review', true),
    make(ids.priced, 'FictionalLeo'),
    make(ids.old, 'FictionalOlder', 'review', true),
    make(ids.accepted, 'FictionalAccepted', 'accepted'),
    make(ids.declined, 'FictionalDeclined', 'declined'),
  ];
  const list = () => rows.filter((row) => row.id !== ids.old);
  let signedIn = options.signedIn !== false;
  let delayedRelease: (() => void) | undefined;
  let releasePriceSave: (() => void) | undefined;
  let releaseApproval: (() => void) | undefined;
  const requests = {
    reads: [] as string[],
    logins: 0,
    pageReads: 0,
    dashboardReads: 0,
    authReads: 0,
    proposalReads: 0,
    writes: [] as { method: string; path: string; body: unknown }[],
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    let data: unknown;
    const unauthorized = () =>
      route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } },
      });
    if (method === 'GET' && pathname === '/api/v1/auth/me') {
      requests.authReads++;
      if (!signedIn) return unauthorized();
      data = { user, business };
    } else if (method === 'POST' && pathname === '/api/v1/auth/login') {
      requests.logins++;
      signedIn = true;
      data = { user, business };
    } else if (method === 'GET' && pathname === '/api/v1/settings')
      data = {
        providers: { openai: false, anthropic: false },
        aiMode: 'demo',
        billingConfigured: false,
      };
    else if (method === 'GET' && pathname === '/api/v1/dashboard') {
      requests.dashboardReads++;
      if (!signedIn) return unauthorized();
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: list(),
        stats: {
          totalQuotes: list().length,
          reviewQuotes: 2,
          issuedQuotes: 0,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    } else if (method === 'GET' && pathname === '/api/v1/quotes/page') {
      requests.pageReads++;
      const filter = new URL(request.url()).searchParams.get('filter') || 'all';
      data = {
        quotes: list().filter((quote) => filter === 'all' || quote.status === filter),
        counts: {
          all: rows.length,
          review: rows.filter((quote) => quote.status === 'review').length,
          issued: rows.filter((quote) => quote.status === 'issued').length,
        },
        pageSize: 25,
        olderCursor: null,
        newerCursor: null,
      };
    } else if (method === 'GET' && pathname === `/api/v1/services/${ids.service}/proposals`) {
      requests.proposalReads++;
      data = { proposals: [], teaching: { revision: 0, notes: [] } };
    } else if (method === 'GET' && pathname === '/api/v1/quotes') data = list();
    else {
      const match = /^\/api\/v1\/quotes\/([^/]+)(?:\/(photos|conversation|approve))?$/.exec(
        pathname,
      );
      const quote = rows.find((row) => row.id === match?.[1]);
      if (method === 'GET' && match && !match[2]) {
        requests.reads.push(match[1]);
        if (requests.reads.length === 1 && options.firstRead === '401') {
          signedIn = false;
          return unauthorized();
        }
        if (requests.reads.length === 1 && options.firstRead === '503')
          return route.fulfill({
            status: 503,
            json: { error: { code: 'UNAVAILABLE', message: 'Try later.' } },
          });
        if (requests.reads.length === 1 && options.firstRead === 'delayed')
          await new Promise<void>((resolve) => {
            delayedRelease = resolve;
          });
        if (!quote)
          return route.fulfill({
            status: 404,
            json: { error: { code: 'QUOTE_NOT_FOUND', message: 'Quote not found.' } },
          });
        data = quote;
      } else if (method === 'GET' && quote && match?.[2] === 'photos') data = [];
      else if (method === 'GET' && quote && match?.[2] === 'conversation')
        data = [{ id: `customer-${quote.id}`, role: 'user', content: quote.description }];
      else if (method === 'POST' && quote && match?.[2] === 'approve') {
        requests.writes.push({ method, path: pathname, body: null });
        if (options.delayApproval)
          await new Promise<void>((resolve) => {
            releaseApproval = resolve;
          });
        if (options.delayApproval === 'failure')
          return route.fulfill({
            status: 503,
            json: { error: { code: 'UNAVAILABLE', message: 'The first quote approval failed.' } },
          });
        quote.status = 'issued';
        quote.issuedBy = 'owner';
        data = quote;
      } else if (method === 'PATCH' && quote && !match?.[2]) {
        requests.writes.push({ method, path: pathname, body: request.postDataJSON() });
        if (options.delayPriceSave)
          await new Promise<void>((resolve) => {
            releasePriceSave = resolve;
          });
        quote.totalCents = request.postDataJSON().totalCents;
        quote.manualPriceRequired = false;
        quote.lineItems = [
          {
            description: 'Project price',
            quantity: 1,
            unitPriceCents: quote.totalCents,
            totalCents: quote.totalCents,
          },
        ];
        data = quote;
      } else {
        requests.unexpected.push(`${method} ${pathname}`);
        return route.fulfill({
          status: 500,
          json: { error: { code: 'UNMOCKED', message: pathname } },
        });
      }
    }
    await route.fulfill({ json: { data } });
  });
  return {
    requests,
    release: () => delayedRelease?.(),
    releasePriceSave: () => releasePriceSave?.(),
    releaseApproval: () => releaseApproval?.(),
  };
}

async function login(page: Page) {
  await page.getByLabel(/^Email address/).fill('fictional-request-links@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-long!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('an emailed request outside the recent list opens by exact read and survives reload without a quote mutation', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dashboard/quotes?quote=${ids.old}`);
  const dialog = page.getByRole('region', { name: 'Review request', exact: true });
  await expect(dialog).toContainText('FictionalOlder');
  await expect(dialog.getByRole('region', { name: 'Customer project' })).toContainText(
    'The door seal leaks',
  );
  await expect(
    page.getByRole('region', { name: 'Customer requests', includeHidden: true }),
  ).not.toContainText('FictionalOlder');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Review request', exact: true })).toContainText(
    'FictionalOlder',
  );
  expect(requests.reads).toEqual([ids.old, ids.old]);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('expired login preserves the exact request and filter while ignoring unrelated cached guest approval', async ({
  page,
}) => {
  const { requests } = await harness(page, { signedIn: false });
  await page.addInitScript(
    ({ approvalKey, cachedGuestApproval }) =>
      sessionStorage.setItem(approvalKey, JSON.stringify(cachedGuestApproval)),
    { approvalKey, cachedGuestApproval },
  );
  await page.goto(`/dashboard/quotes?quote=${ids.old}&filter=review`);
  await expect(page).toHaveURL(new RegExp(`/login\\?quote=${ids.old}&filter=review`));
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  await expect(
    page.getByText('Sign in to open this quote request.', { exact: true }),
  ).toBeVisible();
  await login(page);
  await expect(page).toHaveURL(new RegExp(`/dashboard/quotes\\?quote=${ids.old}&filter=review`));
  await expect(page.getByRole('region', { name: 'Review request', exact: true })).toContainText(
    'FictionalOlder',
  );
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null'), approvalKey),
  ).toEqual(cachedGuestApproval);
  expect(requests.logins).toBe(1);
  expect(requests.reads).toEqual([ids.old]);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('an opening-read401 returns through login to the same request after an already-mounted inbox expires', async ({
  page,
}) => {
  const { requests } = await harness(page, { firstRead: '401' });
  await page.goto('/dashboard/quotes?filter=review');
  await page.getByRole('button', { name: 'Review request for FictionalMaya', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?quote=${ids.manual}&filter=review`));
  await login(page);
  await expect(page.getByRole('region', { name: 'Review request', exact: true })).toContainText(
    'FictionalMaya',
  );
  expect(requests.reads).toEqual([ids.manual, ids.manual]);
  expect(requests.logins).toBe(1);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('selection and inbox filter follow Back, Forward, close, and reload', async ({ page }) => {
  const { requests } = await harness(page);
  await page.goto('/dashboard/quotes');
  await page.getByRole('button', { name: /^Needs review/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/quotes\?filter=review$/);
  await page.getByRole('button', { name: 'Review request for FictionalMaya', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`quote=${ids.manual}&filter=review`));
  await expect(
    page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
  ).toContainText('FictionalMaya');
  await page.goBack();
  await expect(
    page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Needs review/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goForward();
  await expect(
    page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
  ).toContainText('FictionalMaya');
  await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/quotes\?filter=review$/);
  await expect(
    page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Needs review/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('missing and malformed links show no substituted request and return to the same inbox filter', async ({
  page,
}) => {
  const { requests } = await harness(page);
  for (const id of [ids.missing, 'not-a-request']) {
    await page.goto(`/dashboard/quotes?quote=${id}&filter=review`);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This request isn’t available in this account.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/quotes\?filter=review$/);
    await expect(page.getByRole('button', { name: /^Needs review/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  expect(requests.reads).toEqual([ids.missing]);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('accepted and declined emailed requests remain readable without reply, price, or approval actions', async ({
  page,
}) => {
  const { requests } = await harness(page);
  for (const [id, status] of [
    [ids.accepted, 'accepted'],
    [ids.declined, 'declined'],
  ]) {
    await page.goto(`/dashboard/quotes?quote=${id}`);
    const dialog = page.getByRole('region', { name: 'Quote details', exact: true });
    await expect(dialog).toContainText(`The customer ${status} this quote.`);
    await expect(
      dialog.getByRole('textbox', { name: 'Reply directly to the customer', exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Set a price', exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Approve this quote', exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('log', { name: 'Customer conversation' })).toBeVisible();
    await expect(dialog).toContainText('The door seal leaks');
  }
  expect(requests.reads).toEqual([ids.accepted, ids.declined]);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('a failed exact read offers a free retry without substituting an inbox row', async ({
  page,
}) => {
  const { requests } = await harness(page, { firstRead: '503' });
  await page.goto(`/dashboard/quotes?quote=${ids.old}`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'This request could not be loaded.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review request', exact: true })).toContainText(
    'FictionalOlder',
  );
  expect(requests.reads).toEqual([ids.old, ids.old]);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('a delayed prior-request read cannot restore its detail or pricing controls after selection changes', async ({
  page,
}) => {
  const control = await harness(page, { firstRead: 'delayed' });
  await page.goto(`/dashboard/quotes?quote=${ids.manual}`);
  await expect(page.getByText('Opening this request…', { exact: true })).toBeVisible();
  await expect.poll(() => control.requests.reads.length).toBe(1);
  await page.evaluate(
    (quoteId) => history.pushState(null, '', `/dashboard/quotes?quote=${quoteId}`),
    ids.accepted,
  );
  const dialog = page.getByRole('region', { name: 'Quote details', exact: true });
  await expect(dialog).toContainText('FictionalAccepted');
  const priorResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/quotes/${ids.manual}`,
  );
  control.release();
  await priorResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect.poll(() => control.requests.reads.length).toBe(2);
  await expect(dialog).not.toContainText('FictionalMaya');
  await expect(dialog.getByRole('button', { name: 'Set a price', exact: true })).toHaveCount(0);
  expect(control.requests.writes).toEqual([]);
  expect(control.requests.unexpected).toEqual([]);
});

test('saved prices are not overwritten by a background opening read on dashboard refresh', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.goto(`/dashboard/quotes?quote=${ids.manual}`);
  const dialog = page.getByRole('region', { name: 'Review request', exact: true });
  await dialog.getByRole('button', { name: 'Set a price', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: 'Quote total ($)', exact: true }).fill('0');
  await dialog
    .getByRole('textbox', { name: 'Private reason for this price', exact: true })
    .fill('Warranty repair with no additional charge.');
  await dialog.getByRole('button', { name: 'Save price', exact: true }).click();
  const saved = page.getByRole('region', { name: 'Review quote', exact: true });
  await expect(
    saved.getByRole('button', { name: 'Approve this quote', exact: true }),
  ).toBeEnabled();
  await expect(saved).toContainText('$0');
  expect(requests.reads).toEqual([ids.manual]);
  expect(requests.writes).toEqual([
    {
      method: 'PATCH',
      path: `/api/v1/quotes/${ids.manual}`,
      body: { totalCents: 0, reason: 'Warranty repair with no additional charge.' },
    },
  ]);
  expect(requests.unexpected).toEqual([]);
});

test('a delayed save for another request preserves the current pricing draft and its separate approval boundary', async ({
  page,
}) => {
  const control = await harness(page, { delayPriceSave: true });
  await page.goto(`/dashboard/quotes?quote=${ids.manual}`);
  const first = page.getByRole('region', { name: 'Review request', exact: true });
  await first.getByRole('button', { name: 'Set a price', exact: true }).click();
  await first.getByRole('spinbutton', { name: 'Quote total ($)', exact: true }).fill('100');
  await first
    .getByRole('textbox', { name: 'Private reason for this price', exact: true })
    .fill('First project scope.');
  await first.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect.poll(() => control.requests.writes.length).toBe(1);
  await page.evaluate(
    (quoteId) => history.pushState(null, '', `/dashboard/quotes?quote=${quoteId}`),
    ids.priced,
  );
  const second = page.getByRole('region', { name: 'Review quote', exact: true });
  await expect(second).toContainText('FictionalLeo');
  await second.getByRole('button', { name: 'Adjust draft price', exact: true }).click();
  const amount = second.getByRole('spinbutton', { name: 'Revised quote total ($)', exact: true });
  const reason = second.getByRole('textbox', {
    name: 'Internal reason for the adjustment',
    exact: true,
  });
  await expect(amount).toHaveValue('245.00');
  await expect(reason).toHaveValue('');
  await amount.fill('300');
  await reason.fill('Second project scope remains unsaved.');
  const priorResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/v1/quotes/${ids.manual}`,
  );
  control.releasePriceSave();
  await priorResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(second).toContainText('FictionalLeo');
  await expect(amount).toHaveValue('300');
  await expect(reason).toHaveValue('Second project scope remains unsaved.');
  await expect(
    second.getByRole('button', { name: 'Save revised draft', exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole('button', { name: 'Approve this quote', exact: true }),
  ).toBeHidden();
  await expect(
    second.getByRole('textbox', { name: 'Reply directly to the customer', exact: true }),
  ).toBeHidden();
  expect(control.requests.writes).toEqual([
    {
      method: 'PATCH',
      path: `/api/v1/quotes/${ids.manual}`,
      body: { totalCents: 10000, reason: 'First project scope.' },
    },
  ]);
  expect(control.requests.unexpected).toEqual([]);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`a late approval ${outcome} for another request cannot surface actions, error, or success in the current editor`, async ({
    page,
  }) => {
    const control = await harness(page, { delayApproval: outcome });
    await page.goto(`/dashboard/quotes?quote=${ids.priced}`);
    await page.getByRole('button', { name: 'Approve this quote', exact: true }).click();
    await expect.poll(() => control.requests.writes.length).toBe(1);
    await page.evaluate(
      (quoteId) => history.pushState(null, '', `/dashboard/quotes?quote=${quoteId}`),
      ids.manual,
    );
    const current = page.getByRole('region', { name: 'Review request', exact: true });
    await expect(current).toContainText('FictionalMaya');
    await current.getByRole('button', { name: 'Set a price', exact: true }).click();
    const amount = current.getByRole('spinbutton', { name: 'Quote total ($)', exact: true });
    await amount.fill('67');
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === 'POST' &&
        new URL(item.url()).pathname === `/api/v1/quotes/${ids.priced}/approve`,
    );
    const pageReads = control.requests.pageReads;
    control.releaseApproval();
    await response;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(control.requests.pageReads).toBe(pageReads);
    await expect(current).toContainText('FictionalMaya');
    await expect(amount).toHaveValue('67');
    await expect(current.getByRole('button', { name: 'Save price', exact: true })).toBeVisible();
    await expect(
      current.getByRole('textbox', { name: 'Reply directly to the customer', exact: true }),
    ).toBeHidden();
    await expect(page.getByText('The first quote approval failed.', { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText('Quote approved.', { exact: true })).toHaveCount(0);
    expect(control.requests.writes).toEqual([
      { method: 'POST', path: `/api/v1/quotes/${ids.priced}/approve`, body: null },
    ]);
    expect(control.requests.unexpected).toEqual([]);
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a late approval ${outcome} after leaving Requests starts no page read, dashboard refresh, toast, or redirect`, async ({
    page,
  }) => {
    const control = await harness(page, { delayApproval: outcome });
    await page.goto(`/dashboard/quotes?quote=${ids.priced}`);
    await page.getByRole('button', { name: 'Approve this quote', exact: true }).click();
    await expect.poll(() => control.requests.writes.length).toBe(1);
    await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
    await expect(
      page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: 'Assistant', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${ids.service}&step=teach$`));
    await expect(
      page.getByRole('region', { name: /^(Review request|Review quote|Quote details)$/ }),
    ).toHaveCount(0);
    await expect.poll(() => control.requests.proposalReads).toBe(1);
    const destination = page.url();
    const reads = {
      page: control.requests.pageReads,
      dashboard: control.requests.dashboardReads,
      auth: control.requests.authReads,
    };
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === 'POST' &&
        new URL(item.url()).pathname === `/api/v1/quotes/${ids.priced}/approve`,
    );
    control.releaseApproval();
    await response;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page).toHaveURL(destination);
    expect({
      page: control.requests.pageReads,
      dashboard: control.requests.dashboardReads,
      auth: control.requests.authReads,
    }).toEqual(reads);
    await expect(page.getByText('Quote approved.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('The first quote approval failed.', { exact: true })).toHaveCount(
      0,
    );
    expect(control.requests.writes).toEqual([
      { method: 'POST', path: `/api/v1/quotes/${ids.priced}/approve`, body: null },
    ]);
    expect(control.requests.unexpected).toEqual([]);
  });
}
