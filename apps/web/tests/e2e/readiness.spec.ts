import { expect, test, type Page } from '@playwright/test';
import type { Evaluation, ServiceReadiness } from '../../src/lib/types';

const id = '91000000-0000-4000-8000-000000000001';
const otherId = '91000000-0000-4000-8000-000000000002';
const at = '2026-10-28T12:00:00.000Z';
type Mode =
  | 'current'
  | 'policy_changed'
  | 'model_changed'
  | 'engine_changed'
  | 'error'
  | 'switch'
  | 'evaluate-lost'
  | 'evaluate-read-error'
  | 'evaluate-no-result';

async function harness(page: Page, mode: Mode = 'current') {
  const business = {
    id: 'fictional-readiness-business',
    name: 'Fictional Readiness Cleaning',
    slug: 'fictional-readiness-cleaning',
    industry: 'Cleaning',
    description: 'Window cleaning.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id,
    businessId: business.id,
    name: 'Window cleaning',
    description: 'Residential window cleaning.',
    unitLabel: 'window',
    unitPriceCents: 900,
    basePriceCents: 0,
    minimumChargeCents: 12000,
    maxAutoQuoteCents: 50000,
    requiredInputs: ['surface'],
    exclusions: ['restoration'],
    pricingRules: [],
    mode: 'review',
    publishedAt: at as string | null,
    version: 7,
    approvedVersion: null as number | null,
  };
  const second = { ...service, id: otherId, name: 'Door cleaning' };
  if (mode === 'model_changed' || mode === 'engine_changed') {
    service.mode = 'automatic';
    service.approvedVersion = service.version;
    business.autoQuoteEnabled = true;
  }
  let approvalGranted = false;
  const examples = [15, 20, 30].map((quantity, index) => ({
    id: `fictional-example-${index}`,
    businessId: business.id,
    serviceId: id,
    title: `Past windows ${quantity}`,
    description: 'One teaching job.',
    quantity,
    unitLabel: 'window',
    finalPriceCents: quantity * 900,
    rationale: 'The saved rate.',
    source: 'historical',
    createdAt: at,
  }));
  let cases = [15, 20, 30, 40].map((quantity, index) => ({
    id: `fictional-case-${index}`,
    title: `Blind job ${index + 1}`,
    description: 'A distinct customer request.',
    quantity,
    expectedCents: index === 3 ? 0 : quantity * 900,
    expectedOutcome: index === 3 ? 'review' : 'quote',
    inputs: { location: 'Austin', surface: index === 3 ? 'restoration' : 'glass' },
  }));
  const result = (version = service.version, passed = true): Evaluation => ({
    passed,
    configurationPassed: passed,
    automaticReady: passed,
    serviceVersion: version,
    independentCaseCount: 4,
    coverage: ['quote', 'review'],
    checks: [
      {
        name: 'Independent prices and handoff',
        passed,
        detail: passed
          ? 'The saved independent cases passed.'
          : 'One independent price needs attention.',
      },
    ],
    cases: cases.map((item) => ({
      title: item.title,
      expectedCents: item.expectedCents,
      actualCents: item.expectedCents,
      passed,
      provenance: 'independent',
      expectedOutcome: item.expectedOutcome as 'quote' | 'review',
      actualOutcome: item.expectedOutcome as 'quote' | 'review',
    })),
    evaluatedAt: at,
  });
  let evaluation = result(mode === 'policy_changed' || mode.startsWith('evaluate-') ? 6 : 7);
  let invalidation: ServiceReadiness['invalidation'] = [
    'policy_changed',
    'model_changed',
    'engine_changed',
  ].includes(mode)
    ? (mode as ServiceReadiness['invalidation'])
    : mode.startsWith('evaluate-')
      ? 'policy_changed'
      : null;
  const requests = {
    reads: [] as string[],
    writes: [] as { path: string; method: string; body: unknown }[],
    evaluations: 0,
    readiness: 0,
    unexpected: [] as string[],
  };
  let releaseOld: (() => void) | undefined;
  let oldReadStarted = false;
  const oldRead = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const billing = {
    provider: 'local',
    configured: true,
    status: 'trial',
    canIssue: true,
    trial: { remainingQuotes: 10, quoteLimit: 10, endsAt: '2099-01-01T00:00:00Z' },
    usage: { deliveredQuotes: 0, billableQuotes: 0, feesCents: 0, month: '2026-10' },
    tariff: {
      basisPoints: 100,
      minimumFeeCents: 100,
      maximumFeeCents: 2500,
      currency: 'USD',
      version: 'fixture',
    },
    spendingCapCents: 10000,
    subscription: null,
    checkoutAvailable: false,
    portalAvailable: false,
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown;
    if (request.method() === 'GET') requests.reads.push(path);
    else
      requests.writes.push({
        path,
        method: request.method(),
        body: request.postData() ? request.postDataJSON() : null,
      });
    if (path === '/api/v1/auth/me')
      data = {
        user: {
          id: 'fictional-readiness-owner',
          name: business.name,
          email: 'fictional-readiness@example.test',
          emailVerified: true,
        },
        business,
      };
    else if (path === '/api/v1/settings')
      data = {
        aiMode: 'live',
        providers: { openai: true, anthropic: false },
        billingConfigured: true,
      };
    else if (path === '/api/v1/dashboard')
      data = {
        business,
        services: mode === 'switch' ? [service, second] : [service],
        examples:
          mode === 'switch'
            ? [
                ...examples,
                ...examples.map((item) => ({
                  ...item,
                  id: item.id + '-other',
                  serviceId: otherId,
                })),
              ]
            : examples,
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          trainingCompleted: 0,
          examplesCount: 3,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (path === '/api/v1/billing') data = billing;
    else if (path.endsWith('/proposals'))
      data = { proposals: [], teaching: { revision: 0, notes: [] } };
    else if (path.endsWith('/readiness')) {
      requests.readiness++;
      if (
        (mode === 'error' && requests.readiness === 1) ||
        (mode === 'evaluate-read-error' && requests.readiness === 2)
      )
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'TEMPORARY_FAILURE',
              message: 'Saved checks are temporarily unavailable.',
            },
          },
        });
      if (mode === 'switch' && path.includes(id) && !oldReadStarted) {
        oldReadStarted = true;
        await oldRead;
      }
      const selected = path.includes(otherId) ? second : service;
      data = {
        serviceId: selected.id,
        serviceVersion: selected.version,
        evaluation: selected.id === otherId ? result(7, false) : evaluation,
        evaluationCurrent: selected.id === otherId || invalidation === null,
        invalidation: selected.id === otherId ? null : invalidation,
        approvalCurrent: selected.mode === 'automatic' && invalidation === null && approvalGranted,
        published: !!selected.publishedAt,
        autoQuoteEnabled: business.autoQuoteEnabled,
      };
    } else if (path.endsWith('/test-cases') && request.method() === 'GET') data = cases;
    else if (path === `/api/v1/services/${id}` && request.method() === 'PATCH') {
      const input = request.postDataJSON();
      expect(input.expectedVersion).toBe(service.version);
      if (input.maxAutoQuoteCents !== service.maxAutoQuoteCents) {
        service.maxAutoQuoteCents = input.maxAutoQuoteCents;
        service.version++;
        invalidation = 'policy_changed';
      }
      data = { ...service };
    } else if (path.includes('/test-cases/') && request.method() === 'DELETE') {
      cases = cases.filter((item) => !path.endsWith(item.id));
      service.version++;
      invalidation = 'policy_changed';
      data = { ok: true };
    } else if (path.endsWith('/evaluate') && request.method() === 'POST') {
      requests.evaluations++;
      if (mode === 'evaluate-no-result' && requests.evaluations === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'The check request failed.' } },
        });
      evaluation = result();
      invalidation = null;
      if (mode === 'evaluate-lost' || mode === 'evaluate-read-error') return route.abort('failed');
      data = evaluation;
    } else if (path.endsWith('/publish') && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ mode: 'automatic', approveAutomatic: true });
      service.mode = 'automatic';
      service.approvedVersion = service.version;
      approvalGranted = true;
      data = { ...service };
    } else if (path === '/api/v1/business' && request.method() === 'PATCH') {
      expect(typeof request.postDataJSON().autoQuoteEnabled).toBe('boolean');
      business.autoQuoteEnabled = request.postDataJSON().autoQuoteEnabled;
      data = business;
    } else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: { code: 'UNMOCKED', message: path } } });
    }
    try {
      await route.fulfill({ json: { data } });
    } catch (cause) {
      if (!(mode === 'switch' && path.endsWith('/readiness'))) throw cause;
    }
  });
  return {
    requests,
    service,
    releaseOld: () => releaseOld?.(),
    oldReadStarted: () => oldReadStarted,
  };
}

