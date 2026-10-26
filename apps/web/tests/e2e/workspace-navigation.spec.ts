import { expect, test, type Page } from '@playwright/test';

const first = '10000000-0000-4000-8000-000000000081';
const second = '10000000-0000-4000-8000-000000000082';
const practice = '20000000-0000-4000-8000-000000000081';
const olderPractice = '20000000-0000-4000-8000-000000000083';
const setupId = '40000000-0000-4000-8000-000000000081';
const createdService = '10000000-0000-4000-8000-000000000084';

async function harness(page: Page, readySetup = false) {
  const business = {
    id: '30000000-0000-4000-8000-000000000081',
    name: 'Fictional Navigation Services',
    slug: 'fictional-navigation-services',
    description: 'Catering and inspection examples.',
    industry: 'Services',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: '2026-10-28T12:00:00.000Z',
  };
  let services = [first, second].map((id, index) => ({
    id,
    businessId: business.id,
    name: index ? 'Handyman inspection' : 'Event catering',
    description: 'Fictional service scope.',
    unitLabel: index ? 'project' : 'guest',
    unitPriceCents: index ? 0 : 4000,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['Project scope'],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    publishedAt: null,
    version: 1,
  }));
  const training = {
    id: practice,
    serviceId: first,
    unitLabel: 'guest',
    status: 'active',
    scenario: {
      title: 'Fictional buffet',
      customerName: 'Fictional Pat',
      description: 'Buffet for sixty guests.',
      details: { quantity: '60' },
    },
    messages: [
      {
        id: 'fictional-message',
        role: 'assistant',
        content: 'Can you cater a buffet for sixty guests?',
        createdAt: business.createdAt,
      },
    ],
    createdAt: business.createdAt,
  };
  const historical = {
    title: 'Fictional flower setup',
    description: 'One event flower setup',
    quantity: 1,
    finalPriceCents: 10000,
    rationale: 'The flowers and preparation.',
  };
  const savedService = {
    ...services[0],
    id: createdService,
    name: 'Event flowers',
    unitLabel: 'project',
    unitPriceCents: 0,
  };
  const savedExample = {
    ...historical,
    id: 'fictional-example',
    businessId: business.id,
    serviceId: createdService,
    source: 'historical',
    createdAt: business.createdAt,
  };
  const examples: unknown[] = [];
  const setup = {
    id: setupId,
    status: 'active',
    version: 1,
    messages: [
      {
        id: 'setup-greeting',
        role: 'assistant',
        content: 'Tell me about a past job.',
        createdAt: business.createdAt,
      },
    ],
    draft: readySetup
      ? {
          name: 'Event flowers',
          description: 'Flowers for private events',
          unitLabel: 'project',
          example: historical,
        }
      : { name: null, description: '', unitLabel: null, example: null },
    readyToConfirm: readySetup,
    serviceId: null,
  };
  const posts: string[] = [],
    unexpected: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/v1/service-setup') {
      posts.push(path);
      return route.fulfill({ json: { data: setup } });
    }
    if (
      readySetup &&
      request.method() === 'POST' &&
      path === `/api/v1/service-setup/${setupId}/confirm`
    ) {
      posts.push(path);
      services = [savedService, ...services];
      examples.push(savedExample);
      return route.fulfill({
        json: {
          data: {
            session: { ...setup, status: 'confirmed', version: 2, serviceId: createdService },
            service: savedService,
            example: savedExample,
          },
        },
      });
    }
    if (
      readySetup &&
      request.method() === 'POST' &&
      path === `/api/v1/services/${createdService}/learn`
    ) {
      posts.push(path);
      return route.fulfill({
        json: {
          data: {
            teaching: { revision: 0, notes: [] },
            proposal: {
              id: 'fictional-created-proposal',
              status: 'pending',
              serviceVersion: 1,
              teachingRevision: 0,
              parentProposalId: null,
              sourceExampleIds: [savedExample.id],
              proposal: {
                unitPriceCents: 0,
                minimumChargeCents: 0,
                basePriceCents: 0,
                requiredInputs: ['Flower preferences'],
                exclusions: [],
                pricingRules: [],
                explanation: 'Your past job is evidence for review.',
                uncertainties: [],
              },
            },
          },
        },
      });
    }
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: 'No AI or mutations are allowed in navigation tests.' } },
      });
    }
    let data: unknown;
    if (path === '/api/v1/auth/me')
      data = {
        business,
        user: {
          id: 'fictional-owner',
          name: 'Fictional Owner',
          email: 'navigation@example.test',
          emailVerified: true,
        },
      };
    else if (path === '/api/v1/dashboard')
      data = {
        business,
        services,
        examples,
        trainingSessions: [training],
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
    else if (path === '/api/v1/settings')
      data = {
        aiMode: 'demo',
        providers: { openai: false, anthropic: false },
        billingConfigured: false,
      };
    else if (path.endsWith('/proposals')) {
      const serviceId = path.split('/')[4];
      data = {
        teaching: { revision: 0, notes: [] },
        proposals: [
          {
            id: `proposal-${serviceId}`,
            serviceVersion: 1,
            teachingRevision: 0,
            parentProposalId: null,
            status: 'pending',
            sourceExampleIds: [],
            proposal: {
              unitPriceCents: 0,
              minimumChargeCents: 0,
              basePriceCents: 0,
              requiredInputs: ['Project scope'],
              exclusions: [],
              pricingRules: [],
              explanation: 'Fictional questions for review.',
              uncertainties: [],
            },
          },
        ],
      };
    } else if (path.endsWith('/readiness')) {
      const selected = services.find((item) => item.id === path.split('/')[4]);
      data = {
        serviceId: selected?.id,
        serviceVersion: selected?.version,
        evaluation: null,
        evaluationCurrent: false,
        invalidation: 'not_evaluated',
        approvalCurrent: false,
        published: !!selected?.publishedAt,
        autoQuoteEnabled: false,
      };
    } else if (path.endsWith('/test-cases')) data = [];
    else if (path === '/api/v1/billing')
      data = {
        provider: 'local',
        access: { canIssue: true },
        account: null,
        usage: {},
        tariff: {},
      };
    else if (
      path === `/api/v1/training/${practice}` ||
      path === `/api/v1/training/${olderPractice}`
    )
      data = { ...training, id: path.split('/').at(-1) };
    else if (path === `/api/v1/service-setup/${setupId}`) data = setup;
    else if (path.endsWith('/uploads')) data = [];
    else {
      unexpected.push(`GET ${path}`);
      return route.fulfill({ status: 500, json: { error: { message: path } } });
    }
    return route.fulfill({ json: { data } });
  });
  return {
    posts,
    unexpected,
    removeSecond: () => {
      services = services.filter((service) => service.id !== second);
    },
  };
}

