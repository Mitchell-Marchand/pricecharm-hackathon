import { expect, test, type Page } from '@playwright/test';
import type { PublicSession, Quote } from '../../src/lib/types';

const first = '10000000-0000-4000-8000-000000000021';
const second = '10000000-0000-4000-8000-000000000022';
const firstSession = '20000000-0000-4000-8000-000000000021';
const secondSession = '20000000-0000-4000-8000-000000000022';
const slug = 'fictional-continuity-cleaning';
const token = 'p'.repeat(43);
const key = (id: string, version = 1) => `quotient:playground:${slug}:${id}@${version}`;

async function harness(
  page: Page,
  resultMode?: 'intake' | 'calculation' | 'inspection',
  projectEvidence = false,
) {
  let version = 1;
  let failRestore = false;
  let blockedSend: (() => void) | undefined;
  let blockedRefresh: (() => void) | undefined;
  let blockedQuote: (() => void) | undefined;
  let blockQuote = false;
  let failQuote = false;
  let delayRefresh = false;
  const submitted: Record<string, unknown>[] = [];
  const posts: string[] = [];
  const unexpected: string[] = [];
  const business = {
    id: '30000000-0000-4000-8000-000000000021',
    name: resultMode === 'intake' ? 'Fictional Portrait Studio' : 'Fictional Continuity Cleaning',
    slug,
    industry: resultMode === 'intake' ? 'Photography' : 'Cleaning',
    description:
      resultMode === 'intake' ? 'Family portraits.' : 'Residential windows and driveways.',
    serviceArea: resultMode === 'intake' ? 'Denver' : 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: '2026-10-28T12:00:00.000Z',
  };
  function services() {
    return [first, second].map((id, index) => ({
      id,
      businessId: business.id,
      name: index
        ? 'Driveway cleaning'
        : resultMode === 'intake'
          ? 'Portrait photography'
          : 'Window cleaning',
      description: index
        ? 'Concrete driveways.'
        : resultMode === 'intake'
          ? 'Family portrait sessions.'
          : 'Residential windows.',
      unitLabel: index ? 'square foot' : resultMode === 'intake' ? 'hour' : 'window',
      unitPriceCents: index ? 25 : resultMode === 'intake' ? 0 : 900,
      basePriceCents: 0,
      minimumChargeCents: 0,
      maxAutoQuoteCents: 0,
      requiredInputs: ['access'],
      exclusions: [],
      pricingRules: [],
      mode: 'review' as const,
      pricingQuantityRequired: resultMode !== 'intake',
      publishedAt: null,
      version: index ? 1 : version,
    }));
  }
  const sessions = new Map<string, PublicSession>([
    [
      firstSession,
      {
        id: firstSession,
        serviceId: first,
        serviceVersion: 1,
        source: 'playground',
        quoteMode: 'review',
        status: 'active',
        requiredInputs: ['access', 'location'],
        collectedInputs: {},
        messages: [
          {
            id: 'first-greeting',
            role: 'assistant',
            content: 'Describe the window project.',
            createdAt: business.createdAt,
          },
        ],
      },
    ],
    [
      secondSession,
      {
        id: secondSession,
        serviceId: second,
        serviceVersion: 1,
        source: 'playground',
        quoteMode: 'review',
        status: 'active',
        requiredInputs: ['access', 'location'],
        collectedInputs: {},
        messages: [
          {
            id: 'second-greeting',
            role: 'assistant',
            content: 'Describe the driveway project.',
            createdAt: business.createdAt,
          },
        ],
      },
    ],
  ]);
  const resultSession = sessions.get(firstSession)!;
  const description =
    resultMode === 'intake'
      ? 'I would like two hours of portraits at home in Denver, with twelve edited photos.'
      : 'I would like four windows cleaned in Austin.';
  if (resultMode) {
    if (resultMode === 'intake')
      resultSession.messages[0].content = 'Tell us about the portrait session.';
    resultSession.pricingQuantityRequired = resultMode !== 'intake';
    resultSession.requiredInputs =
      resultMode === 'intake'
        ? [
            'Coverage wanted (hours)',
            'Number of subjects',
            'Shoot location',
            'location',
            'Edited photos wanted',
            'Prints wanted',
            'Retouching requested',
            'Shoot date',
          ]
        : ['access', 'location'];
    resultSession.collectedInputs =
      resultMode === 'intake'
        ? {
            'Coverage wanted (hours)': '2 hours',
            'Number of subjects': '2',
            'Shoot location': 'Denver',
            location: 'Denver',
            'Edited photos wanted': '12',
            'Prints wanted': '0',
            'Retouching requested': 'false',
            'Shoot date': 'not sure',
          }
        : {
            access: resultMode === 'inspection' ? 'The upstairs glass is cracked.' : 'Ground floor',
            location: 'Austin',
          };
    // A stale missing list must not override actual customer-confirmed values.
    resultSession.missingInputs =
      resultMode === 'intake' ? ['Number of subjects', 'Shoot date'] : [];
    resultSession.messages.push({
      id: 'project-note',
      role: 'user',
      content: description,
      createdAt: business.createdAt,
    });
  }
  function makeQuote(payload?: Record<string, unknown>): Quote {
    return {
      id: '40000000-0000-4000-8000-000000000021',
      serviceId: first,
      customerName: 'Private test customer',
      customerEmail: 'preview@example.test',
      status: 'review',
      description: String(payload?.description || description),
      quantity: Number(payload?.quantity || 1),
      totalCents: resultMode === 'calculation' ? 3600 : 0,
      currency: 'USD',
      manualPriceRequired: resultMode !== 'calculation',
      assumptions: [
        'Private owner test. No customer notification or delivery fee.',
        'Owner approval is required before this price is issued.',
      ],
      lineItems:
        resultMode === 'calculation'
          ? [{ description: '4 windows', quantity: 4, unitPriceCents: 900, totalCents: 3600 }]
          : [],
      createdAt: business.createdAt,
      reviewReason:
        resultMode === 'inspection'
          ? 'The cracked glass needs owner review before pricing.'
          : 'The business owner will review this request.',
    };
  }
  if (resultMode && resultMode !== 'intake') {
    resultSession.quote = makeQuote();
    resultSession.status = 'submitted';
    resultSession.humanHandoff = true;
  }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path === '/api/v1/auth/me')
        return route.fulfill({
          json: {
            data: {
              business,
              user: {
                id: 'fictional-owner',
                name: 'Fictional Owner',
                email: 'continuity@example.test',
                emailVerified: true,
              },
            },
          },
        });
      if (path === '/api/v1/dashboard')
        return route.fulfill({
          json: {
            data: {
              business,
              services: services(),
              examples: projectEvidence
                ? [
                    {
                      id: 'fictional-window-job',
                      businessId: business.id,
                      serviceId: first,
                      title: 'Four ground-floor windows',
                      description: 'Four ground-floor windows with straightforward access.',
                      quantity: 4,
                      unitLabel: 'window',
                      finalPriceCents: 3600,
                      rationale: 'USD 9 per accessible window.',
                      source: 'historical',
                      createdAt: '2026-10-28T13:00:00.000Z',
                    },
                  ]
                : [],
              jobNotes: projectEvidence
                ? [
                    ...[first, second].map((serviceId) => ({
                      id: `general-${serviceId}`,
                      serviceId,
                      source: 'setup',
                      kind: 'service_notes',
                      title: 'General service notes',
                      description: 'I quote cleaning jobs individually after checking access.',
                      quantity: null,
                      unitLabel: null,
                      finalPriceCents: null,
                      rationale: '',
                      sourceNotes: 'I quote cleaning jobs individually after checking access.',
                      createdAt: '2026-10-28T14:00:00.000Z',
                    })),
                    {
                      id: 'fictional-driveway-inspection',
                      serviceId: second,
                      source: 'training',
                      kind: 'inspection_required',
                      title: 'Inspection before cleaning a stained driveway',
                      description: 'A concrete driveway has deep stains near the garage.',
                      quantity: null,
                      unitLabel: null,
                      finalPriceCents: null,
                      rationale: 'I need to inspect the stains before quoting.',
                      sourceNotes: 'I need to inspect the stains before quoting.',
                      createdAt: '2026-10-28T13:30:00.000Z',
                    },
                  ]
                : [],
              trainingSessions: [],
              recentQuotes: [],
              stats: {
                totalQuotes: 0,
                issuedQuotes: 0,
                reviewQuotes: 0,
                trainingCompleted: 0,
                examplesCount: projectEvidence ? 1 : 0,
                quotedValueCents: 0,
              },
              usage: { billableQuotes: 0, aiCalls: 0 },
            },
          },
        });
      if (path === '/api/v1/settings')
        return route.fulfill({
          json: {
            data: {
              aiMode: 'demo',
              providers: { openai: false, anthropic: false },
              billingConfigured: false,
            },
          },
        });
      if (/\/services\/[^/]+\/proposals$/.test(path))
        return route.fulfill({
          json: { data: { proposals: [], teaching: { revision: 0, notes: [] } } },
        });
      if (path.endsWith('/uploads')) return route.fulfill({ json: { data: [] } });
      const sessionId = path.split('/').at(-1)!;
      if (sessions.has(sessionId)) {
        if (delayRefresh) {
          delayRefresh = false;
          await new Promise<void>((resolve) => {
            blockedRefresh = resolve;
          });
        }
        if (failRestore) {
          failRestore = false;
          return route.fulfill({
            status: 503,
            json: { error: { code: 'TEMPORARY', message: 'Please try again.' } },
          });
        }
        return route.fulfill({ json: { data: sessions.get(sessionId) } });
      }
    }
    if (request.method() === 'POST' && path.endsWith('/quote') && resultMode) {
      posts.push(path);
      if (failQuote) {
        failQuote = false;
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'TEMPORARY',
              message: 'The test could not be prepared. Please try again.',
            },
          },
        });
      }
      if (blockQuote) {
        blockQuote = false;
        await new Promise<void>((resolve) => {
          blockedQuote = resolve;
        });
      }
      const payload = request.postDataJSON();
      submitted.push(payload);
      resultSession.collectedInputs = { ...resultSession.collectedInputs, ...payload.inputs };
      resultSession.quote = makeQuote(payload);
      resultSession.status = 'submitted';
      resultSession.humanHandoff = true;
      delayRefresh = true;
      return route.fulfill({ json: { data: resultSession.quote } });
    }
    if (request.method() === 'POST' && path.endsWith('/uploads') && resultMode) {
      posts.push(path);
      return route.fulfill({
        status: 503,
        json: {
          error: { code: 'TEMPORARY', message: 'The photo could not be added. Please try again.' },
        },
      });
    }
    if (request.method() === 'POST' && path === '/api/v1/playground/sessions') {
      posts.push(path);
      const serviceId = request.postDataJSON().serviceId;
      const sessionId = serviceId === first ? firstSession : secondSession;
      const result = sessions.get(sessionId)!;
      if (serviceId === first) result.serviceVersion = version;
      return route.fulfill({ json: { data: { token, session: result } } });
    }
    if (request.method() === 'POST' && path.endsWith('/messages')) {
      posts.push(path);
      const content = request.postDataJSON().content;
      await new Promise<void>((resolve) => {
        blockedSend = resolve;
      });
      const result = sessions.get(firstSession)!;
      result.messages.push(
        { id: 'customer-message', role: 'user', content, createdAt: business.createdAt },
        {
          id: 'business-reply',
          role: 'assistant',
          content: 'What access is available?',
          createdAt: business.createdAt,
        },
      );
      return route.fulfill({ json: { data: { session: result } } });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: { code: 'UNEXPECTED_TEST_REQUEST', message: path } },
    });
  });
  return {
    posts,
    unexpected,
    sessions,
    submitted,
    failNextQuote: () => {
      failQuote = true;
    },
    blockNextQuote: () => {
      blockQuote = true;
    },
    quoteStarted: () => Boolean(blockedQuote),
    releaseQuote: () => blockedQuote?.(),
    releaseRefresh: () => blockedRefresh?.(),
    refreshStarted: () => Boolean(blockedRefresh),
    releaseSend: () => blockedSend?.(),
    sendStarted: () => Boolean(blockedSend),
    changeVersion: () => {
      version = 2;
    },
    failNextRestore: () => {
      failRestore = true;
    },
  };
}