async function openAutomatic(page: Page) {
  if (new URL(page.url()).pathname === '/dashboard/publish') return;
  const disclosure = page.locator('details.automation-details');
  await disclosure.waitFor({ state: 'attached' });
  if (!(await disclosure.evaluate((element) => element.hasAttribute('open'))))
    await disclosure.locator('summary').first().click();
}

async function openPreparation(page: Page) {
  const preparation = page.locator('details.automation-tools');
  if (!(await preparation.evaluate((element) => element.hasAttribute('open'))))
    await preparation.locator(':scope > summary').click();
}

test('saved current checks survive reload, Share navigation and billing detours without model calls, while approval stays explicit', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.goto(`/dashboard?service=${id}&step=share`);
  await openAutomatic(page);
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('details.automation-tools')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('region', { name: 'Evaluation results' })).toBeVisible();
  await expect(page.locator('.automation-limit-summary')).toContainText('$500');
  await expect(page.getByRole('button', { name: 'Add a blind test case' })).toBeHidden();
  expect(requests.readiness).toBe(1);
  const approval = page.getByLabel(/I reviewed the test results/);
  const activate = page.getByRole('button', { name: 'Activate automatic quotes', exact: true });
  await expect(activate).toBeDisabled();
  await approval.check();
  await expect(activate).toBeEnabled();
  await page.reload();
  await openAutomatic(page);
  await expect(approval).not.toBeChecked();
  await expect(activate).toBeDisabled();
  await page.getByRole('button', { name: 'Teach', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await openAutomatic(page);
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await page.goto('/dashboard/billing');
  await page.goBack();
  await openAutomatic(page);
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  expect(requests.writes).toEqual([]);
  expect(requests.evaluations).toBe(0);
  await approval.check();
  await activate.click();
  await expect(page.getByText('Approved for quotes up to $500.', { exact: true })).toBeVisible();
  await expect(page.getByText('Live · Approved automatic quotes', { exact: true })).toBeVisible();
  expect(requests.evaluations).toBe(0);
  expect(requests.writes.map((item) => item.path)).toEqual([
    `/api/v1/services/${id}/publish`,
    '/api/v1/business',
  ]);
  expect(requests.writes[1].body).toEqual({ autoQuoteEnabled: true });
  await page.getByRole('button', { name: 'Pause automatic quotes', exact: true }).click();
  await expect(
    page.getByText('Live · You approve prices · Automatic quotes paused', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.assistant-privacy')).toHaveText('Requests open');
  expect(requests.evaluations).toBe(0);
  expect(requests.unexpected).toEqual([]);
});

for (const reason of ['policy_changed', 'model_changed', 'engine_changed'] as const) {
  test(`a ${reason} result is visibly stale and cannot approve until an explicit new evaluation`, async ({
    page,
  }) => {
    const { requests } = await harness(page, reason);
    await page.goto(
      reason === 'policy_changed' ? '/dashboard/publish' : `/dashboard?service=${id}&step=share`,
    );
    await openAutomatic(page);
    const stale = page.getByRole('region', { name: 'Previous checks need updating', exact: true });
    await expect(stale).toBeVisible();
    if (reason !== 'policy_changed') {
      await expect(page.locator('.assistant-privacy')).toHaveText('Requests open');
      await expect(
        page.getByText('Live · Automatic quotes need new checks', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Live · Approved automatic quotes', { exact: true })).toHaveCount(
        0,
      );
    }
    await stale.getByText('Previous check results', { exact: true }).click();
    await expect(stale).toContainText('Previous results · checks need updating');
    await expect(
      page.getByRole('button', { name: 'Activate automatic quotes', exact: true }),
    ).toHaveCount(0);
    expect(requests.evaluations).toBe(0);
    expect(requests.writes).toEqual([]);
    await page.getByRole('button', { name: 'Run independent evaluation', exact: true }).click();
    await expect(
      page.getByText('Independent checks support automatic quotes.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel(/I reviewed the test results/)).not.toBeChecked();
    if (reason !== 'policy_changed')
      await expect(
        page.getByText('Live · Automatic quotes await your approval', { exact: true }),
      ).toBeVisible();
    expect(requests.evaluations).toBe(1);
    expect(requests.writes).toHaveLength(1);
    expect(requests.unexpected).toEqual([]);
  });
}

test('cap and blind-case preparation keep the review link available and invalidate only the saved checks', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await page.goto(`/dashboard?service=${id}&step=share`);
  await openAutomatic(page);
  const link = page.getByLabel('Your quote link', { exact: true });
  const original = await link.inputValue();
  await openPreparation(page);
  await page.getByRole('button', { name: 'Add a blind test case', exact: true }).click();
  const title = page.locator('.automation-test-editor input[name="title"]');
  await title.fill('Unfinished patio windows');
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  const maximum = page.getByRole('spinbutton', {
    name: 'Maximum automatic quote ($)',
    exact: true,
  });
  await maximum.fill('650');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(title).toHaveValue('Unfinished patio windows');
  await page.locator('details.automation-tools > summary').click();
  await expect(title).toBeHidden();
  await expect(title).toHaveCount(1);
  await openPreparation(page);
  await expect(title).toHaveValue('Unfinished patio windows');
  await expect(page.getByRole('button', { name: 'Activate automatic quotes' })).toBeHidden();
  expect(requests.writes).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Change limit', exact: true }).click();
  await expect(maximum).toHaveValue('650');
  await expect(
    page.getByText('Your current link keeps accepting requests for your review.', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('spinbutton', { name: 'Maximum automatic quote ($)', exact: true })
    .fill('600');
  await page.getByRole('button', { name: 'Save quote limit', exact: true }).click();
  await expect(link).toHaveValue(original);
  await expect(page.getByText('Live · You approve every price', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Previous checks need updating' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Activate automatic quotes', exact: true }),
  ).toHaveCount(0);
  expect(requests.evaluations).toBe(0);
  await page.getByRole('button', { name: 'Run independent evaluation', exact: true }).click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await openPreparation(page);
  await page.getByRole('button', { name: 'Delete test case Blind job 1', exact: true }).click();
  await expect(link).toHaveValue(original);
  await expect(page.getByText('Live · You approve every price', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run independent evaluation', exact: true }),
  ).toBeDisabled();
  expect(requests.evaluations).toBe(1);
  expect(requests.writes.map((item) => item.method)).toEqual(['PATCH', 'POST', 'DELETE']);
  expect(requests.unexpected).toEqual([]);
});

test('a transient readiness read retries with GET and never reruns paid checks', async ({
  page,
}) => {
  const { requests } = await harness(page, 'error');
  await page.goto('/dashboard/publish');
  await expect(
    page.getByRole('button', { name: 'Run independent evaluation', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Add a blind test case', exact: true }).click();
  const title = page.locator('.automation-test-editor input[name="title"]');
  await title.fill('Unfinished job during saved-check recovery');
  await page.getByRole('button', { name: 'Load saved checks again', exact: true }).click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await expect(title).toBeVisible();
  await expect(title).toHaveValue('Unfinished job during saved-check recovery');
  await expect(page.getByRole('button', { name: 'Activate automatic quotes' })).toBeHidden();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel(/I reviewed the test results/)).not.toBeChecked();
  expect(requests.readiness).toBe(2);
  expect(requests.writes).toEqual([]);
  expect(requests.unexpected).toEqual([]);
});

test('a late readiness response cannot approve a different selected service', async ({ page }) => {
  const app = await harness(page, 'switch');
  await page.goto('/dashboard/publish');
  await expect.poll(app.oldReadStarted).toBe(true);
  await page
    .getByRole('combobox', { name: 'Service to validate', exact: true })
    .selectOption(otherId);
  await expect(page.getByText('Some checks need attention.', { exact: true })).toBeVisible();
  app.releaseOld();
  await expect(
    page.getByRole('button', { name: 'Activate automatic quotes', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toHaveCount(0);
  expect(app.requests.writes).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('a lost successful evaluation response restores the saved result with GET and never repeats the paid POST', async ({
  page,
}) => {
  const { requests } = await harness(page, 'evaluate-lost');
  await page.goto('/dashboard/publish');
  await expect(page.getByRole('region', { name: 'Previous checks need updating' })).toBeVisible();
  await page.getByRole('button', { name: 'Run independent evaluation', exact: true }).click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/I reviewed the test results/)).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Activate automatic quotes', exact: true }),
  ).toBeDisabled();
  expect(requests.evaluations).toBe(1);
  expect(requests.readiness).toBe(2);
  expect(requests.writes).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

test('an interrupted evaluation and failed recovery read offers an explicit free GET retry without repeating checks', async ({
  page,
}) => {
  const { requests } = await harness(page, 'evaluate-read-error');
  await page.goto('/dashboard/publish');
  await expect(page.getByRole('region', { name: 'Previous checks need updating' })).toBeVisible();
  await page.getByRole('button', { name: 'Run independent evaluation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Run independent evaluation', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Load saved checks again', exact: true }).click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/I reviewed the test results/)).not.toBeChecked();
  await expect(
    page.getByText(
      'We couldn’t confirm whether the checks finished. Load your saved checks before trying again.',
      { exact: true },
    ),
  ).toHaveCount(0);
  expect(requests.evaluations).toBe(1);
  expect(requests.readiness).toBe(3);
  expect(requests.writes).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

test('a failed evaluation with no current saved result allows only an explicit new run after recovery', async ({
  page,
}) => {
  const { requests } = await harness(page, 'evaluate-no-result');
  await page.goto('/dashboard/publish');
  const run = page.getByRole('button', { name: 'Run independent evaluation', exact: true });
  await run.click();
  await expect(
    page.getByText(
      'We couldn’t find a current saved result. Review the previous results or choose to run the checks again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(run).toBeEnabled();
  expect(requests.evaluations).toBe(1);
  expect(requests.readiness).toBe(2);
  await run.click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/I reviewed the test results/)).not.toBeChecked();
  expect(requests.evaluations).toBe(2);
  expect(requests.writes).toHaveLength(2);
  expect(requests.unexpected).toEqual([]);
});