async function state(page: Page, id: string, step: string) {
  await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe(id);
  await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe(step.toLowerCase());
  await expect(page.locator('.journey-tabs button[aria-current="step"]')).toHaveText(step);
  await expect(page.locator('.service-menu summary')).toContainText(
    id === first ? 'Event catering' : 'Handyman inspection',
  );
}

test('Back and Forward restore steps, selected services and private unsent drafts without AI', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(`/dashboard?service=${first}&step=teach`);
  const notes = page.getByLabel('Anything to add or change?', { exact: true });
  await expect(
    page.getByRole('article', { name: 'Suggested pricing and questions' }),
  ).toBeVisible();
  await expect(notes).toBeHidden();
  await page.getByText('Add or change a detail', { exact: true }).click();
  await notes.fill('Ask me about allergy requests.');
  await expect(notes).toBeFocused();
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await state(page, first, 'Try');
  const project = page.getByRole('textbox', { name: 'Customer’s project', exact: true });
  await project.fill('A buffet for sixty guests.');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await state(page, first, 'Share');
  await page.locator('.service-menu summary').click();
  await page.getByRole('button', { name: 'Handyman inspection', exact: true }).click();
  await state(page, second, 'Share');
  await page.goBack();
  await state(page, first, 'Share');
  await page.goBack();
  await state(page, first, 'Try');
  await expect(project).toHaveValue('A buffet for sixty guests.');
  await page.goBack();
  await state(page, first, 'Teach');
  await expect(notes).toBeVisible();
  await expect(notes).toHaveValue('Ask me about allergy requests.');
  await page.reload();
  await state(page, first, 'Teach');
  await expect(notes).toBeVisible();
  await expect(notes).toHaveValue('Ask me about allergy requests.');
  await page.goForward();
  await state(page, first, 'Try');
  await page.goForward();
  await state(page, first, 'Share');
  await page.goForward();
  await state(page, second, 'Share');
  expect(app.posts).toEqual([]);
  expect(app.unexpected).toEqual([]);
});

