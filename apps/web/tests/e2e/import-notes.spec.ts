import { expect, test, type Page } from '@playwright/test';

const serviceId = '71000000-0000-4000-8000-000000000001';
const draftId = '71000000-0000-4000-8000-000000000002';
const at = '2026-10-28T12:00:00.000Z';
const rawNote =
  'I photographed a family in the park for $180, including edited digital photos. I do not remember the hours. The price covered the session and the edited photos.';
const incomplete = {
  id: '71000000-0000-4000-8000-000000000003',
  title: 'Family portraits in the park',
  description: 'Family portraits with edited digital photographs.',
  quantity: null,
  unitLabel: null,
  finalPriceCents: 18000,
  rationale: '',
  currency: 'USD' as string | null,
  inputs: {},
  issues: ['Hours were not recorded.'],
};

async function harness(
  page: Page,
  mode: 'note' | 'mixed' | 'unknown' | 'confirmed' | 'zero' = 'note',
) {
  const business = {
    id: '71000000-0000-4000-8000-000000000010',
    name: 'Fictional Import Review',
    slug: 'fictional-import-review',
    description: 'Photography.',
    industry: 'Services',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Photography',
    description: 'Photography for families and events.',
    unitLabel: 'hour',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: [],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    publishedAt: null,
    version: 1,
  };
  const projects =
    mode === 'mixed'
      ? [
          {
            ...incomplete,
            id: '71000000-0000-4000-8000-000000000004',
            title: 'Complete guest-priced job',
            quantity: 10,
            unitLabel: 'guest',
            finalPriceCents: 40000,
            rationale: 'The explicitly agreed per-guest rate.',
          },
          { ...incomplete, title: 'Foreign invoice with unknown hours', currency: 'CAD' },
        ]
      : [
          {
            ...incomplete,
            ...(mode === 'unknown'
              ? {
                  currency: null,
                  quantity: 2,
                  unitLabel: 'hour',
                  rationale: 'Two hours with edited digital photos.',
                }
              : {}),
            ...(mode === 'zero'
              ? {
                  finalPriceCents: 0,
                  quantity: 1,
                  unitLabel: 'project',
                  rationale: 'A repeat visit covered by the original warranty.',
                }
              : {}),
          },
        ];
  const draft = {
    id: draftId,
    serviceId,
    filename: mode === 'note' ? 'past-job.txt' : 'source-invoice.pdf',
    sourceFilename: mode === 'note' ? 'past-job.txt' : 'source-invoice.pdf',
    sourceBasis: mode === 'note' ? 'exact_owner_text' : 'reviewed_extraction',
    sourceNotes: mode === 'note' ? rawNote : undefined,
    status: mode === 'confirmed' ? 'confirmed' : 'pending',
    projects,
    notes: [],
    createdAt: at,
    confirmation:
      mode === 'confirmed'
        ? {
            imported: 0,
            notesSaved: 1,
            exampleIds: [],
            jobNoteIds: ['saved-note'],
            alreadyConfirmed: true,
          }
        : (undefined as Record<string, unknown> | undefined),
  };
  const jobNotes: Record<string, unknown>[] = [];
  const examples: Record<string, unknown>[] = [];
  let proposalReady = false;
  const requests = {
    extracts: 0,
    gets: 0,
    confirms: [] as Record<string, unknown>[],
    learns: 0,
    unexpected: [] as string[],
  };
  const proposal = {
    id: '71000000-0000-4000-8000-000000000020',
    serviceId,
    serviceVersion: 2,
    status: 'pending',
    teachingRevision: 0,
    parentProposalId: null,
    sourceExampleIds: [],
    sourceCaseIds: ['saved-note'],
    proposal: {
      unitPriceCents: 0,
      basePriceCents: 0,
      minimumChargeCents: 0,
      requiredInputs: ['session location', 'photos wanted'],
      exclusions: [],
      pricingRules: [],
      explanation: 'Prepare the request for owner review.',
      uncertainties: [],
    },
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === '/api/v1/auth/me')
      data = {
        user: {
          id: 'fictional-import-owner',
          name: 'Fictional Owner',
          email: 'fictional-import@example.test',
          emailVerified: true,
        },
        business,
      };
    else if (path === '/api/v1/settings')
      data = {
        aiMode: 'demo',
        providers: { openai: false, anthropic: false },
        billingConfigured: false,
      };
    else if (path === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples,
        jobNotes,
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
    else if (path === `/api/v1/services/${serviceId}/proposals`)
      data = { proposals: proposalReady ? [proposal] : [], teaching: { revision: 0, notes: [] } };
    else if (path === '/api/v1/imports') data = { drafts: mode === 'confirmed' ? [] : [draft] };
    else if (path === `/api/v1/imports/${draftId}` && request.method() === 'GET') {
      requests.gets++;
      data = { draft };
    } else if (path === '/api/v1/imports/document' && request.method() === 'POST') {
      requests.extracts++;
      data = { draft };
    } else if (path === `/api/v1/imports/${draftId}/confirm` && request.method() === 'POST') {
      const body = request.postDataJSON();
      requests.confirms.push(body);
      if (mode === 'note' && requests.confirms.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic save temporarily unavailable.' } },
        });
      let imported = 0,
        notesSaved = 0;
      for (const project of body.projects) {
        if (project.saveAsNote) {
          notesSaved++;
          jobNotes.push({
            id: 'saved-note',
            serviceId,
            source: 'import',
            kind: 'historical_job',
            sourceBasis: draft.sourceBasis,
            sourceFilename: draft.sourceFilename,
            sourceCurrency:
              projects.find((source) => source.id === project.projectId)?.currency ?? null,
            sourceNotes:
              draft.sourceNotes || `Reviewed extraction from ${draft.filename}: CAD 180.`,
            title: project.title,
            description: project.description,
            quantity: project.quantity,
            unitLabel: project.unitLabel,
            finalPriceCents: project.finalPriceCents,
            rationale: project.rationale,
            createdAt: at,
          });
        } else {
          imported++;
          examples.push({
            ...project,
            id: 'saved-example',
            serviceId,
            businessId: business.id,
            source: 'historical',
            createdAt: at,
          });
        }
      }
      service.version = 2;
      const receipt = {
        imported,
        notesSaved,
        exampleIds: imported ? ['saved-example'] : [],
        jobNoteIds: notesSaved ? ['saved-note'] : [],
        alreadyConfirmed: false,
      };
      draft.status = 'confirmed';
      draft.confirmation = receipt;
      data = { ...receipt, draft };
    } else if (path === `/api/v1/services/${serviceId}/learn` && request.method() === 'POST') {
      requests.learns++;
      proposalReady = true;
      data = { proposal, teaching: { revision: 0, notes: [] } };
    } else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: { message: path } } });
    }
    return route.fulfill({ json: { data } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  return { requests, business, draft };
}

async function openPastNote(page: Page) {
  await page.goto(`/dashboard?service=${serviceId}`);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Add a past job', exact: false }).click();
}
async function openDocument(page: Page) {
  await page.goto(`/dashboard?service=${serviceId}`);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Add an invoice or photo', exact: true }).click();
}

test('an incomplete pasted job preserves raw text and review edits on reload, then saves as a note without re-extraction or practice', async ({
  page,
}) => {
  const { requests } = await harness(page);
  await openPastNote(page);
  await page.getByLabel('Past job details', { exact: true }).fill(rawNote);
  await openPastNote(page);
  await expect(page.getByLabel('Past job details', { exact: true })).toHaveValue(rawNote);
  expect(requests.extracts).toBe(0);
  await page.getByRole('button', { name: 'Read these job details', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review jobs and notes' });
  await expect(review).toContainText('Quantity not recorded');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole('button', { name: 'Suggest customer questions', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try it', exact: true })).toHaveCount(0);
    const bounds = await review.boundingBox();
    for (const name of ['Edit original note', 'Save this note']) {
      const control = review.getByRole('button', { name, exact: true });
      const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await review.getByText('Edit details', { exact: true }).click();
  await review.getByLabel('Job title', { exact: true }).fill('Edited park portrait job');
  await expect(review.getByLabel('Quantity unit', { exact: true })).toHaveValue('');
  await openPastNote(page);
  const restored = page.getByRole('region', { name: 'Review jobs and notes' });
  await restored.getByText('Edit details', { exact: true }).click();
  await expect(restored.getByLabel('Job title', { exact: true })).toHaveValue(
    'Edited park portrait job',
  );
  expect(requests.extracts).toBe(1);
  await restored.getByRole('button', { name: 'Save this note', exact: true }).click();
  await expect(restored).toContainText('Synthetic save temporarily unavailable.');
  await expect(restored.getByLabel('Job title', { exact: true })).toHaveValue(
    'Edited park portrait job',
  );
  await restored.getByRole('button', { name: 'Save this note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  expect(requests.confirms[0]).toEqual(requests.confirms[1]);
  const saved = (requests.confirms[1].projects as Record<string, unknown>[])[0];
  expect(saved).toMatchObject({
    projectId: incomplete.id,
    saveAsNote: true,
    quantity: null,
    unitLabel: null,
    currency: 'USD',
    finalPriceCents: 18000,
    rationale: '',
  });
  expect(requests.learns).toBe(1);
  expect(requests.unexpected).toEqual([]);
});

test('a mixed document saves exact job/note counts and preserves foreign currency and unknown units without USD coercion', async ({
  page,
}) => {
  const { requests } = await harness(page, 'mixed');
  await openDocument(page);
  await page.getByLabel('Project document').setInputFiles({
    name: 'source-invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Synthetic browser-only fixture.'),
  });
  await page.getByRole('button', { name: 'Read this document', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review jobs and notes' });
  await expect(review).toContainText('Extracted from source-invoice.pdf');
  await expect(review.getByText('Original job note', { exact: true })).toHaveCount(0);
  const foreign = review.getByRole('article').nth(1);
  await foreign.getByText('Edit details', { exact: true }).click();
  await expect(foreign.getByRole('combobox', { name: 'Currency', exact: true })).toHaveValue('CAD');
  await expect(foreign.getByLabel('Quantity unit', { exact: true })).toHaveValue('');
  await review.getByRole('button', { name: 'Save 1 job and 1 note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  const rows = requests.confirms[0].projects as Record<string, unknown>[];
  expect(rows[0]).toMatchObject({
    saveAsNote: false,
    quantity: 10,
    unitLabel: 'guest',
    currency: 'USD',
    finalPriceCents: 40000,
  });
  expect(rows[1]).toMatchObject({
    saveAsNote: true,
    quantity: null,
    unitLabel: null,
    currency: 'CAD',
    finalPriceCents: null,
  });
  const savedJobs = page.locator('details.evidence-details');
  if (!(await savedJobs.evaluate((element) => element.hasAttribute('open'))))
    await savedJobs.locator('summary').first().click();
  await expect(page.getByText('Reviewed document details', { exact: true })).toBeVisible();
  expect(requests.extracts).toBe(1);
  expect(requests.confirms).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
});

test('confirming unknown currency as USD clears the source amount and requires an owner-entered amount before priced-example eligibility', async ({
  page,
}) => {
  const { requests } = await harness(page, 'unknown');
  await openDocument(page);
  await page.getByRole('button', { name: /source-invoice.pdf/ }).click();
  const review = page.getByRole('region', { name: 'Review jobs and notes' });
  await expect(review.getByRole('button', { name: 'Save this note', exact: true })).toBeEnabled();
  await review.getByText('Edit details', { exact: true }).click();
  await review.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('USD');
  await expect(review.getByLabel('Confirmed amount in USD', { exact: true })).toHaveValue('');
  await expect(review.getByRole('button', { name: 'Save this note', exact: true })).toBeEnabled();
  await review.getByLabel('Confirmed amount in USD', { exact: true }).fill('200');
  await review.getByRole('button', { name: 'Save this job', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  expect((requests.confirms[0].projects as Record<string, unknown>[])[0]).toMatchObject({
    currency: 'USD',
    finalPriceCents: 20000,
    saveAsNote: false,
    quantity: 2,
    unitLabel: 'hour',
  });
  expect(requests.extracts).toBe(0);
  expect(requests.unexpected).toEqual([]);
});

test('a confirmed import resumes by GET and shows its saved receipt without another extraction, confirmation or learning call', async ({
  page,
}) => {
  const { requests, business } = await harness(page, 'confirmed');
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), {
    key: `quotient:document-draft:${business.id}:${serviceId}`,
    id: draftId,
  });
  await openDocument(page);
  await expect(page.getByRole('region', { name: 'Import saved receipt' })).toContainText(
    '1 job note saved.',
  );
  expect(requests.gets).toBe(1);
  expect(requests.extracts).toBe(0);
  expect(requests.confirms).toHaveLength(0);
  expect(requests.learns).toBe(0);
  expect(requests.unexpected).toEqual([]);
});

test('a genuine zero-price job remains a priced example and removed rows can be restored without extraction', async ({
  page,
}) => {
  const { requests } = await harness(page, 'zero');
  await openDocument(page);
  await page.getByRole('button', { name: /source-invoice.pdf/ }).click();
  const review = page.getByRole('region', { name: 'Review jobs and notes' });
  await expect(review.getByRole('button', { name: 'Save this job', exact: true })).toBeEnabled();
  await review
    .getByRole('button', { name: 'Remove Family portraits in the park', exact: true })
    .click();
  await review.getByRole('button', { name: 'Restore extracted jobs', exact: true }).click();
  await review.getByRole('button', { name: 'Save this job', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  expect((requests.confirms[0].projects as Record<string, unknown>[])[0]).toMatchObject({
    finalPriceCents: 0,
    saveAsNote: false,
    quantity: 1,
    unitLabel: 'project',
    currency: 'USD',
  });
  expect(requests.extracts).toBe(0);
  expect(requests.unexpected).toEqual([]);
});