test('private tests keep drafts by service and version and preserve newer typing during a send', async ({
  page,
}) => {
  const app = await harness(page, undefined, true);
  await page.goto(`/dashboard?service=${first}&step=teach`);
  await expect(page.locator('.saved-job-recap')).toContainText(
    'I quote cleaning jobs individually after checking access.',
  );
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  const project = page.getByRole('textbox', { name: 'Customer’s project', exact: true });
  await expect(project).toHaveValue('Four ground-floor windows with straightforward access.');
  expect(app.posts).toEqual([]);
  await project.fill('I need four windows cleaned.');
  await page.reload();
  await expect(project).toHaveValue('I need four windows cleaned.');
  expect(app.posts).toEqual([]);
  await page.getByRole('button', { name: 'Try this request', exact: true }).click();
  await expect.poll(app.sendStarted).toBe(true);
  const input = page.getByRole('textbox', { name: 'Tell us about your project', exact: true });
  await input.fill('And one upstairs window is hard to reach.');
  app.releaseSend();
  await expect(page.getByText('What access is available?', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('And one upstairs window is hard to reach.');
  await page.reload();
  await expect(input).toHaveValue('And one upstairs window is hard to reach.');
  await page.goto(`/dashboard?service=${second}&step=try`);
  await expect(page.getByRole('button', { name: 'Try this request', exact: true })).toBeVisible();
  await expect(project).toHaveValue('A concrete driveway has deep stains near the garage.');
  await expect(page.getByText('Describe the window project.', { exact: true })).toHaveCount(0);
  await page.goto(`/dashboard?service=${first}&step=try`);
  await expect(input).toHaveValue('And one upstairs window is hard to reach.');
  app.changeVersion();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Try this request', exact: true })).toBeVisible();
  await expect(project).toHaveValue('Four ground-floor windows with straightforward access.');
  expect(app.posts).toHaveLength(2);
  expect(app.unexpected).toEqual([]);
});

test('a temporary restoration failure preserves the saved request and retries without creating a session', async ({
  page,
}) => {
  const app = await harness(page);
  await page.addInitScript(
    ({ storageKey, sessionId, accessToken }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ id: sessionId, token: accessToken, serviceId: 'wrong-legacy-value' }),
      );
      sessionStorage.setItem(
        `${storageKey}:draft:${sessionId}`,
        JSON.stringify({ content: 'An unfinished project note.', requesting: false }),
      );
    },
    { storageKey: key(first), sessionId: firstSession, accessToken: token },
  );
  app.failNextRestore();
  await page.goto(`/dashboard?service=${first}&step=try`);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(
    await page.evaluate((storageKey) => localStorage.getItem(storageKey), key(first)),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Tell us about your project', exact: true }),
  ).toHaveValue('An unfinished project note.');
  expect(app.posts).toEqual([]);
  expect(app.unexpected).toEqual([]);
});

