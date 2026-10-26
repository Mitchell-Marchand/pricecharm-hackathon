import { expect, test, type Page } from '@playwright/test';
import type { GuestPreview } from '../../src/lib/types';

const previewId = '35100000-0000-4000-8000-000000000001';
const laterId = '35100000-0000-4000-8000-000000000002';
const serviceId = '35100000-0000-4000-8000-000000000003';
const at = '2026-10-28T12:00:00.000Z';
const note = 'I run Porch & Paw, a mobile dog grooming service. I charged $95 for a groom.';
const laterNote = 'I run Newer Name, a different dog grooming business.';
const signup = `/signup?from=preview&previewId=${previewId}&version=1`;
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Business name', exact: true });

async function harness(
  page: Page,
  options: {
    suggestion?: string | null;
    delayPreview?: boolean;
    failRegistration?: boolean;
    unavailable?: boolean;
  } = {},
) {
  const business = {
    id: 'fictional-name-business',
    name: 'Fictional Owner Name',
    slug: 'fictional-name-grooming',
    industry: 'Grooming',
    description: 'Mobile dog grooming.',
    serviceArea: '',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const user = {
    id: 'fictional-name-owner',
    name: business.name,
    email: 'fictional-name@example.test',
    emailVerified: false,
  };
  const questions = [
    'What breed is your dog?',
    'What grooming would you like?',
    'What is the coat like?',
  ];
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Mobile dog grooming',
    description: 'Baths, brushing and haircuts.',
    unitLabel: 'project',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: questions,
    pricingRules: [],
    exclusions: [],
    mode: 'review',
    publishedAt: null,
    version: 2,
  };
  const preview: GuestPreview = {
    id: previewId,
    version: 1,
    status: 'ready',
    content: note,
    expiresAt: '2099-01-01T00:00:00.000Z',
    businessNameSuggestion: options.suggestion,
    receipt: {
      name: service.name,
      description: service.description,
      unitLabel: null,
      example: {
        title: 'Past dog groom',
        description: 'A dog groom.',
        quantity: null,
        finalPriceCents: null,
        rationale: '',
      },
      sourcePriceText: '$95',
      sourceCurrency: null,
    },
    questions,
    readyToSave: true,
    aiMode: 'live',
  };
  const later = {
    ...preview,
    id: laterId,
    content: laterNote,
    businessNameSuggestion: 'Newer Name',
  };
  let releasePreview = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let releaseRegistration = () => {};
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  let authenticated = false;
  const requests = {
    gets: [] as string[],
    registrations: [] as Record<string, unknown>[],
    claims: [] as { path: string; body: unknown }[],
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data: unknown;
    if (request.method() === 'GET' && path === '/api/v1/guest-preview') {
      requests.gets.push(url.search);
      if (options.delayPreview) await previewGate;
      data = {
        preview: options.unavailable
          ? null
          : url.searchParams.get('previewId') === previewId
            ? preview
            : later,
        recoverablePreview: options.unavailable ? later : null,
        expiresAt: preview.expiresAt,
      };
    } else if (request.method() === 'GET' && path === '/api/v1/auth/me') {
      if (!authenticated)
        return route.fulfill({ status: 401, json: { error: { message: 'Sign in required.' } } });
      data = { user, business };
    } else if (request.method() === 'POST' && path === '/api/v1/auth/register') {
      requests.registrations.push(request.postDataJSON());
      if (options.failRegistration) {
        await registrationGate;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Registration is temporarily unavailable.' } },
        });
      }
      authenticated = true;
      business.name = String(request.postDataJSON().businessName);
      data = { user, business };
    } else if (request.method() === 'POST' && path === `/api/v1/guest-preview/${previewId}/claim`) {
      requests.claims.push({ path, body: request.postDataJSON() });
      data = { service, alreadyClaimed: false };
    } else if (request.method() === 'GET' && path === '/api/v1/settings') {
      data = { aiMode: 'live', providers: { openai: true }, billingConfigured: false };
    } else if (request.method() === 'GET' && path === '/api/v1/dashboard') {
      data = {
        business,
        services: [service],
        examples: [],
        trainingSessions: [],
        recentQuotes: [],
        jobNotes: [
          {
            id: 'fictional-job-note',
            serviceId,
            source: 'setup',
            kind: 'historical_job',
            title: 'Past dog groom',
            description: 'A dog groom.',
            quantity: null,
            unitLabel: null,
            finalPriceCents: null,
            sourceNotes: note,
            sourcePriceText: '$95',
            sourceCurrency: null,
            rationale: '',
            createdAt: at,
          },
        ],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 1 },
      };
    } else if (request.method() === 'GET' && path === `/api/v1/services/${serviceId}/proposals`) {
      data = {
        proposals: [
          {
            id: 'fictional-name-proposal',
            status: 'applied',
            serviceVersion: 1,
            appliedServiceVersion: 2,
            teachingRevision: 0,
            parentProposalId: null,
            sourceExampleIds: [],
            sourceCaseIds: ['fictional-job-note'],
            proposal: { requiredInputs: questions },
          },
        ],
        teaching: { revision: 0, notes: [] },
      };
    } else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: 'Unexpected business-name test request.' } },
      });
    }
    return route.fulfill({ json: { data } });
  });
  return { requests, releasePreview, releaseRegistration };
}

