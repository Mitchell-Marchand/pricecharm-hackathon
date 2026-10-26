import { expect, test } from '@playwright/test';
import type { Evaluation, ImportDraft, Service } from '../../src/lib/types';

test('saving private evidence keeps an existing review link open without applying the suggestion or rerunning automatic checks', async ({
  page,
}, testInfo) => {
  const at = '2026-10-28T12:00:00.000Z';
  const serviceId = 'a1000000-0000-4000-8000-000000000001';
  const draftId = 'a1000000-0000-4000-8000-000000000002';
  const projectId = 'a1000000-0000-4000-8000-000000000003';
  const business = {
    id: 'a1000000-0000-4000-8000-000000000010',
    name: 'Fictional Review Link Windows',
    slug: 'fictional-review-link-windows',
    industry: 'Cleaning',
    description: 'Residential window cleaning.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service: Service = {
    id: serviceId,
    businessId: business.id,
    name: 'Window cleaning',
    description: 'Residential glass with owner-reviewed prices.',
    unitLabel: 'window',
    unitPriceCents: 900,
    basePriceCents: 0,
    minimumChargeCents: 12000,
    maxAutoQuoteCents: 50000,
    requiredInputs: ['surface'],
    exclusions: ['restoration'],
    pricingRules: [],
    mode: 'review',
    publishedAt: at,
    version: 7,
    approvedVersion: null,
  };
  const examples = [15, 20, 30].map((quantity, index) => ({
    id: `a1000000-0000-4000-8000-00000000002${index}`,
    businessId: business.id,
    serviceId,
    title: `${quantity} ground-floor windows`,
    description: 'Glass with straightforward access.',
    quantity,
    unitLabel: 'window',
    finalPriceCents: quantity * 900,
    rationale: 'USD 9 per window.',
    source: 'historical',
    createdAt: at,
  }));
  const rawNote =
    'Last week I cleaned 18 ground-floor windows in Austin for USD 162. I charged USD 9 per window because the glass was accessible and needed no restoration.';
  const draft: ImportDraft = {
    id: draftId,
    serviceId,
    filename: 'past-job.txt',
    sourceFilename: 'past-job.txt',
    sourceBasis: 'exact_owner_text',
    sourceNotes: rawNote,
    status: 'pending',
    notes: [],
    createdAt: at,
    projects: [
      {
        id: projectId,
        title: '18 accessible windows',
        description: '18 ground-floor windows in Austin.',
        quantity: 18,
        unitLabel: 'window',
        finalPriceCents: 16200,
        currency: 'USD',
        rationale: 'The glass was accessible and needed no restoration.',
        inputs: { location: 'Austin', surface: 'glass' },
        issues: [],
      },
    ],
  };
  const evaluation: Evaluation = {
    serviceVersion: 7,
    passed: true,
    configurationPassed: true,
    automaticReady: true,
    independentCaseCount: 4,
    checks: [
      {
        name: 'Independent prices and handoff',
        passed: true,
        detail: 'The saved independent cases passed.',
      },
    ],
    cases: [15, 20, 30, 40].map((quantity, index) => ({
      title: `Blind job ${index + 1}`,
      expectedCents: index === 3 ? 0 : quantity * 900,
      actualCents: index === 3 ? 0 : quantity * 900,
      passed: true,
      provenance: 'independent' as const,
      expectedOutcome: index === 3 ? 'review' : 'quote',
      actualOutcome: index === 3 ? 'review' : 'quote',
    })),
    evaluatedAt: at,
  };
  const proposal = {
    id: 'a1000000-0000-4000-8000-000000000031',
    serviceId,
    status: 'pending',
    serviceVersion: 8,
    teachingRevision: 0,
    parentProposalId: null,
    sourceExampleIds: [...examples.map((item) => item.id), 'saved-private-example'],
    sourceCaseIds: [],
    proposal: {
      unitLabel: 'window',
      unitPriceCents: 900,
      minimumChargeCents: 12000,
      basePriceCents: 0,
      requiredInputs: ['surface', 'access'],
      exclusions: ['restoration'],
      pricingRules: [],
      explanation: 'Check access before sending a request to the owner.',
      uncertainties: [],
    },
  };
  let pendingSuggestion = false;
  const requests = {
    writes: [] as { method: string; path: string; body?: unknown }[],
    readinessVersions: [] as number[],
    confirms: 0,
    learns: 0,
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (method !== 'GET')
      requests.writes.push({
        method,
        path,
        body: request.headers()['content-type']?.includes('application/json')
          ? request.postDataJSON()
          : undefined,
      });
    let data: unknown;
    if (method === 'GET' && path === '/api/v1/auth/me')
      data = {
        business,
        user: {
          id: 'fictional-review-owner',
          name: business.name,
          email: 'fictional-review-owner@example.test',
          emailVerified: true,
        },
      };
    else if (method === 'GET' && path === '/api/v1/settings')
      data = {
        aiMode: 'demo',
        providers: { openai: false, anthropic: false },
        billingConfigured: false,
      };
    else if (method === 'GET' && path === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples,
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          trainingCompleted: 0,
          examplesCount: examples.length,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (method === 'GET' && path === `/api/v1/services/${serviceId}/proposals`)
      data = {
        proposals: pendingSuggestion ? [proposal] : [],
        teaching: { revision: 0, notes: [] },
      };
    else if (method === 'GET' && path === `/api/v1/services/${serviceId}/readiness`) {
      requests.readinessVersions.push(service.version);
      data = {
        serviceId,
        serviceVersion: service.version,
        evaluation,
        evaluationCurrent: service.version === 7,
        invalidation: service.version === 7 ? null : 'policy_changed',
        approvalCurrent: false,
        published: true,
        autoQuoteEnabled: false,
      };
    } else if (method === 'GET' && path === `/api/v1/services/${serviceId}/test-cases`)
      data = [15, 20, 30, 40].map((quantity, index) => ({
        id: `blind-case-${index}`,
        title: `Blind job ${index + 1}`,
        description: 'An independent customer job.',
        quantity,
        expectedCents: index === 3 ? 0 : quantity * 900,
        expectedOutcome: index === 3 ? 'review' : 'quote',
        inputs: { location: 'Austin', surface: index === 3 ? 'restoration' : 'glass' },
      }));
    else if (method === 'GET' && path === '/api/v1/billing')
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
    else if (method === 'POST' && path === '/api/v1/imports/document') {
      expect(request.headers()['content-type']).toContain('multipart/form-data');
      expect(request.postData()).toContain(rawNote);
      data = { draft };
    } else if (method === 'GET' && path === `/api/v1/imports/${draftId}`) data = { draft };
    else if (method === 'POST' && path === `/api/v1/imports/${draftId}/confirm`) {
      expect(request.postDataJSON().projects).toEqual([
        expect.objectContaining({
          projectId,
          quantity: 18,
          unitLabel: 'window',
          finalPriceCents: 16200,
          currency: 'USD',
          saveAsNote: false,
        }),
      ]);
      requests.confirms++;
      examples.push({
        ...examples[0],
        id: 'saved-private-example',
        title: draft.projects[0].title,
        description: draft.projects[0].description,
        quantity: 18,
        finalPriceCents: 16200,
        rationale: draft.projects[0].rationale,
      });
      service.version = 8;
      const confirmation = {
        imported: 1,
        notesSaved: 0,
        exampleIds: ['saved-private-example'],
        jobNoteIds: [],
        alreadyConfirmed: false,
      };
      draft.status = 'confirmed';
      draft.confirmation = confirmation;
      data = { ...confirmation, draft };
    } else if (method === 'POST' && path === `/api/v1/services/${serviceId}/learn`) {
      requests.learns++;
      pendingSuggestion = true;
      data = { proposal, teaching: { revision: 0, notes: [] } };
    } else {
      requests.unexpected.push(`${method} ${path}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: `Unexpected mocked route: ${path}` } },
      });
    }
    return route.fulfill({ json: { data } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dashboard?service=${serviceId}&step=share`);
  const link = page.getByLabel('Your quote link', { exact: true });
  await expect(link).toBeVisible();
  const originalLink = await link.inputValue();
  await expect(page.locator('.assistant-privacy')).toHaveText('You approve prices');
  await expect(page.getByText('Live · You approve every price', { exact: true })).toBeVisible();
  await expect.poll(() => requests.readinessVersions.includes(7)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('review-link-before-390.png'),
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Teach', exact: true }).click();
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Add a past job', exact: false }).click();
  await page.getByLabel('Past job details', { exact: true }).fill(rawNote);
  await page.getByRole('button', { name: 'Read these job details', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review jobs and notes', exact: true });
  await expect(review).toContainText('18 accessible windows');
  await expect(page.locator('.assistant-privacy')).toHaveText('You approve prices');
  expect(service.version).toBe(7);
  expect(examples).toHaveLength(3);
  await review.getByRole('button', { name: 'Save this job', exact: true }).click();
  const suggestion = page.getByRole('article', {
    name: 'Suggested pricing and questions',
    exact: true,
  });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('access');
  await expect(
    suggestion.getByRole('button', { name: 'Use these rules', exact: false }),
  ).toBeVisible();
  await expect(page.locator('.assistant-privacy')).toHaveText('You approve prices');
  expect(service.version).toBe(8);
  expect(service.requiredInputs).toEqual(['surface']);
  expect(service.unitPriceCents).toBe(900);
  expect(service.publishedAt).toBe(at);
  expect(examples).toHaveLength(4);
  await suggestion.evaluate((element) =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }),
  );
  await page.screenshot({
    path: testInfo.outputPath('pending-private-suggestion-390.png'),
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(link).toHaveValue(originalLink);
  const automation = page.locator('details.automation-details');
  await automation.locator(':scope > summary').click();
  await expect(
    page.getByRole('region', { name: 'Previous checks need updating', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Live · You approve every price', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create my quote link', exact: true })).toHaveCount(
    0,
  );
  await expect.poll(() => requests.readinessVersions.includes(8)).toBe(true);
  await page.goBack();
  await expect(suggestion).toBeVisible();
  await expect(page.locator('.assistant-privacy')).toHaveText('You approve prices');
  await page.goForward();
  await expect(link).toHaveValue(originalLink);
  await page.reload();
  await expect(link).toHaveValue(originalLink);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.assistant-privacy')).toHaveText('You approve prices');
    await expect(page.getByText('Live · You approve every price', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`review-link-after-${width}.png`),
      animations: 'disabled',
    });
  }
  expect(requests.confirms).toBe(1);
  expect(requests.learns).toBe(1);
  expect(requests.writes.map((item) => item.path)).toEqual([
    '/api/v1/imports/document',
    `/api/v1/imports/${draftId}/confirm`,
    `/api/v1/services/${serviceId}/learn`,
  ]);
  expect(pendingSuggestion).toBe(true);
  expect(service.requiredInputs).toEqual(['surface']);
  expect(requests.unexpected).toEqual([]);
});