async function restorePrivateRequest(page: Page) {
  await page.addInitScript(
    ({ storageKey, sessionId, accessToken }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          id: sessionId,
          token: accessToken,
          serviceId: '10000000-0000-4000-8000-000000000021',
        }),
      );
    },
    { storageKey: key(first), sessionId: firstSession, accessToken: token },
  );
  await page.goto(`/dashboard?service=${first}&step=try`);
}

test('an unpriced private request shows confirmed facts immediately and restores the receipt without another submission', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await harness(page, 'intake');
  await restorePrivateRequest(page);
  await expect(page.getByRole('button', { name: 'See request summary', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  const form = page.locator('.public-request-form');
  const summary = form.getByRole('region', { name: 'Your project summary' });
  // Identical explicit location answers collapse only in the summary.
  await expect(summary.locator('dt').filter({ hasText: /^City or area$/ })).toHaveCount(0);
  await expect(summary.locator('dd').filter({ hasText: /^No$/ })).toHaveCount(1);
  await expect(summary.locator('dd').filter({ hasText: /^0$/ })).toHaveCount(1);
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Shoot location', exact: true })).toHaveValue(
    'Denver',
  );
  await expect(form.getByRole('textbox', { name: 'City or area', exact: true })).toHaveValue(
    'Denver',
  );
  await expect(
    form.getByRole('textbox', { name: 'Retouching requested', exact: true }),
  ).toHaveValue('false');
  await form
    .getByRole('textbox', { name: 'Shoot location', exact: true })
    .fill('At home in Denver');
  await expect(summary.locator('dt').filter({ hasText: /^City or area$/ })).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: 'City or area', exact: true })).toHaveValue(
    'Denver',
  );
  await expect(form.getByLabel(/^Approximate quantity/)).toHaveCount(0);
  await form.getByRole('button', { name: 'Run this customer test', exact: true }).click();
  await expect.poll(app.refreshStarted).toBe(true);

  const receipt = page.getByRole('region', { name: 'What you would receive', exact: true });
  await expect(receipt).toBeVisible();
  // The follow-up GET is deliberately blocked: these must be the accepted form edits,
  // not the earlier chat facts or a placeholder quantity from the quote.
  await expect(receipt.locator('dd').filter({ hasText: /^At home in Denver$/ })).toBeVisible();
  await expect(receipt.locator('dd').filter({ hasText: /^Denver$/ })).toBeVisible();
  await expect(receipt.locator('dd').filter({ hasText: /^2 hours$/ })).toBeVisible();
  await expect(receipt.locator('dd').filter({ hasText: /^0$/ })).toHaveCount(1);
  await expect(receipt.locator('dd').filter({ hasText: /^No$/ })).toHaveCount(1);
  await expect(receipt.locator('dd').filter({ hasText: /^false$/ })).toHaveCount(0);
  await expect(receipt.locator('li')).toHaveText(['Shoot date']);
  await expect(receipt.locator('dd').filter({ hasText: /^unknown|not sure$/ })).toHaveCount(0);
  await expect(
    page.getByText('This request would come to you for review.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await expect(page.getByText('Price assumptions', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept quote', exact: true })).toHaveCount(0);
  expect(app.submitted).toHaveLength(1);
  expect(app.submitted[0]).toMatchObject({
    quantity: 1,
    quantityUnknown: true,
    inputs: {
      'Coverage wanted (hours)': '2 hours',
      'Shoot location': 'At home in Denver',
      location: 'Denver',
      'Shoot date': 'unknown',
      'Retouching requested': 'false',
      'Prints wanted': '0',
    },
  });

  app.releaseRefresh();
  await page.reload();
  await expect(receipt.locator('dd').filter({ hasText: /^At home in Denver$/ })).toBeVisible();
  const original = receipt.locator('details');
  await expect(original.locator('p')).toBeHidden();
  await original.getByText('Customer’s words', { exact: true }).click();
  await expect(original.locator('p')).toHaveText(
    'I would like two hours of portraits at home in Denver, with twelve edited photos.',
  );
  await original.getByText('Customer’s words', { exact: true }).click();
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    await expect(receipt).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.public-quote-anchor').evaluate((element) => {
          const body = element.closest('.public-chat-body')!.getBoundingClientRect();
          const heading = element.querySelector('h3')!.getBoundingClientRect();
          const firstFact = element.querySelector('dd')!.getBoundingClientRect();
          return (
            heading.top >= Math.max(0, body.top) - 2 &&
            (heading.top <= 120 ||
              scrollY + innerHeight >= document.documentElement.scrollHeight - 2) &&
            firstFact.bottom <= Math.min(innerHeight, body.bottom) + 2
          );
        }),
      )
      .toBe(true);
    expect(
      await receipt.evaluate((element) =>
        ['visible', 'clip'].includes(getComputedStyle(element).overflowY),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await receipt.evaluate((element) => {
        const body = element.closest('.public-chat-body')!;
        return (
          body.scrollHeight <= body.clientHeight + 2 &&
          element.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 2
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`private-intake-receipt-${width}.png`),
      animations: 'disabled',
    });
    const share = page.getByRole('button', { name: 'Get my quote link', exact: true });
    await share.scrollIntoViewIfNeeded();
    expect(
      await share.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`private-intake-receipt-${width}-end.png`),
      animations: 'disabled',
    });
  }
  expect(app.posts).toHaveLength(1);
  expect(app.unexpected).toEqual([]);
});