async function fillCredentials(page: Page) {
  await page
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('fictional-name@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-only!');
}

test('the exact approved preview suggests its brand despite a later draft, and signup submits the owner correction without another analysis', async ({
  page,
}) => {
  const app = await harness(page, { suggestion: 'Porch & Paw' });
  await page.addInitScript(
    ({ laterId, laterNote }) => {
      sessionStorage.setItem(
        'quotient:guest-preview:draft',
        JSON.stringify({ content: laterNote, requestId: laterId, editing: true }),
      );
      sessionStorage.setItem(
        'quotient:guest-preview:approval',
        JSON.stringify({ previewId: laterId, version: 1 }),
      );
    },
    { laterId, laterNote },
  );
  await page.goto(signup);
  await expect(nameField(page)).toHaveValue('Porch & Paw');
  await nameField(page).fill('Porch & Paw by Rowan');
  await fillCredentials(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  expect(app.requests.registrations).toEqual([
    {
      businessName: 'Porch & Paw by Rowan',
      name: 'Porch & Paw by Rowan',
      email: 'fictional-name@example.test',
      password: 'Fictional-password-only!',
    },
  ]);
  expect(app.requests.gets).toEqual([`?previewId=${previewId}`]);
  expect(app.requests.claims).toEqual([
    {
      path: `/api/v1/guest-preview/${previewId}/claim`,
      body: { expectedVersion: 1, approveIntake: true },
    },
  ]);
  const draft = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('quotient:guest-preview:draft') || 'null'),
  );
  expect(draft).toMatchObject({ content: laterNote, requestId: laterId, editing: true });
  expect(app.requests.unexpected).toEqual([]);
});

test('a typed name wins a delayed preview and stays on the same focused input after failed registration', async ({
  page,
}) => {
  const app = await harness(page, {
    suggestion: 'Porch & Paw',
    delayPreview: true,
    failRegistration: true,
  });
  await page.goto(signup);
  await expect(page.getByText('Loading your preview…', { exact: true })).toBeVisible();
  await nameField(page).fill('Owner typed this name');
  const input = await nameField(page).elementHandle();
  app.releasePreview();
  await expect(page.getByText('Loading your preview…', { exact: true })).toHaveCount(0);
  await expect(nameField(page)).toHaveValue('Owner typed this name');
  expect(
    await input!.evaluate((element) => element.isConnected && document.activeElement === element),
  ).toBe(true);
  await fillCredentials(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => app.requests.registrations.length).toBe(1);
  await nameField(page).focus();
  app.releaseRegistration();
  await expect(
    page.getByText('Registration is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(nameField(page)).toHaveValue('Owner typed this name');
  expect(
    await input!.evaluate((element) => element.isConnected && document.activeElement === element),
  ).toBe(true);
  expect(app.requests.claims).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('a deliberate clear wins a delayed suggestion and retains native required validation', async ({
  page,
}) => {
  const app = await harness(page, { suggestion: 'Porch & Paw', delayPreview: true });
  await page.goto(signup);
  await expect(page.getByText('Loading your preview…', { exact: true })).toBeVisible();
  await nameField(page).fill('Temporary owner entry');
  await nameField(page).fill('');
  const input = await nameField(page).elementHandle();
  app.releasePreview();
  await expect(page.getByText('Loading your preview…', { exact: true })).toHaveCount(0);
  await expect(nameField(page)).toHaveValue('');
  expect(
    await input!.evaluate((element) => element.isConnected && document.activeElement === element),
  ).toBe(true);
  await fillCredentials(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect(
    await nameField(page).evaluate(
      (element) => (element as HTMLInputElement).validity.valueMissing,
    ),
  ).toBe(true);
  expect(app.requests.registrations).toEqual([]);
  expect(app.requests.claims).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

for (const suggestion of [undefined, null]) {
  test(`${suggestion === undefined ? 'An absent' : 'A null'} brand suggestion leaves the name blank instead of using the service title`, async ({
    page,
  }) => {
    const app = await harness(page, { suggestion });
    await page.goto(signup);
    await expect(page.getByText('Loading your preview…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled();
    await expect(nameField(page)).toHaveValue('');
    expect(app.requests.gets).toEqual([`?previewId=${previewId}`]);
    expect(app.requests.registrations).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });
}

test('an unavailable exact preview cannot borrow a business name from a recoverable different preview', async ({
  page,
}) => {
  const app = await harness(page, { suggestion: 'Porch & Paw', unavailable: true });
  await page.goto(signup);
  await expect(
    page.getByText('Your preview isn’t available here. Your note is kept on the preview page.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(nameField(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  expect(app.requests.registrations).toEqual([]);
  expect(app.requests.claims).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});
