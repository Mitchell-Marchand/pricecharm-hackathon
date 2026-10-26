import { expect, test, type Page } from '@playwright/test';
import type { Quote } from '../../src/lib/types';

const at = '2026-10-28T12:00:00.000Z';
const id = (n: number) => `c1700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const older = 'cmV2aWV3LW9sZGVy';
const newer = 'cmV2aWV3LW5ld2Vy';
const empty = 'ZW1wdHk';
const guestKey = 'quotient:guest-preview:approval';
const guestApproval = { previewId: id(99), version: 1 };
const target = id(26);

async function harness(
  page: Page,
  options: { signedIn?: boolean; delayedPage?: 'success' | 'failure'; delayAuth?: boolean } = {},
) {
  const business = {
    id: 'fictional-history-business',
    name: 'Fictional Cedar Repair',
    slug: 'fictional-cedar-repair',
    description: 'Household repair.',
    serviceArea: 'Austin',
    industry: 'Repair',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const user = {
    id: 'fictional-history-owner',
    email: 'fictional-history@example.test',
    name: business.name,
    emailVerified: true,
  };
  const service = {
    id: id(100),
    businessId: business.id,
    name: 'Household repair',
    description: business.description,
    unitLabel: 'project',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['model'],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    version: 1,
    publishedAt: at,
  };
  const rows: Quote[] = Array.from({ length: 29 }, (_, index) => {
    const n = index + 1;
    return {
      id: id(n),
      serviceId: service.id,
      customerName: `FictionalRequest${String(n).padStart(2, '0')}`,
      customerEmail: `fictional-request-${n}@example.test`,
      description: `Appliance inspection for fictional project ${n}. The owner needs to inspect the leaking door seal.`,
      status: n <= 26 ? 'review' : n <= 28 ? 'issued' : 'accepted',
      manualPriceRequired: n <= 26,
      totalCents: n <= 26 ? 0 : 12500,
      quantity: 1,
      currency: 'USD',
      lineItems:
        n <= 26
          ? []
          : [
              {
                description: 'Project price',
                quantity: 1,
                unitPriceCents: 12500,
                totalCents: 12500,
              },
            ],
      assumptions: ['Inspection covers the door seal.'],
      issuedBy: n <= 26 ? undefined : 'owner',
      createdAt: at,
    };
  });
  let signedIn = options.signedIn !== false;
  let releasePage: (() => void) | undefined;
  let releaseAuth: (() => void) | undefined;
  let delayed = false;
  const requests = {
    pages: [] as { filter: string; cursor: string | null }[],
    details: [] as string[],
    auth: 0,
    logins: 0,
    writes: [] as { path: string; body: unknown }[],
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const unauthorized = () =>
      route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } },
      });
    let data: unknown;
    if (path === '/api/v1/auth/me') {
      requests.auth++;
      if (options.delayAuth && requests.auth === 1) {
        await new Promise<void>((resolve) => {
          releaseAuth = resolve;
        });
        return unauthorized();
      }
      if (!signedIn) return unauthorized();
      data = { user, business };
    } else if (path === '/api/v1/auth/login') {
      requests.logins++;
      signedIn = true;
      data = { user, business };
    } else if (path === '/api/v1/settings')
      data = {
        aiMode: 'demo',
        providers: { openai: false, anthropic: false },
        billingConfigured: false,
      };
    else if (path === '/api/v1/dashboard') {
      if (!signedIn) return unauthorized();
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [rows[0]],
        stats: {
          totalQuotes: rows.length,
          reviewQuotes: rows.filter((row) => row.status === 'review').length,
          issuedQuotes: rows.filter((row) => row.status === 'issued').length,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { aiCalls: 0, billableQuotes: 0 },
      };
    } else if (path === '/api/v1/quotes/page') {
      const filter = url.searchParams.get('filter') || 'all',
        cursor = url.searchParams.get('cursor');
      requests.pages.push({ filter, cursor });
      if (options.delayedPage && cursor === older && !delayed) {
        delayed = true;
        await new Promise<void>((resolve) => {
          releasePage = resolve;
        });
        if (options.delayedPage === 'failure')
          return route.fulfill({
            status: 503,
            json: { error: { code: 'UNAVAILABLE', message: 'Old page failed.' } },
          });
      }
      if (cursor && ![older, newer, empty].includes(cursor))
        return route.fulfill({
          status: 400,
          json: { error: { code: 'INVALID_CURSOR', message: 'Invalid request cursor.' } },
        });
      if ((cursor === older || cursor === newer) && filter !== 'review')
        return route.fulfill({
          status: 400,
          json: { error: { code: 'INVALID_CURSOR', message: 'Cursor filter mismatch.' } },
        });
      const matches = rows.filter((row) => filter === 'all' || row.status === filter);
      const subset =
        cursor === empty ? [] : cursor === older ? matches.slice(25, 50) : matches.slice(0, 25);
      data = {
        quotes: subset,
        counts: {
          all: rows.length,
          review: rows.filter((row) => row.status === 'review').length,
          issued: rows.filter((row) => row.status === 'issued').length,
        },
        pageSize: 25,
        olderCursor:
          filter === 'review' && cursor !== older && cursor !== empty && matches.length > 25
            ? older
            : null,
        newerCursor: cursor === older && subset.length ? newer : null,
      };
    } else {
      const match = /^\/api\/v1\/quotes\/([^/]+)(?:\/(photos|conversation|approve))?$/.exec(path),
        quote = rows.find((row) => row.id === match?.[1]);
      if (method === 'GET' && quote && !match?.[2]) {
        requests.details.push(quote.id);
        data = quote;
      } else if (method === 'GET' && quote && match?.[2] === 'photos') data = [];
      else if (method === 'GET' && quote && match?.[2] === 'conversation')
        data = [{ id: `customer-${quote.id}`, role: 'user', content: quote.description }];
      else if (method === 'PATCH' && quote && !match?.[2]) {
        requests.writes.push({ path, body: req.postDataJSON() });
        quote.totalCents = req.postDataJSON().totalCents;
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
      } else if (method === 'POST' && quote && match?.[2] === 'approve') {
        requests.writes.push({ path, body: null });
        quote.status = 'issued';
        quote.issuedBy = 'owner';
        data = quote;
      } else {
        requests.unexpected.push(`${method} ${path}`);
        return route.fulfill({ status: 500, json: { error: { code: 'UNMOCKED', message: path } } });
      }
    }
    await route.fulfill({ json: { data } });
  });
  return { requests, releasePage: () => releasePage?.(), releaseAuth: () => releaseAuth?.() };
}

async function login(page: Page) {
  await page.getByLabel(/^Email address/).fill('fictional-history@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-long!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
const list = (page: Page) => page.getByRole('region', { name: 'Customer requests', exact: true });

test('global counts and URL-reconstructible older/newer pages remain truthful through reload and browser history', async ({
  page,
}) => {
  const app = await harness(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/quotes?filter=review');
  await expect(page.getByRole('button', { name: 'All requests 29', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs review 26', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Issued 2', exact: true })).toBeVisible();
  await expect(list(page).getByRole('listitem')).toHaveCount(25);
  await page.getByRole('button', { name: 'Older requests', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`filter=review&cursor=${older}$`));
  await expect(list(page).getByRole('listitem')).toHaveCount(1);
  await expect(list(page)).toContainText('FictionalRequest26');
  await expect(page.getByRole('button', { name: 'Needs review 26', exact: true })).toBeVisible();
  await page.reload();
  await expect(list(page).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Newer requests', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`cursor=${newer}$`));
  await expect(list(page).getByRole('listitem')).toHaveCount(25);
  await page.goBack();
  await expect(list(page)).toContainText('FictionalRequest26');
  await page.goForward();
  await expect(list(page).getByRole('listitem')).toHaveCount(25);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  }
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('saving and separately approving an older price retains its issued detail and same empty review page until explicit Newest', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(`/dashboard/quotes?filter=review&cursor=${older}`);
  await page
    .getByRole('button', { name: 'Review request for FictionalRequest26', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`quote=${target}&filter=review&cursor=${older}$`));
  const request = page.getByRole('region', { name: 'Review request', exact: true });
  await request.getByRole('button', { name: 'Set a price', exact: true }).click();
  await request.getByRole('spinbutton', { name: 'Quote total ($)', exact: true }).fill('0');
  await request
    .getByRole('textbox', { name: 'Private reason for this price', exact: true })
    .fill('Warranty repair; no additional charge.');
  await request.getByRole('button', { name: 'Save price', exact: true }).click();
  const saved = page.getByRole('region', { name: 'Review quote', exact: true });
  await expect(
    saved.getByRole('button', { name: 'Approve this quote', exact: true }),
  ).toBeEnabled();
  expect(app.requests.writes).toHaveLength(1);
  await saved.getByRole('button', { name: 'Approve this quote', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Quote details', exact: true })).toContainText(
    'Issued by your business.',
  );
  await expect(page.getByRole('button', { name: 'Needs review 25', exact: true })).toBeAttached();
  expect(
    app.requests.pages.every((entry) => entry.filter === 'review' && entry.cursor === older),
  ).toBe(true);
  expect(app.requests.details).toEqual([target]);
  await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`filter=review&cursor=${older}$`));
  await expect(
    page.getByRole('heading', { name: 'No requests on this page', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'All requests 29', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issued 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Newest requests', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/quotes\?filter=review$/);
  await expect(list(page).getByRole('listitem')).toHaveCount(25);
  expect(app.requests.writes).toEqual([
    {
      path: `/api/v1/quotes/${target}`,
      body: { totalCents: 0, reason: 'Warranty repair; no additional charge.' },
    },
    { path: `/api/v1/quotes/${target}/approve`, body: null },
  ]);
  expect(app.requests.unexpected).toEqual([]);
});

for (const selected of [false, true]) {
  test(`expired ${selected ? 'selected request' : 'inbox page'} login restores the same filter/cursor and ignores unrelated guest approval`, async ({
    page,
  }) => {
    const app = await harness(page, { signedIn: false });
    await page.addInitScript(
      ({ guestKey, guestApproval }) =>
        sessionStorage.setItem(guestKey, JSON.stringify(guestApproval)),
      { guestKey, guestApproval },
    );
    await page.goto(
      `/dashboard/quotes?${selected ? `quote=${target}&` : ''}filter=review&cursor=${older}`,
    );
    await expect(page).toHaveURL(
      new RegExp(
        `/login\\?${selected ? `quote=${target}` : 'inbox=1'}&filter=review&cursor=${older}$`,
      ),
    );
    await expect(
      page.getByText(
        selected ? 'Sign in to open this quote request.' : 'Sign in to open your requests.',
        { exact: true },
      ),
    ).toBeVisible();
    await login(page);
    await expect(page).toHaveURL(
      new RegExp(
        `/dashboard/quotes\\?${selected ? `quote=${target}&` : ''}filter=review&cursor=${older}$`,
      ),
    );
    if (selected) {
      await expect(page.getByRole('region', { name: 'Review request', exact: true })).toContainText(
        'FictionalRequest26',
      );
      await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
    }
    await expect(list(page)).toContainText('FictionalRequest26');
    expect(
      await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null'), guestKey),
    ).toEqual(guestApproval);
    expect(app.requests.logins).toBe(1);
    expect(app.requests.writes).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });
}

test('changing filters resets only the cursor and Back restores the older page', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(`/dashboard/quotes?filter=review&cursor=${older}`);
  await expect(list(page)).toContainText('FictionalRequest26');
  await page.getByRole('button', { name: 'Issued 2', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/quotes\?filter=issued$/);
  await expect(list(page).getByRole('listitem')).toHaveCount(2);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`filter=review&cursor=${older}$`));
  await expect(list(page)).toContainText('FictionalRequest26');
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

for (const cursor of ['invalid', empty]) {
  test(`${cursor === empty ? 'empty' : 'invalid'} cursor requires explicit Newest recovery and never silently loads page one`, async ({
    page,
  }) => {
    const app = await harness(page);
    await page.goto(`/dashboard/quotes?filter=review&cursor=${cursor}`);
    await expect(page.getByRole('button', { name: 'Newest requests', exact: true })).toBeVisible();
    await expect(list(page).getByRole('listitem')).toHaveCount(0);
    if (cursor === empty)
      await expect(
        page.getByRole('button', { name: 'Needs review 26', exact: true }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole('alert').filter({ hasText: 'This request page isn’t available.' }),
      ).toBeVisible();
    expect(app.requests.pages).toEqual([{ filter: 'review', cursor }]);
    await page.getByRole('button', { name: 'Newest requests', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(25);
    expect(app.requests.pages).toEqual([
      { filter: 'review', cursor },
      { filter: 'review', cursor: null },
    ]);
    expect(app.requests.writes).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a late older-page ${outcome} cannot overwrite a newer filter or show dashboard recent rows during loading`, async ({
    page,
  }) => {
    const app = await harness(page, { delayedPage: outcome });
    await page.goto(`/dashboard/quotes?filter=review&cursor=${older}`);
    await expect(page.getByText('Loading your requests…', { exact: true })).toBeVisible();
    await expect(list(page)).not.toContainText('FictionalRequest01');
    await expect.poll(() => app.requests.pages.length).toBe(1);
    await page.getByRole('button', { name: 'Issued', exact: true }).click();
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    const response = page.waitForResponse(
      (item) =>
        new URL(item.url()).pathname === '/api/v1/quotes/page' &&
        new URL(item.url()).searchParams.get('cursor') === older,
    );
    app.releasePage();
    await response;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page.getByRole('button', { name: 'Issued 2', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(list(page).getByRole('listitem')).toHaveCount(2);
    await expect(list(page)).not.toContainText('FictionalRequest26');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Your requests could not be loaded.' }),
    ).toHaveCount(0);
    expect(app.requests.writes).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });
}