test('configured private calculations retain their amount while inspection handoffs retain review without a price', async ({
  page,
}) => {
  for (const mode of ['calculation', 'inspection'] as const) {
    await test.step(mode, async () => {
      const resultPage = await page.context().newPage();
      try {
        const app = await harness(resultPage, mode);
        await restorePrivateRequest(resultPage);
        const receipt = resultPage.getByRole('region', {
          name: 'What you would receive',
          exact: true,
        });
        await expect(receipt).toContainText('Austin');
        if (mode === 'calculation') {
          await expect(resultPage.locator('.public-final-price')).toHaveText('$36');
          await expect(
            resultPage.getByText('Calculated from your saved prices.', { exact: true }),
          ).toBeVisible();
          await expect(resultPage.getByText('Price assumptions', { exact: true })).toBeVisible();
        } else {
          await expect(resultPage.locator('.public-final-price')).toHaveCount(0);
          await expect(
            resultPage.getByText(
              'This request needs your price or more project details. No price has been issued.',
              { exact: true },
            ),
          ).toBeVisible();
          await expect(receipt).toContainText('The upstairs glass is cracked.');
          await expect(resultPage.getByText('Price assumptions', { exact: true })).toHaveCount(0);
          await resultPage.getByText('What would need your review', { exact: true }).click();
          await expect(
            resultPage.getByText('The cracked glass needs owner review before pricing.', {
              exact: true,
            }),
          ).toBeVisible();
        }
        await expect(
          resultPage.getByRole('button', { name: 'Accept quote', exact: true }),
        ).toHaveCount(0);
        expect(app.posts).toEqual([]);
        expect(app.unexpected).toEqual([]);
      } finally {
        await resultPage.close();
      }
    });
  }
});

