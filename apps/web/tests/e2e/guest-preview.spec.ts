import { expect, test, type Page } from '@playwright/test';
import type { GuestPreview } from '../../src/lib/types';

const at = '2026-10-28T12:00:00.000Z';
const previewId = '61000000-0000-4000-8000-000000000001';
const serviceId = '61000000-0000-4000-8000-000000000002';
const note =
  'I’m a photographer in Denver. I recently photographed a birthday portrait session and charged $180 because it was a brief shoot and included edited photos. I bill by the hour, but I didn’t record how many hours that job took. I price each job individually and don’t have a standard hourly rate.';
const savedProject = 'A brief birthday portrait session with edited photographs.';
const questions = [
  'What kind of photos would you like?',
  'Where will the session take place?',
  'Would you like edited digital photos?',
];

async function harness(page: Page, mode = 'normal') {
  const business = {
    id: 'fictional-guest-business',
    name: 'Fictional Portraits',
    slug: 'fictional-portraits',
    industry: 'Photography',
    description: '',
    serviceArea: '',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Photography',
    description: 'Photography services.',
    unitLabel: 'hour',
    unitPriceCents: 0,
    minimumChargeCents: 0,
    basePriceCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: questions,
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    publishedAt: null,
    version: 2,
  };
  const ready = (content: string): GuestPreview => ({
    id: previewId,
    version: 1,
    status: 'ready',
    content,
    expiresAt: '2099-01-01T00:00:00Z',
    receipt: {
      name: service.name,
      description: service.description,
      unitLabel: 'hour',
      example:
        mode === 'service-only'
          ? null
          : {
              title: mode === 'service-only' ? 'Photography services' : 'Birthday portrait session',
              description: savedProject,
              quantity: null,
              finalPriceCents: null,
              rationale:
                mode === 'blank-rationale'
                  ? '   '
                  : mode === 'duplicate-rationale'
                    ? 'A brief birthday portrait session with edited photographs.'
                    : 'The session was brief and included edited photos.',
            },
      sourcePriceText: mode === 'service-only' ? null : '$180',
      sourceCurrency: null,
    },
    questions,
    readyToSave: true,
    aiMode: 'live',
  });
  let preview: GuestPreview | null = null;
  let authenticated = mode === 'owner';
  let pendingGets = 0;
  const requests = {
    previews: [] as Record<string, unknown>[],
    claims: [] as Record<string, unknown>[],
    registrations: 0,
    logins: 0,
    gets: 0,
    unexpected: [] as string[],
  };
  const user = {
    id: 'fictional-guest-owner',
    name: business.name,
    email: 'fictional-guest@example.test',
    emailVerified: false,
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data: unknown;
    let status = 200;
    if (path === '/api/v1/guest-preview' && request.method() === 'GET') {
      requests.gets++;
      if (mode === 'pending' && preview?.status === 'processing') {
        if (++pendingGets > 1) preview = { ...preview, status: 'ready' };
      }
      data = { preview, recoverablePreview: null, expiresAt: '2099-01-01T00:00:00Z' };
    } else if (path === '/api/v1/guest-preview' && request.method() === 'POST') {
      const body = request.postDataJSON();
      requests.previews.push(body);
      preview = ready(body.content);
      if (mode === 'unclear' && requests.previews.length === 1) {
        preview = {
          ...preview,
          readyToSave: false,
          receipt: null,
          questions: [],
        };
      }
      if (mode === 'failure' && requests.previews.length === 1)
        preview = {
          ...preview,
          status: 'failed',
          readyToSave: false,
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'Questions could not be prepared. Your note is kept.',
          },
        } as typeof preview;
      if (mode === 'pending') {
        preview = { ...preview, status: 'processing' };
        status = 202;
      }
      if (mode === 'lost' && requests.previews.length === 1) return route.abort('failed');
      data = { preview };
    } else if (path === '/api/v1/auth/me') {
      if (!authenticated)
        return route.fulfill({
          status: 401,
          json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } },
        });
      data = { user, business };
    } else if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login') {
      if (path.endsWith('register')) requests.registrations++;
      else requests.logins++;
      authenticated = true;
      data = { user, business };
    } else if (path === `/api/v1/guest-preview/${previewId}/claim`) {
      requests.claims.push(request.postDataJSON());
      if (mode === 'claim-error' && requests.claims.length === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'TEMPORARILY_UNAVAILABLE',
              message: 'Your account is ready. Saving is temporarily unavailable.',
            },
          },
        });
      if (preview)
        preview = {
          ...preview,
          status: 'claimed',
          claim: { serviceId, setupId: 'fictional-setup', proposalId: 'fictional-proposal' },
        } as typeof preview;
      if (mode === 'claim-lost') {
        if (preview)
          preview = { ...preview, receipt: null, content: '', questions: [], readyToSave: false };
        return route.abort('failed');
      }
      data = { service, alreadyClaimed: requests.claims.length > 1 };
    } else if (path === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [
          {
            id: 'fictional-note',
            serviceId,
            source: 'setup',
            kind: mode === 'service-only' ? 'service_notes' : 'historical_job',
            title: 'Birthday portrait session',
            description: mode === 'service-only' ? service.description : savedProject,
            quantity: null,
            unitLabel: 'hour',
            finalPriceCents: null,
            sourcePriceText: mode === 'service-only' ? null : '$180',
            sourceCurrency: null,
            rationale:
              mode === 'service-only' ? '' : 'The session was brief and included edited photos.',
            sourceNotes: preview?.content || note,
            createdAt: at,
          },
        ],
        recentQuotes: [],
        trainingSessions: [],
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
    else if (path === '/api/v1/settings')
      data = {
        providers: { openai: true, anthropic: false },
        aiMode: 'live',
        billingConfigured: false,
      };
    else if (path === `/api/v1/services/${serviceId}/proposals`)
      data = {
        proposals: [
          {
            id: 'fictional-proposal',
            status: 'applied',
            serviceVersion: 1,
            appliedServiceVersion: 2,
            teachingRevision: 0,
            parentProposalId: null,
            sourceExampleIds: [],
            sourceCaseIds: ['fictional-note'],
            proposal: { requiredInputs: questions },
          },
        ],
        teaching: { revision: 0, notes: [] },
      };
    else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: { code: 'UNMOCKED', message: path } } });
    }
    await route.fulfill({ status, json: { data } });
  });
  return {
    requests,
    expire: () => {
      preview = null;
    },
  };
}