test('practice history is navigable and mismatched or deleted service links recover safely', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(`/dashboard?service=${first}&step=teach`);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Fictional buffet In progress' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('practice')).toBe(practice);
  await expect(
    page.getByText('Can you cater a buffet for sixty guests?', { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.has('practice')).toBe(false);
  await page.goForward();
  await expect(
    page.getByText('Can you cater a buffet for sixty guests?', { exact: true }),
  ).toBeVisible();
  await page.goto(`/dashboard?service=${second}&practice=${olderPractice}`);
  await expect(
    page.getByText('That practice belongs to another service. Choose it from that service.', {
      exact: true,
    }),
  ).toBeVisible();
  await state(page, second, 'Teach');
  await expect.poll(() => new URL(page.url()).searchParams.has('practice')).toBe(false);
  await expect(
    page.getByText('Can you cater a buffet for sixty guests?', { exact: true }),
  ).toHaveCount(0);
  await page.goto(`/dashboard?service=${second}&step=share`);
  app.removeSecond();
  await page.reload();
  await state(page, first, 'Share');
  await expect(page.getByText('Loading your assistant…', { exact: true })).toHaveCount(0);
  expect(app.posts).toEqual([]);
  expect(app.unexpected).toEqual([]);
});

test('returning to an unfinished service introduction reads the saved draft without creating or teaching again', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto(`/dashboard?service=${first}&step=teach`);
  await page.locator('.service-menu summary').click();
  await page.getByRole('button', { name: 'Add a service', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('new')).toBe('1');
  await expect(page.getByText('Tell me about a past job.', { exact: true })).toHaveCount(0);
  await expect.poll(() => app.posts.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem('quotient:service-setup:30000000-0000-4000-8000-000000000081'),
      ),
    )
    .toBe(setupId);
  await page.goBack();
  await state(page, first, 'Teach');
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('new')).toBe('1');
  await expect(page.getByRole('textbox', { name: 'Tell us about a job you quoted' })).toBeVisible();
  expect(app.posts).toEqual(['/api/v1/service-setup']);
  expect(app.unexpected).toEqual([]);
});

test('explicit setup confirmation learns once and browser traversal never replays it', async ({
  page,
}) => {
  const app = await harness(page, true);
  await page.goto(`/dashboard?service=${first}&step=teach`);
  await page.locator('.service-menu summary').click();
  await page.getByRole('button', { name: 'Add a service', exact: true }).click();
  await page.getByRole('button', { name: 'Save this job', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe(createdService);
  await expect.poll(() => app.posts.filter((path) => path.endsWith('/learn')).length).toBe(1);
  await expect(
    page.getByRole('listitem').filter({ hasText: /^flower preferences$/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('try');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('teach');
  await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe(createdService);
  await page.goBack();
  await state(page, first, 'Teach');
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe(createdService);
  expect(app.posts.filter((path) => path.endsWith('/learn'))).toHaveLength(1);
  expect(app.posts.some((path) => path === '/api/v1/training')).toBe(false);
  expect(app.unexpected).toEqual([]);
});