test('a delayed dashboard401 uses the current inbox URL rather than its original section', async ({
  page,
}) => {
  const app = await harness(page, { delayAuth: true });
  await page.goto('/dashboard/not-here');
  await expect.poll(() => app.requests.auth).toBe(1);
  await page.getByRole('link', { name: 'Requests', exact: true }).click();
  await page.evaluate(
    (cursor) => history.replaceState(null, '', `/dashboard/quotes?filter=review&cursor=${cursor}`),
    older,
  );
  app.releaseAuth();
  await expect(page).toHaveURL(new RegExp(`/login\\?inbox=1&filter=review&cursor=${older}$`));
  expect(app.requests.auth).toBe(1);
  await expect(page.getByText('Sign in to open your requests.', { exact: true })).toBeVisible();
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('a delayed dashboard401 does not erase an already-selected login destination outside Dashboard', async ({
  page,
}) => {
  const app = await harness(page, { delayAuth: true });
  await page.goto('/dashboard/not-here');
  await expect.poll(() => app.requests.auth).toBe(1);
  const destination = `/login?quote=${target}&filter=review&cursor=${older}`;
  await page.evaluate((url) => history.pushState(null, '', url), destination);
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === '/api/v1/auth/me',
  );
  app.releaseAuth();
  await response;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page).toHaveURL(new RegExp(`${destination.replace('?', '\\?')}$`));
  expect(app.requests.auth).toBe(1);
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});