async function previewJob(page: Page) {
  await page.goto('/');
  await page.getByLabel('Start with your work.', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Your assistant preview', exact: true }),
  ).toBeVisible();
}

async function fillAccount(page: Page) {
  await page.getByLabel(/^Business name/).fill('Fictional Portraits');
  await page.getByLabel(/^Email address/).fill('fictional-guest@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-long!');
}

test('real value precedes signup and the approved questions survive claim with unknown hours and currency', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await previewJob(page);
  const receipt = page.getByRole('region', { name: 'Your assistant preview', exact: true });
  await expect(receipt.getByRole('heading', { level: 2 })).toHaveText('Photography');
  await expect(receipt).toContainText('Photography services.');
  await expect(receipt).toContainText('Your past job');
  await expect(receipt).toContainText('brief birthday portrait session');
  await expect(receipt).toContainText('Hours unknown');
  await expect(receipt.getByText('Why this price:', { exact: true })).toBeVisible();
  await expect(receipt).toContainText('The session was brief and included edited photos.');
  await expect(receipt.getByRole('listitem')).toHaveText(questions);
  await expect(receipt).toContainText('$180 from your note');
  await expect(receipt).not.toContainText('USD');
  expect(requests.registrations).toBe(0);
  expect(requests.previews).toHaveLength(1);
  await page.getByText('Your original note', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText(note);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  }
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(page).toHaveURL(/\/signup\?from=preview/);
  await expect(page.locator('form input')).toHaveCount(3);
  await page.getByText('View your preview · 3 questions', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toContainText(
    'Photography services.',
  );
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toContainText(
    'The session was brief and included edited photos.',
  );
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(
    page.getByRole('button', { name: 'Price a practice job', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toContainText(
    'The session was brief and included edited photos.',
  );
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Try a customer request', exact: true }),
  ).toBeVisible();
  const project = page.getByLabel('Customer’s project', { exact: true });
  await expect(project).toHaveValue(savedProject);
  await expect(project).toBeEditable();
  await expect(page.getByRole('button', { name: 'Try this request', exact: true })).toBeEnabled();
  const editedRequest =
    'A family photo session in Denver. We would like edited digital photographs.';
  await project.fill(editedRequest);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=try$`));
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveValue(editedRequest);
  expect(requests.unexpected).toEqual([]);
  await page.getByRole('button', { name: 'Teach', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toContainText(
    'Your saved job',
  );
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.previews).toHaveLength(1);
  expect(requests.registrations).toBe(1);
  expect(requests.unexpected).toEqual([]);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await expect(page.locator('.case-note-row')).toContainText('$180 from your note');
  await expect(page.locator('.case-note-row')).not.toContainText('USD');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=try$`));
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveValue(editedRequest);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  expect(requests.previews).toHaveLength(1);
  expect(requests.claims).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

for (const mode of ['blank-rationale', 'duplicate-rationale']) {
  test(`${mode} does not add an empty or repeated pricing reason to the private receipt`, async ({
    page,
  }) => {
    const { requests } = await harness(page, mode);
    await previewJob(page);
    const receipt = page.getByRole('region', { name: 'Your assistant preview', exact: true });
    await expect(receipt.getByText('Why this price:', { exact: true })).toHaveCount(0);
    await expect(receipt).toContainText('$180 from your note');
    await expect(receipt).toContainText('Hours unknown');
    await page.getByText('Your original note', { exact: true }).click();
    await expect(page.locator('details[open]')).toContainText(note);
    expect(requests.previews).toHaveLength(1);
    expect(requests.claims).toHaveLength(0);
    expect(requests.unexpected).toEqual([]);
  });
}

test('editing and Back preserve both the unsent note and stored preview without automatic reanalysis', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await previewJob(page);
  await page.getByRole('button', { name: 'Edit your note', exact: true }).click();
  const amended = `${note} I also need to know the date.`;
  await page.getByLabel('Start with your work.', { exact: true }).fill(amended);
  await page.reload();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(amended);
  expect(requests.previews).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to your preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  await expect(
    page.getByText('These are your earlier questions. Your changes aren’t included.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save earlier questions', exact: true }).click();
  await expect(page).toHaveURL(/signup/);
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  expect(requests.previews).toHaveLength(1);
  expect(requests.claims).toHaveLength(0);
});

test('a lost preview response recovers the existing result with GET rather than generating twice', async ({
  page,
}) => {
  const { requests } = await harness(page, 'lost');
  await previewJob(page);
  expect(requests.previews).toHaveLength(1);
  expect(requests.gets).toBeGreaterThan(1);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  expect(requests.previews).toHaveLength(1);
});

test('a persisted processing result polls without duplicate POSTs and survives refresh', async ({
  page,
}) => {
  const { requests } = await harness(page, 'pending');
  await page.goto('/');
  await page.getByLabel('Start with your work.', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(
    page.getByText('Preparing questions from your note…', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  expect(requests.previews).toHaveLength(1);
});

test('a persisted provider failure keeps the note and only retries after an explicit action', async ({
  page,
}) => {
  const { requests } = await harness(page, 'failure');
  await page.goto('/');
  await page.getByLabel('Start with your work.', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Questions could not be prepared.' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(note);
  expect(requests.previews).toHaveLength(1);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  expect(requests.previews).toHaveLength(2);
  expect(requests.previews[0].requestId).not.toBe(requests.previews[1].requestId);
});

test('claim failure retains authenticated account and exact approval without registering or analyzing again', async ({
  page,
}) => {
  const { requests } = await harness(page, 'claim-error');
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your account is ready.' })).toBeVisible();
  await expect(page.locator('form input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try saving again', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?service=/);
  expect(requests.registrations).toBe(1);
  expect(requests.previews).toHaveLength(1);
  expect(requests.claims).toEqual([
    { expectedVersion: 1, approveIntake: true },
    { expectedVersion: 1, approveIntake: true },
  ]);
  expect(requests.unexpected).toEqual([]);
});

test('an existing signed-in owner explicitly saves the preview directly without another account or learning pass', async ({
  page,
}) => {
  const { requests } = await harness(page, 'owner');
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(
    page.getByRole('button', { name: 'Price a practice job', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveValue(savedProject);
  await expect(page.getByRole('button', { name: 'Try this request', exact: true })).toBeEnabled();
  expect(requests.registrations).toBe(0);
  expect(requests.claims).toHaveLength(1);
  expect(requests.previews).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

test('an expired preview keeps the original text and does not silently create an account or regenerate', async ({
  page,
}) => {
  const { requests, expire } = await harness(page);
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(page).toHaveURL(/signup/);
  expire();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Back to your preview', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to your preview', exact: true }).click();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(note);
  expect(requests.previews).toHaveLength(1);
  expect(requests.registrations).toBe(0);
  expect(requests.claims).toHaveLength(0);
});

test('a lost successful claim opens the saved assistant after reload without another claim or registration', async ({
  page,
}) => {
  const { requests } = await harness(page, 'claim-lost');
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try saving again', exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Your assistant is saved.', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open your assistant', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?service=/);
  expect(requests.registrations).toBe(1);
  expect(requests.claims).toHaveLength(1);
  expect(requests.previews).toHaveLength(1);
});

test('the HttpOnly guest session restores value and permits explicit signup approval when browser storage is blocked', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    });
  });
  await previewJob(page);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.previews).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

test('unclear work returns an actionable service clarification and preserves the original note without automatic calls', async ({
  page,
}) => {
  const { requests } = await harness(page, 'unclear');
  const unclear = 'I help people with a variety of things. One recent job was $180.';
  await page.goto('/');
  await page.getByLabel('Start with your work.', { exact: true }).fill(unclear);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'What service do you offer?', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save your assistant', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: 'Here’s what I’d ask', exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByLabel('Your reply', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Your reply', { exact: true })).toBeEditable();
  await expect(page.locator('details[open]')).toContainText(unclear);
  await expect(
    page.getByRole('button', { name: 'Describe your service', exact: true }),
  ).toHaveCount(0);
  expect(requests.previews).toHaveLength(1);
  const reply = 'I offer photography sessions in Denver.';
  const clarified = `${unclear}\n\n${reply}`;
  await page.getByLabel('Your reply', { exact: true }).fill(reply);
  expect(requests.previews).toHaveLength(1);
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Your assistant preview', exact: true }),
  ).toBeVisible();
  expect(requests.previews).toHaveLength(2);
  expect(requests.previews[0].content).toBe(unclear);
  expect(requests.previews[1].content).toBe(clarified);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?service=/);
  expect(requests.previews).toHaveLength(2);
  expect(requests.registrations).toBe(1);
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.unexpected).toEqual([]);
});

