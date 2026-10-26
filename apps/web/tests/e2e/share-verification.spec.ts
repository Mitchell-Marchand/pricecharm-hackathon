import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const serviceId = 'a2100000-0000-4000-8000-000000000001';
const email = 'fictional-share-owner@example.test';
const originalToken = 'v'.repeat(43);
const replacementToken = 'w'.repeat(43);
const sharePath = `/dashboard?service=${serviceId}&step=share`;
const at = '2026-10-28T12:00:00.000Z';

async function harness(context: BrowserContext) {
  const business = {
    id: 'a2100000-0000-4000-8000-000000000002',
    name: 'Fictional Share Painting',
    slug: 'fictional-share-painting',
    industry: 'Painting',
    description: 'Interior painting.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Interior painting',
    description: 'Painting walls with prices approved for each job.',
    unitLabel: 'room',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['Rooms to paint', 'Wall condition'],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    publishedAt: at,
    version: 2,
    approvedVersion: null,
  };
  let verified = false;
  let currentToken = originalToken;
  let releaseResend!: () => void;
  const resendResponse = new Promise<void>((resolve) => {
    releaseResend = resolve;
  });
  const requests = {
    reads: [] as string[],
    writes: [] as { path: string; body: Record<string, unknown> | null }[],
    unexpected: [] as string[],
  };
  const initialPolicy = JSON.stringify({ business, service });
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') requests.reads.push(pathname);
    else
      requests.writes.push({
        path: pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
    let data: unknown;
    if (request.method() === 'GET' && pathname === '/api/v1/auth/me')
      data = {
        business,
        user: { id: 'fictional-share-owner', name: business.name, email, emailVerified: verified },
      };
    else if (request.method() === 'GET' && pathname === '/api/v1/settings')
      data = {
        aiMode: 'live',
        providers: { openai: true, anthropic: false },
        billingConfigured: false,
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
    else if (request.method() === 'GET' && pathname === `/api/v1/services/${serviceId}/readiness`)
      data = {
        serviceId,
        serviceVersion: service.version,
        evaluation: null,
        evaluationCurrent: false,
        invalidation: 'not_evaluated',
        approvalCurrent: false,
        published: true,
        autoQuoteEnabled: false,
      };
    else if (request.method() === 'GET' && pathname === `/api/v1/services/${serviceId}/test-cases`)
      data = [];
    else if (request.method() === 'GET' && pathname === '/api/v1/billing')
      data = {
        provider: 'local',
        configured: false,
        status: 'trial',
        canIssue: true,
        trial: { remainingQuotes: 10, quoteLimit: 10, endsAt: '2099-01-01T00:00:00.000Z' },
        usage: { deliveredQuotes: 0, billableQuotes: 0, feesCents: 0, month: '2026-10' },
        tariff: {
          basisPoints: 100,
          minimumFeeCents: 50,
          maximumFeeCents: 2000,
          currency: 'USD',
          version: 'fixture',
        },
        spendingCapCents: 0,
        subscription: null,
        checkoutAvailable: false,
        portalAvailable: false,
      };
    else if (request.method() === 'POST' && pathname === '/api/v1/auth/request-verification') {
      currentToken = replacementToken;
      await resendResponse;
      data = { ok: true, delivery: 'email' };
    } else if (request.method() === 'POST' && pathname === '/api/v1/auth/verify-email') {
      expect(request.postDataJSON()).toEqual({ token: currentToken });
      verified = true;
      data = { ok: true };
    }
    if (data !== undefined) return route.fulfill({ json: { data } });
    requests.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected mocked request.' } },
    });
  });
  return {
    requests,
    releaseResend,
    policyUnchanged: () => JSON.stringify({ business, service }) === initialPolicy,
  };
}

function alerts(page: Page) {
  return page.getByLabel('Email alerts', { exact: true });
}

async function verifyInAnotherTab(context: BrowserContext, owner: Page, token: string) {
  const verification = await context.newPage();
  await verification.goto(`/verify-email#token=${encodeURIComponent(token)}`);
  await expect(
    verification.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  await expect(verification.getByRole('main')).not.toContainText('approve automatic quotes');
  expect(new URL(verification.url()).hash).toBe('');
  await verification.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(
    verification.getByText('Your email is verified. You can return to your workspace.', {
      exact: true,
    }),
  ).toBeVisible();
  await owner.bringToFront();
  // Explicitly dispatch focus as well: headless browsers need not change OS window focus.
  await owner.evaluate(() => window.dispatchEvent(new Event('focus')));
  return verification;
}

test('the original signup verification updates Share on focus with only reads and never requests a replacement email', async ({
  page,
  context,
}) => {
  const app = await harness(context);
  await page.goto(sharePath);
  await expect(alerts(page)).toContainText(email);
  await expect(
    alerts(page).getByRole('button', { name: 'Resend verification email', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Your quote link', { exact: true })).toHaveValue(
    new RegExp('/q/fictional-share-painting$'),
  );
  expect(app.requests.writes).toEqual([]);
  const initialAuthReads = app.requests.reads.filter((item) => item === '/api/v1/auth/me').length;
  const verification = await context.newPage();
  await verification.goto(`/verify-email#token=${originalToken}`);
  await expect(
    verification.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  expect(app.requests.writes).toEqual([]);
  expect(new URL(verification.url()).hash).toBe('');
  await expect(verification.getByRole('main')).not.toContainText('approve automatic quotes');
  await verification.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(
    verification.getByText('Your email is verified. You can return to your workspace.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(alerts(page)).toHaveText(`Email alerts are on for ${email}.`);
  await expect
    .poll(() => app.requests.reads.filter((item) => item === '/api/v1/auth/me').length)
    .toBeGreaterThan(initialAuthReads);
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=share$`));
  expect(app.requests.writes).toEqual([
    { path: '/api/v1/auth/verify-email', body: { token: originalToken } },
  ]);
  expect(app.policyUnchanged()).toBe(true);
  expect(app.requests.unexpected).toEqual([]);
});

test('only an explicit resend queues one replacement email while busy and its latest link returns to verified Share', async ({
  page,
  context,
}) => {
  const app = await harness(context);
  await page.goto(sharePath);
  const region = alerts(page);
  await expect(region).toContainText(email);
  expect(app.requests.writes).toEqual([]);
  await region.getByRole('button', { name: 'Resend verification email', exact: true }).click();
  await expect.poll(() => app.requests.writes.length).toBe(1);
  await expect(region.getByRole('button')).toBeDisabled();
  await page.keyboard.press('Enter');
  await region.getByRole('button').evaluate((button: HTMLButtonElement) => button.click());
  expect(app.requests.writes).toEqual([{ path: '/api/v1/auth/request-verification', body: null }]);
  await expect(region).not.toContainText('New verification email queued');
  app.releaseResend();
  await expect(region).toContainText(
    `New verification email queued for ${email}. Use the newest link to receive request alerts.`,
  );
  await expect(region).not.toContainText('email was sent');
  const verification = await verifyInAnotherTab(context, page, replacementToken);
  await expect(alerts(page)).toHaveText(`Email alerts are on for ${email}.`);
  await expect(
    verification.getByRole('link', { name: 'Return to your assistant', exact: true }),
  ).toHaveAttribute('href', '/dashboard?step=share');
  expect(app.requests.writes).toEqual([
    { path: '/api/v1/auth/request-verification', body: null },
    { path: '/api/v1/auth/verify-email', body: { token: replacementToken } },
  ]);
  expect(app.policyUnchanged()).toBe(true);
  expect(app.requests.unexpected).toEqual([]);
});