function completeIntake(app: Awaited<ReturnType<typeof harness>>) {
  const session = app.sessions.get(firstSession)!;
  session.collectedInputs = {
    ...session.collectedInputs,
    'Shoot date': 'November 12',
    'Retouching requested': 'true',
  };
}

test('complete unpriced private tests go directly to a durable summary with one in-flight submission and a safe retry', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await harness(page, 'intake');
  completeIntake(app);
  await restorePrivateRequest(page);
  const action = page.getByRole('button', { name: 'See request summary', exact: true });
  await expect(action).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit project details', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.public-request-form')).toHaveCount(0);
  expect(app.posts).toEqual([]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await action.scrollIntoViewIfNeeded();
    expect(
      await page
        .getByRole('button', { name: 'Edit project details', exact: true })
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= innerHeight;
        }),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`direct-private-action-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  app.failNextQuote();
  await action.click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The test could not be prepared. Please try again.' }),
  ).toBeVisible();
  await expect(action).toBeEnabled();
  expect(app.submitted).toHaveLength(0);
  app.blockNextQuote();
  await action.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(app.quoteStarted).toBe(true);
  await expect(action).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Edit project details', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('textbox', { name: 'Tell us about your project', exact: true }),
  ).toBeDisabled();
  expect(app.posts).toHaveLength(2);
  app.releaseQuote();
  const receipt = page.getByRole('region', { name: 'What you would receive', exact: true });
  await expect(receipt.locator('dd').filter({ hasText: /^Yes$/ })).toHaveCount(1);
  await expect(receipt.locator('dd').filter({ hasText: /^0$/ })).toHaveCount(1);
  await expect(receipt.getByText('Still to confirm', { exact: true })).toHaveCount(0);
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Run this customer test', exact: true }),
  ).toHaveCount(0);
  expect(app.submitted).toHaveLength(1);
  expect(app.submitted[0]).toMatchObject({
    customerName: 'Private test customer',
    customerEmail: 'preview@example.test',
    contactConsent: true,
    quantity: 1,
    quantityUnknown: true,
    inputs: {
      'Retouching requested': 'true',
      'Prints wanted': '0',
      'Coverage wanted (hours)': '2 hours',
      'Shoot date': 'November 12',
    },
  });
  await expect.poll(app.refreshStarted).toBe(true);
  // A saved result remains authoritative even if its follow-up GET is unavailable.
  const failedRefresh = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/sessions/${firstSession}`) &&
      response.status() === 503,
  );
  app.failNextRestore();
  app.releaseRefresh();
  await failedRefresh;
  await expect(receipt.locator('dd').filter({ hasText: /^Yes$/ })).toHaveCount(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    await expect(receipt).toBeVisible();
    await expect(receipt.locator('dd').filter({ hasText: /^Yes$/ })).toHaveCount(1);
    expect(
      await receipt.evaluate((element) => {
        const body = element.closest('.public-chat-body')!;
        return body.scrollHeight <= body.clientHeight + 2;
      }),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`direct-private-summary-${width}.png`),
      animations: 'disabled',
    });
  }
  expect(app.posts).toHaveLength(2);
  expect(app.unexpected).toEqual([]);
});