test('explicit guest-preview approval wins over a quote parameter without losing the exact saved intake', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(page).toHaveURL(/signup\?from=preview/);
  await page.goto(`${page.url()}&quote=c1600000-0000-4000-8000-000000000004`);
  await expect(
    page.getByRole('heading', { name: 'Save your assistant.', exact: true }),
  ).toBeVisible();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(
    page.getByRole('button', { name: 'Price a practice job', exact: true }),
  ).toBeVisible();
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.previews).toHaveLength(1);
  expect(requests.registrations).toBe(1);
  expect(requests.unexpected).toEqual([]);
});

test('a service-only receipt saves to Teach without turning its generic scope into a customer test', async ({
  page,
}) => {
  const { requests } = await harness(page, 'service-only');
  await page.goto('/');
  await page
    .getByLabel('Start with your work.', { exact: true })
    .fill(
      'I offer photography sessions in Denver. I ask what kind of photographs the customer wants and where.',
    );
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your assistant preview' })).toBeVisible();
  await expect(page.getByText('Your past job', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  const project = page.getByLabel('Customer’s project', { exact: true });
  const start = page.getByRole('button', { name: 'Try this request', exact: true });
  await expect(project).toHaveValue('');
  await expect(start).toBeDisabled();
  await page.reload();
  await expect(project).toHaveValue('');
  await expect(start).toBeDisabled();
  // A saved draft matching the old generic seed still belongs to the owner.
  await project.fill('Photography services.');
  await expect(start).toBeEnabled();
  await page.reload();
  await expect(project).toHaveValue('Photography services.');
  await expect(start).toBeEnabled();
  await project.clear();
  await expect(start).toBeDisabled();
  await page.reload();
  await expect(project).toHaveValue('');
  await expect(start).toBeDisabled();
  expect(requests.previews).toHaveLength(1);
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.unexpected).toEqual([]);
});

test('a known past-job receipt with no readable local draft keeps the conservative Teach destination', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await previewJob(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(page).toHaveURL(/signup\?from=preview/);
  await page.evaluate(() => sessionStorage.removeItem('quotient:guest-preview:draft'));
  await fillAccount(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  expect(requests.previews).toHaveLength(1);
  expect(requests.claims).toEqual([{ expectedVersion: 1, approveIntake: true }]);
  expect(requests.unexpected).toEqual([]);
});
