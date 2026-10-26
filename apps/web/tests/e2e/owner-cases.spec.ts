import { expect, test, type Page } from '@playwright/test';

const ids = {
  business: '61000000-0000-4000-8000-000000000001',
  service: '61000000-0000-4000-8000-000000000002',
  setup: '61000000-0000-4000-8000-000000000003',
  practice: '61000000-0000-4000-8000-000000000004',
  note: '61000000-0000-4000-8000-000000000005',
  proposal: '61000000-0000-4000-8000-000000000006',
  example: '61000000-0000-4000-8000-000000000007',
};
const createdAt = '2026-10-28T12:00:00.000Z';
const photographerNote =
  'I charged $180 for family photos in the park, including edited digital photos. I do not remember how long it took and do not have an hourly price.';
const inspectionReason =
  'I need to inspect the pipework under the sink in person before I can price this repair, because I cannot see which fitting is leaking.';

async function ownerCases(page: Page, inspection = false, measured = false) {
  const business = {
    id: ids.business,
    name: 'Fictional Owner Case Test',
    slug: 'fictional-owner-case-test',
    description: inspection ? 'Household leak repairs.' : 'Family photography.',
    industry: 'Services',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt,
  };
  const service = {
    id: ids.service,
    businessId: business.id,
    name: inspection ? 'Leak repair' : 'Family photography',
    description: business.description,
    unitLabel: inspection ? 'project' : 'hour',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: [] as string[],
    exclusions: [] as string[],
    pricingRules: [],
    mode: 'review',
    publishedAt: null,
    version: 1,
  };
  const practice = {
    id: ids.practice,
    serviceId: ids.service,
    unitLabel: 'project',
    status: 'active',
    outcome: undefined as 'quote' | 'inspection_required' | undefined,
    finalPriceCents: undefined as number | null | undefined,
    rationale: undefined as string | undefined,
    savedExampleId: null as string | null,
    scenario: {
      title: inspection ? 'Fictional kitchen sink leak' : 'Family portraits in the park',
      customerName: 'Fictional Alex',
      description: inspection
        ? 'A kitchen sink leaks underneath when the tap runs.'
        : 'Family photographs in the park with edited digital photos.',
      details: measured ? { quantity: '2 projects' } : {},
    },
    messages: [
      {
        id: 'customer',
        role: 'assistant',
        content: inspection
          ? 'Water is dripping under my kitchen sink. What will the repair cost?'
          : 'We would like family photographs in the park with edited photos. What would you charge?',
        createdAt,
      },
    ],
    createdAt,
  };
  const setup = {
    id: ids.setup,
    status: 'active',
    version: 2,
    messages: [
      { id: 'greeting', role: 'assistant', content: 'Tell me about a past job.', createdAt },
      { id: 'owner', role: 'user', content: photographerNote, createdAt },
      {
        id: 'ack',
        role: 'assistant',
        content: 'The hours are unknown. Your past total is not an hourly rate.',
        createdAt,
      },
    ],
    draft: {
      name: service.name,
      description: service.description,
      unitLabel: 'hour',
      example: {
        title: 'Family portraits in the park',
        description: 'Family photographs in the park with edited digital photos.',
        quantity: null,
        finalPriceCents: 18000,
        rationale:
          'The agreed price covered the session and edited photos; the hours were not recorded.',
      },
    },
    readyToConfirm: true,
    serviceId: null,
  };
  const jobNote = {
    id: ids.note,
    serviceId: ids.service,
    source: inspection ? 'training' : 'setup',
    kind: inspection ? 'inspection_required' : 'historical_job',
    title: inspection ? 'Inspection needed for the kitchen sink leak' : setup.draft.example.title,
    description: inspection ? practice.scenario.description : setup.draft.example.description,
    quantity: null,
    unitLabel: service.unitLabel,
    finalPriceCents: inspection ? null : 18000,
    rationale: inspection ? inspectionReason : setup.draft.example.rationale,
    sourceNotes: inspection ? inspectionReason : photographerNote,
    createdAt,
  };
  const practiceNote = {
    ...jobNote,
    id: ids.practice,
    source: 'training',
    kind: 'practice_quote',
    unitLabel: null,
    description: practice.scenario.description,
    sourceNotes: 'I would charge $180.\n\n' + jobNote.rationale,
    sourceBasis: 'exact_owner_text',
    createdAt: '2026-10-28T12:01:00.000Z',
  };
  const practiceExample = {
    id: ids.example,
    serviceId: ids.service,
    title: practice.scenario.title,
    description: practice.scenario.description,
    quantity: 2,
    unitLabel: 'project',
    finalPriceCents: 18000,
    rationale: jobNote.rationale,
    createdAt: '2026-10-28T12:01:00.000Z',
  };
  const questions = inspection
    ? ['visible problem', 'property address', 'photos of the leak']
    : [
        'Where will the session take place?',
        'What date would you prefer?',
        'Would you like edited digital photos in JPG format?',
      ];
  const proposal = {
    id: ids.proposal,
    serviceId: ids.service,
    serviceVersion: 1,
    appliedServiceVersion: null as number | null,
    status: 'pending',
    teachingRevision: 0,
    parentProposalId: null,
    sourceExampleIds: [] as string[],
    sourceCaseIds: [ids.note],
    proposal: {
      unitPriceCents: 0,
      basePriceCents: 0,
      minimumChargeCents: 0,
      requiredInputs: questions,
      exclusions: [],
      pricingRules: [],
      explanation:
        'These questions prepare a request for owner review. No standard price is assumed.',
      uncertainties: [],
    },
  };
  if (measured) {
    service.version = 2;
    service.requiredInputs = questions;
    proposal.status = 'applied';
    proposal.appliedServiceVersion = service.version;
  }
  let saved = inspection || measured;
  let noteSaved = measured;
  let practiceStarted = false;
  let practiceNoteSaved = false;
  let practiceExampleSaved = false;
  let proposalReady = measured;
  let releaseApplyFailure = () => {};
  const applyFailure = new Promise<void>((resolve) => {
    releaseApplyFailure = resolve;
  });
  const requests = {
    practiceStarts: 0,
    learn: 0,
    apply: [] as unknown[],
    complete: [] as unknown[],
    messages: [] as unknown[],
    drafts: [] as unknown[],
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === '/api/v1/auth/me')
      data = {
        user: {
          id: 'fictional-owner',
          name: 'Fictional Owner',
          email: 'fictional-owner-cases@example.test',
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
        services: saved ? [service] : [],
        examples: practiceExampleSaved ? [practiceExample] : [],
        jobNotes: [...(noteSaved ? [jobNote] : []), ...(practiceNoteSaved ? [practiceNote] : [])],
        trainingSessions: inspection || practiceStarted ? [practice] : [],
        recentQuotes: [],
        stats: {
          totalQuotes: 0,
          issuedQuotes: 0,
          reviewQuotes: 0,
          trainingCompleted: practice.status === 'completed' ? 1 : 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (request.method() === 'POST' && path === '/api/v1/service-setup') data = setup;
    else if (request.method() === 'POST' && path === `/api/v1/service-setup/${ids.setup}/confirm`) {
      saved = true;
      noteSaved = true;
      data = {
        session: { ...setup, status: 'confirmed', serviceId: service.id },
        service,
        evidenceSaved: 'job_note',
        jobNote,
      };
    } else if (path === `/api/v1/training/${ids.practice}`) data = practice;
    else if (request.method() === 'POST' && path === '/api/v1/training') {
      requests.practiceStarts++;
      expect(request.postDataJSON()).toEqual({ serviceId: service.id });
      practiceStarted = true;
      data = practice;
    } else if (
      request.method() === 'POST' &&
      path === `/api/v1/training/${ids.practice}/messages`
    ) {
      requests.messages.push(request.postDataJSON());
      const content = request.postDataJSON().content;
      practice.messages.push(
        { id: 'owner-price', role: 'user', content, createdAt },
        {
          id: 'customer-reason',
          role: 'assistant',
          content: 'Why would you charge that?',
          createdAt,
        },
      );
      data = practice;
    } else if (path === `/api/v1/services/${ids.service}/proposals`)
      data = { proposals: proposalReady ? [proposal] : [], teaching: { revision: 0, notes: [] } };
    else if (request.method() === 'POST' && path === `/api/v1/services/${ids.service}/learn`) {
      requests.learn++;
      if (!inspection && !measured && requests.learn === 1)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic unavailable suggestion.' } },
        });
      proposalReady = true;
      proposal.status = 'pending';
      proposal.serviceVersion = service.version;
      proposal.appliedServiceVersion = null;
      if (practiceNoteSaved) proposal.sourceCaseIds = [practiceNote.id];
      if (practiceExampleSaved) proposal.sourceExampleIds = [practiceExample.id];
      data = { proposal, teaching: { revision: 0, notes: [] } };
    } else if (request.method() === 'POST' && path === `/api/v1/proposals/${ids.proposal}/apply`) {
      requests.apply.push(request.postDataJSON());
      if (!inspection && !measured && requests.apply.length === 1) {
        await applyFailure;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic apply unavailable.' } },
        });
      }
      service.version += 1;
      service.requiredInputs = questions;
      proposal.status = 'applied';
      proposal.appliedServiceVersion = service.version;
      data = { service, proposal };
    } else if (
      request.method() === 'POST' &&
      path === `/api/v1/training/${ids.practice}/quote-draft`
    ) {
      requests.drafts.push(request.postDataJSON());
      expect(request.postDataJSON()).toEqual({
        content: inspection ? inspectionReason : jobNote.rationale,
      });
      data = {
        outcome: inspection ? 'inspection_required' : 'quote',
        finalPriceCents: inspection ? null : 18000,
        rationale: inspection ? inspectionReason : jobNote.rationale,
        readyToConfirm: true,
        reply: 'Review this inspection decision before saving.',
        aiMode: 'demo',
      };
    } else if (
      request.method() === 'POST' &&
      path === `/api/v1/training/${ids.practice}/complete`
    ) {
      requests.complete.push(request.postDataJSON());
      practice.status = 'completed';
      practice.outcome = inspection ? 'inspection_required' : 'quote';
      practice.finalPriceCents = inspection ? null : 18000;
      practice.rationale = inspection ? inspectionReason : jobNote.rationale;
      if (inspection) noteSaved = true;
      else if (measured) {
        practiceExampleSaved = true;
        practice.savedExampleId = practiceExample.id;
        service.version += 1;
      } else practiceNoteSaved = true;
      data = practice;
    } else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: { message: path } } });
    }
    return route.fulfill({ json: { data } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  return {
    requests,
    questions,
    jobNote,
    releaseApplyFailure,
    advanceServiceVersion: () => {
      service.version += 1;
    },
  };
}

test('an unknown-hours job leads to explicit price teaching, confirmed learning and an editable customer rehearsal without inventing a rate', async ({
  page,
}) => {
  const { requests, questions, jobNote, releaseApplyFailure, advanceServiceVersion } =
    await ownerCases(page);
  await page.goto('/dashboard?new=1');
  await expect(page.getByRole('button', { name: 'Save this job', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save this job', exact: true }).click();
  await expect(
    page.getByText('Your job is saved. We couldn’t put together a suggestion yet.', {
      exact: true,
    }),
  ).toBeVisible();
  const receipt = page.locator('.saved-job-recap');
  await expect(receipt).toContainText('Family portraits in the park');
  await expect(receipt).toContainText('$180');
  await expect(receipt).toContainText('hours were not recorded');
  await expect(receipt).not.toContainText('1 hour');
  await page.getByRole('button', { name: 'Suggest customer questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  const suggestion = page.getByRole('article', { name: 'Suggested pricing and questions' });
  await expect(suggestion.getByText('Ask customers', { exact: true })).toBeVisible();
  await expect(suggestion.getByRole('listitem')).toHaveText(questions);
  await expect(page.getByRole('log', { name: 'Practice conversation' })).toHaveCount(0);
  const feedback = page.getByRole('region', { name: 'Your teaching notes', exact: true });
  const disclosure = feedback.locator(':scope > details');
  const corrections = feedback.getByLabel('Anything to add or change?', { exact: true });
  const toggle = feedback.getByText('Add or change a detail', { exact: true });
  const apply = suggestion.getByRole('button', { name: 'Use these questions', exact: true });
  await expect(apply).toBeVisible();
  await expect(disclosure).toHaveJSProperty('open', false);
  await expect(corrections).toBeHidden();
  await toggle.click();
  await expect(corrections).toBeVisible();
  await toggle.click();
  await expect(corrections).toBeHidden();
  expect(requests.learn).toBe(2);
  expect(requests.apply).toEqual([]);
  await apply.click();
  try {
    await expect.poll(() => requests.apply.length).toBe(1);
    await expect(suggestion).toBeVisible();
    await expect(disclosure).toHaveJSProperty('open', true);
    await expect(corrections).toBeVisible();
    await expect(corrections).toBeDisabled();
    await expect(apply).toBeDisabled();
  } finally {
    releaseApplyFailure();
  }
  await expect(page.getByText('Synthetic apply unavailable.', { exact: true })).toBeVisible();
  await expect(suggestion.getByRole('listitem')).toHaveText(questions);
  await expect(disclosure).toHaveJSProperty('open', true);
  await expect(corrections).toBeVisible();
  await expect(corrections).toHaveValue('');
  await expect(corrections).toBeEnabled();
  await expect(apply).toBeEnabled();
  expect(requests.apply).toEqual([{}]);
  await apply.click();
  const approved = page.getByRole('region', { name: 'Approved questions and pricing' });
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(approved.getByText('Ask customers', { exact: true })).toBeVisible();
    await expect(approved.getByRole('listitem')).toHaveText(questions);
    await expect(approved).toContainText('Family portraits in the park');
    await expect(approved).toContainText('$180');
    await expect(approved.locator('.applied-pricing')).toHaveCount(0);
    await expect(
      approved.getByRole('button', { name: 'Price a practice job', exact: true }),
    ).toBeVisible();
    await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toHaveCount(0);
    await expect(disclosure).toHaveJSProperty('open', false);
    await expect(corrections).toBeHidden();
  }
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByText('Original job note', { exact: true }).click();
  await expect(page.getByText(photographerNote, { exact: true })).toBeVisible();
  expect(requests.practiceStarts).toBe(0);
  expect(requests.learn).toBe(2);
  expect(requests.apply).toEqual([{}, {}]);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await approved.getByRole('button', { name: 'Price a practice job', exact: true }).click();
  // Starting a practice puts its id in the URL, which remounts the practice panel. Wait for that
  // before typing, or a slow runner can type into the panel that is about to be replaced.
  await expect(page).toHaveURL(new RegExp(`practice=${ids.practice}`));
  const reply = page.getByLabel('Your reply to the practice customer', { exact: true });
  await expect(reply).toBeVisible();
  await expect(page.getByRole('button', { name: 'Price a practice job', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Price another practice job', exact: true }),
  ).toHaveCount(0);
  expect(requests.practiceStarts).toBe(1);
  expect(requests.learn).toBe(2);
  await reply.fill('I would charge $180.');
  await page.getByRole('button', { name: 'Send practice reply', exact: true }).click();
  await expect(reply).toHaveValue('');
  await reply.fill(jobNote.rationale);
  await page.getByRole('button', { name: 'Finish this practice', exact: true }).click();
  const confirmation = page.locator('.quote-confirmation');
  await expect(confirmation).toContainText('$180');
  await expect(confirmation).toContainText(jobNote.rationale);
  expect(requests.messages).toEqual([{ content: 'I would charge $180.' }]);
  expect(requests.drafts).toEqual([{ content: jobNote.rationale }]);
  expect(requests.complete).toEqual([]);
  await confirmation.getByRole('button', { name: 'Save this quote', exact: true }).click();
  await expect(page.locator('.practice-recap')).toContainText(
    'Your quote and reasoning are saved.',
  );
  await expect(page.locator('.practice-recap')).toContainText(jobNote.rationale);
  expect(requests.complete).toEqual([
    { finalPriceCents: 18000, rationale: jobNote.rationale, saveAsExample: false },
  ]);
  await expect(
    page.getByRole('button', { name: 'See what it learned', exact: true }),
  ).toBeVisible();
  advanceServiceVersion();
  await page.reload();
  await expect(page.locator('.practice-recap')).toContainText(jobNote.rationale);
  await page.getByRole('button', { name: 'See what it learned', exact: true }).click();
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('No standard rate is assumed.');
  await expect(page.locator('.practice-recap')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'View conversation', exact: true }),
  ).not.toContainText('$180');
  await expect(page.getByRole('button', { name: 'Price a practice job', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Price another practice job', exact: true }),
  ).toHaveCount(0);
  await expect(apply).toBeVisible();
  await page.reload();
  await expect(suggestion).toBeVisible();
  await expect(page.locator('.practice-recap')).toContainText(jobNote.rationale);
  expect(requests.practiceStarts).toBe(1);
  expect(requests.learn).toBe(3);
  await apply.click();
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  advanceServiceVersion();
  await page.reload();
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  await expect(approved.getByRole('listitem')).toHaveText(questions);
  await expect(page.getByRole('button', { name: 'See what it learned', exact: true })).toHaveCount(
    0,
  );
  await expect(
    approved.getByRole('button', { name: 'Price another practice job', exact: true }),
  ).toBeVisible();
  await expect(
    approved.getByRole('button', { name: 'Price a practice job', exact: true }),
  ).toHaveCount(0);
  await expect(approved.locator('.applied-pricing')).toHaveCount(0);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await expect(page.locator('.case-note-row')).toHaveCount(1);
  await expect(page.locator('.practice-history-list > button')).toHaveCount(1);
  await expect(page.locator('.practice-history-list')).toContainText('$180');
  await approved.getByRole('button', { name: 'Try it', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('try');
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveValue(
    jobNote.description,
  );
  await expect(page.getByLabel('Customer’s project', { exact: true })).toBeEditable();
  await page.getByRole('button', { name: 'Teach', exact: true }).click();
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Price a practice job', exact: true })).toHaveCount(
    0,
  );
  await page.goto(`/dashboard?service=${ids.service}&step=teach`);
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  await expect(
    approved.getByRole('button', { name: 'Price another practice job', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Price a practice job', exact: true })).toHaveCount(
    0,
  );
  expect(requests.practiceStarts).toBe(1);
  expect(requests.learn).toBe(3);
  expect(requests.apply).toEqual([{}, {}, {}]);
  expect(requests.unexpected).toEqual([]);
});

test('a measured practice restores its applied lesson after a later configuration version without relearning', async ({
  page,
}) => {
  const { requests, questions, jobNote, advanceServiceVersion } = await ownerCases(
    page,
    false,
    true,
  );
  await page.goto(`/dashboard?service=${ids.service}&step=teach`);
  await page.getByRole('button', { name: 'Price a practice job', exact: true }).click();
  // Starting a practice puts its id in the URL, which remounts the practice panel. Wait for that
  // before typing, or a slow runner can type into the panel that is about to be replaced.
  await expect(page).toHaveURL(new RegExp(`practice=${ids.practice}`));
  const reply = page.getByLabel('Your reply to the practice customer', { exact: true });
  await reply.fill('I would charge $180.');
  await page.getByRole('button', { name: 'Send practice reply', exact: true }).click();
  await expect(reply).toHaveValue('');
  await reply.fill(jobNote.rationale);
  await page.getByRole('button', { name: 'Finish this practice', exact: true }).click();
  const confirmation = page.locator('.quote-confirmation');
  await expect(confirmation).toContainText('$180');
  await confirmation.getByRole('button', { name: 'Save this quote', exact: true }).click();
  expect(requests.complete).toEqual([
    { finalPriceCents: 18000, rationale: jobNote.rationale, saveAsExample: true },
  ]);
  await page.reload();
  const learn = page.getByRole('button', { name: 'See what it learned', exact: true });
  await expect(learn).toBeVisible();
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toHaveCount(0);
  await learn.click();
  const suggestion = page.getByRole('article', { name: 'Suggested pricing and questions' });
  await expect(suggestion).toBeVisible();
  await suggestion.getByRole('button', { name: 'Use these questions', exact: true }).click();
  const approved = page.getByRole('region', { name: 'Approved questions and pricing' });
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  advanceServiceVersion();
  await page.reload();
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  await expect(approved.getByRole('listitem')).toHaveText(questions);
  await expect(learn).toHaveCount(0);
  await page.goto(`/dashboard?service=${ids.service}&step=teach`);
  await expect(approved.getByRole('button', { name: 'Try it', exact: true })).toBeVisible();
  await expect(learn).toHaveCount(0);
  expect(requests.practiceStarts).toBe(1);
  expect(requests.learn).toBe(1);
  expect(requests.apply).toEqual([{}]);
  expect(requests.unexpected).toEqual([]);
});

test('an explicit inspection decision saves its exact reason with no price and can teach intake questions', async ({
  page,
}) => {
  const { requests } = await ownerCases(page, true);
  await page.goto(`/dashboard?service=${ids.service}&practice=${ids.practice}`);
  await page
    .getByLabel('Your reply to the practice customer', { exact: true })
    .fill(inspectionReason);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Add a past job', exact: false }).click();
  await expect(
    page.getByLabel('Your reply to the practice customer', { exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: 'Close past job note', exact: true }).click();
  await expect(page.getByLabel('Your reply to the practice customer', { exact: true })).toHaveValue(
    inspectionReason,
  );
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page.getByRole('button', { name: 'Finish this practice', exact: true }).click();
  const confirmation = page.locator('.quote-confirmation');
  await expect(confirmation).toContainText('Inspection needed');
  await expect(confirmation).toContainText(inspectionReason);
  await expect(confirmation).not.toContainText('$0');
  expect(requests.complete).toEqual([]);
  await confirmation.getByRole('button', { name: 'Save inspection decision', exact: true }).click();
  await expect(page.getByText('Inspection decision saved.', { exact: true })).toBeVisible();
  await expect(page.locator('.practice-recap')).toContainText(inspectionReason);
  expect(requests.complete).toEqual([
    {
      outcome: 'inspection_required',
      finalPriceCents: null,
      rationale: inspectionReason,
      saveAsExample: false,
    },
  ]);
  await page.getByRole('button', { name: 'See what it learned', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Questions for new customers' })).toBeVisible();
  await expect(page.locator('.teaching-canvas')).not.toContainText('$0');
  await page.reload();
  await page.getByRole('button', { name: 'View conversation', exact: true }).click();
  await expect(page.locator('.practice-recap')).toContainText(inspectionReason);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await expect(page.locator('.evidence-row')).toContainText('Inspection needed');
  await expect(page.locator('.practice-history-list')).toContainText('Inspection needed');
  expect(requests.practiceStarts).toBe(0);
  expect(requests.unexpected).toEqual([]);
});