test('private shortcuts preserve edited or unsent details and failed photos, while configured and automatic tests retain confirmation', async ({
  page,
}) => {
  for (const reason of ['edited', 'unsent', 'photo', 'configured', 'automatic'] as const) {
    await test.step(reason, async () => {
      const requestPage = await page.context().newPage();
      try {
        const app = await harness(
          requestPage,
          reason === 'configured' || reason === 'automatic' ? 'calculation' : 'intake',
        );
        const session = app.sessions.get(firstSession)!;
        if (reason === 'configured' || reason === 'automatic') {
          session.quote = undefined;
          session.status = 'active';
          session.humanHandoff = false;
          if (reason === 'automatic') {
            session.quoteMode = 'automatic';
            session.pricingQuantityRequired = false;
          }
        } else completeIntake(app);
        await restorePrivateRequest(requestPage);
        const shortcut = requestPage.getByRole('button', {
          name: 'See request summary',
          exact: true,
        });
        const getQuote = requestPage.getByRole('button', { name: 'Get a quote', exact: true });
        const form = requestPage.locator('.public-request-form');
        if (reason === 'edited') {
          await expect(shortcut).toBeVisible();
          await requestPage
            .getByRole('button', { name: 'Edit project details', exact: true })
            .click();
          await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
          await form.getByRole('textbox', { name: 'Number of subjects', exact: true }).fill('3');
          await form.getByRole('button', { name: 'Back to chat', exact: true }).click();
          await expect(getQuote).toBeVisible();
          await expect(shortcut).toHaveCount(0);
          await requestPage.reload();
          await getQuote.click();
          await expect(
            form
              .getByRole('region', { name: 'Your project summary' })
              .locator('dd')
              .filter({ hasText: /^3$/ }),
          ).toHaveCount(1);
        } else if (reason === 'unsent') {
          await expect(shortcut).toBeVisible();
          await requestPage
            .getByRole('textbox', { name: 'Tell us about your project', exact: true })
            .fill('Please include the whole family.');
          await expect(shortcut).toHaveCount(0);
          await getQuote.click();
          await expect(form.getByRole('region', { name: 'Your project summary' })).toContainText(
            'Please include the whole family.',
          );
        } else if (reason === 'photo') {
          await expect(shortcut).toBeVisible();
          await requestPage
            .locator('input[type="file"]')
            .setInputFiles('tests/e2e/fixtures/project-photo.png');
          await expect(
            requestPage.getByRole('button', { name: 'Try photo again', exact: true }),
          ).toBeVisible();
          await expect(shortcut).toHaveCount(0);
          await expect(getQuote).toBeEnabled();
        } else {
          await expect(getQuote).toBeVisible();
          await expect(shortcut).toHaveCount(0);
          await getQuote.click();
          const quantity = form.getByLabel(/^Approximate quantity/);
          await expect(quantity).toHaveValue('');
          await quantity.fill('4');
          await expect(quantity).toHaveValue('4');
          await expect(
            form.getByRole('button', { name: 'Run this customer test', exact: true }),
          ).toBeVisible();
        }
        expect(app.submitted).toHaveLength(0);
        expect(app.posts).toHaveLength(reason === 'photo' ? 1 : 0);
        expect(app.unexpected).toEqual([]);
      } finally {
        await requestPage.close();
      }
    });
  }
});
