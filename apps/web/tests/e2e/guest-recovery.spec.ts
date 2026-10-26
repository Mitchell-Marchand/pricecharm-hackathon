import { expect, test, type Page } from '@playwright/test';
import type { GuestPreview } from '../../src/lib/types';

const firstId = '62000000-0000-4000-8000-000000000001';
const secondId = '62000000-0000-4000-8000-000000000002';
const serviceId = '62000000-0000-4000-8000-000000000003';
const note =
  'I offer photography in Denver. I charged $180 for a brief portrait shoot because edited photos were included. I bill by the hour but did not record the hours.';
const changed = `${note} I also photograph products and need to know the number of items.`;
const earlierNotice = 'These are your earlier questions. Your changes aren’t included.';
const questions = [
  'What kind of photography do you need?',
  'Where will the session take place?',
  'Would you like edited photographs?',
];
const draftKey = 'quotient:guest-preview:draft';
const approvalKey = 'quotient:guest-preview:approval';

type Mode =
  | 'failed'
  | 'capped'
  | 'uncertain'
  | 'processing'
  | 'lost-claim'
  | 'expired-owner'
  | 'version-changed'
  | 'same-attempt';
async function recoveryHarness(page: Page, mode: Mode) {
  const business = {
    id: 'fictional-recovery-business',
    name: 'Fictional Photography',
    slug: 'fictional-photography',
    industry: 'Photography',
    description: '',
    serviceArea: '',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: '2026-10-28T12:00:00Z',
  };
  const user = {
    id: 'fictional-recovery-owner',
    name: business.name,
    email: 'fictional-recovery@example.test',
    emailVerified: false,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Photography',
    description: 'Photography in Denver.',
    unitLabel: 'hour',
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
  const ready = (id: string, content: string): GuestPreview => ({
    id,
    version: 1,
    status: 'ready',
    content,
    expiresAt: '2099-01-01T00:00:00Z',
    receipt: {
      name: service.name,
      description: service.description,
      unitLabel: 'hour',
      example: {
        title: 'Portrait shoot',
        description: 'A brief portrait shoot with edited photos.',
        quantity: null,
        finalPriceCents: null,
        rationale: 'Edited photos were included.',
      },
      sourcePriceText: '$180',
      sourceCurrency: null,
    },
    questions,
    readyToSave: true,
    aiMode: 'live',
  });
  const rows = new Map<string, GuestPreview>();
  let latest: GuestPreview | null = null;
  let authenticated = mode === 'expired-owner';
  let expired = false;
  let proofExpiresAt = '2099-01-01T00:00:00Z';
  let owned = false;
  let changeProofOnRetry = false;
  let uncertain: 'offline' | 'missing' | 'failed' = 'offline';
  const requests = {
    previews: [] as { content: string; requestId: string }[],
    gets: [] as string[],
    claims: [] as { id: string; body: unknown }[],
    registrations: 0,
    logins: 0,
    unexpected: [] as string[],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data: unknown;
    if (path === '/api/v1/guest-preview' && request.method() === 'GET') {
      requests.gets.push(url.search);
      const key = url.searchParams.get('requestId');
      if (
        mode === 'uncertain' &&
        key === requests.previews[1]?.requestId &&
        uncertain === 'offline'
      )
        return route.abort('failed');
      let primary = expired
        ? null
        : key
          ? rows.get(key) || null
          : url.searchParams.has('previewId')
            ? [...rows.values()].find((item) => item.id === url.searchParams.get('previewId')) ||
              null
            : latest;
      if (mode === 'version-changed' && url.searchParams.has('previewId') && primary)
        primary = { ...primary, version: 2 };
      const recoverable =
        !expired && (!primary || primary.status === 'failed')
          ? [...rows.values()].find((item) => item.id === firstId && item.status === 'ready') ||
            null
          : null;
      // An unrelated ready result must never substitute for an unavailable exact approval.
      data = {
        preview: primary,
        recoverablePreview: expired ? ready(secondId, changed) : recoverable,
        expiresAt: proofExpiresAt,
      };
    } else if (path === '/api/v1/guest-preview' && request.method() === 'POST') {
      const body = request.postDataJSON();
      requests.previews.push(body);
      const isSecond = requests.previews.length === 2;
      if (changeProofOnRetry && requests.previews.length > 2) {
        proofExpiresAt = '2099-02-01T00:00:00Z';
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'GUEST_PREVIEW_PROOF_CHANGED',
              message: 'Your preview session changed. Your note is kept.',
            },
          },
        });
      }
      if (isSecond && mode === 'capped')
        return route.fulfill({
          status: 429,
          json: {
            error: {
              code: 'GUEST_LIMIT',
              message:
                'This preview allowance has been used. Your earlier questions are still available.',
            },
          },
        });
      if (isSecond && (mode === 'uncertain' || mode === 'same-attempt'))
        return route.abort('failed');
      latest = ready(requests.previews.length === 1 ? firstId : secondId, body.content);
      if (isSecond && mode === 'failed')
        latest = {
          ...latest,
          status: 'failed',
          readyToSave: false,
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'The edited preview could not be prepared. Your note is kept.',
          },
        };
      if (isSecond && mode === 'processing')
        latest = { ...latest, status: 'processing', receipt: null, readyToSave: false };
      if (mode === 'same-attempt' && requests.previews.length > 2)
        latest = { ...latest, status: 'processing', receipt: null, readyToSave: false };
      rows.set(body.requestId, latest);
      if (mode === 'same-attempt' && requests.previews.length > 2)
        return route.fulfill({ status: 202, json: { data: { preview: latest } } });
      if (isSecond && mode === 'processing') return route.abort('failed');
      data = { preview: latest };
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
    } else if (/^\/api\/v1\/guest-preview\/[^/]+\/claim$/.test(path)) {
      const id = path.split('/')[4];
      requests.claims.push({ id, body: request.postDataJSON() });
      if (expired && !owned)
        return route.fulfill({
          status: 410,
          json: {
            error: {
              code: 'PREVIEW_EXPIRED',
              message: 'This preview has expired. Your note is kept on the preview page.',
            },
          },
        });
      owned = true;
      for (const [key, item] of rows)
        if (item.id === id)
          rows.set(key, {
            ...item,
            status: 'claimed',
            claim: { serviceId, setupId: 'fictional-setup', proposalId: 'fictional-proposal' },
          });
      if (mode === 'lost-claim' && requests.claims.length === 1) return route.abort('failed');
      data = { service, alreadyClaimed: requests.claims.length > 1 };
    } else if (path === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
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
            sourceCaseIds: [],
            proposal: { requiredInputs: questions },
          },
        ],
        teaching: { revision: 0, notes: [] },
      };
    else {
      requests.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: { code: 'UNMOCKED', message: path } } });
    }
    await route.fulfill({ json: { data } });
  });
  return {
    requests,
    expire: () => {
      expired = true;
    },
    changeProofOnRetry: () => {
      changeProofOnRetry = true;
    },
    renewProof: () => {
      proofExpiresAt = '2099-02-01T00:00:00Z';
    },
    missing: () => {
      uncertain = 'missing';
    },
    complete: () => {
      const body = requests.previews[1];
      latest = ready(secondId, body.content);
      rows.set(body.requestId, latest);
    },
    resolve: () => {
      uncertain = 'failed';
      const body = requests.previews[1];
      latest = {
        ...ready(secondId, body.content),
        status: 'failed',
        readyToSave: false,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The edited preview could not be prepared. Your note is kept.',
        },
      };
      rows.set(body.requestId, latest);
    },
  };
}

async function firstPreview(page: Page, padding = false) {
  await page.goto('/');
  await page
    .getByLabel('Start with your work.', { exact: true })
    .fill(padding ? `\n ${note} \n` : note);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save your assistant', exact: true }),
  ).toBeVisible();
}
async function editAndSubmit(page: Page) {
  await page.getByRole('button', { name: 'Edit your note', exact: true }).click();
  await page.getByLabel('Start with your work.', { exact: true }).fill(changed);
  await page.getByRole('button', { name: 'Show me the questions', exact: true }).click();
}
async function register(page: Page) {
  await page.getByLabel(/^Business name/).fill('Fictional Photography');
  await page.getByLabel(/^Email address/).fill('fictional-recovery@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-long!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
}

for (const mode of ['failed', 'capped'] as const) {
  test(`${mode} edited preview restores exact earlier questions across reload and signup while retaining changes`, async ({
    page,
  }) => {
    const { requests } = await recoveryHarness(page, mode);
    await page.setViewportSize({ width: 390, height: 844 });
    await firstPreview(page, true);
    await editAndSubmit(page);
    await expect(page.getByText(earlierNotice, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Your assistant preview' }).getByRole('listitem'),
    ).toHaveText(questions);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Save earlier questions', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to your changes', exact: true }).click();
    await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(changed);
    await page.getByRole('button', { name: 'Back to your preview', exact: true }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
    }
    await page.getByRole('button', { name: 'Save earlier questions', exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`signup\\?from=preview&previewId=${firstId}&version=1`),
    );
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`login\\?from=preview&previewId=${firstId}&version=1`));
    await page.getByRole('link', { name: 'Create an account', exact: true }).click();
    await page.getByText('View your preview · 3 questions', { exact: true }).click();
    await page.getByText('Your original note', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Your assistant preview' })).toContainText(note);
    await expect(page.getByRole('region', { name: 'Your assistant preview' })).not.toContainText(
      'number of items',
    );
    await register(page);
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
    expect(requests.gets.filter((query) => query.includes('previewId='))).toEqual(
      Array(3).fill(`?previewId=${firstId}`),
    );
    expect(requests.claims).toEqual([
      { id: firstId, body: { expectedVersion: 1, approveIntake: true } },
    ]);
    expect(requests.previews).toHaveLength(2);
    const draft = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) || 'null'),
      draftKey,
    );
    expect(draft).toMatchObject({ content: changed, editing: true, needsCheck: false });
    expect(draft.requestId).toBe(requests.previews[1].requestId);
    expect(requests.registrations).toBe(1);
    expect(requests.unexpected).toEqual([]);
  });
}

test('unresolved edited POST stays guarded through null reads, edit, earlier view, and reload without losing a newer draft', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'uncertain');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByRole('button', { name: 'Check for my result', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to your changes', exact: true }).click();
  const newest = `${changed} Ask about the delivery deadline too.`;
  await page.getByLabel('Start with your work.', { exact: true }).fill(newest);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  control.missing();
  await page.getByRole('button', { name: 'Check for my result', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(newest);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Back to your preview', exact: true }).click();
  await expect(page.getByText(earlierNotice, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to your changes', exact: true }).click();
  control.resolve();
  await page.getByRole('button', { name: 'Check for my result', exact: true }).click();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(newest);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeEnabled();
  expect(control.requests.previews).toHaveLength(2);
  expect(
    control.requests.gets
      .slice(1)
      .every((query) => query === `?requestId=${control.requests.previews[1].requestId}`),
  ).toBe(true);
  expect(control.requests.claims).toHaveLength(0);
  expect(control.requests.unexpected).toEqual([]);
});

test('a lost edited response with a known processing result shows that active request rather than the earlier receipt', async ({
  page,
}) => {
  const { requests } = await recoveryHarness(page, 'processing');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByText('Preparing questions from your note…', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save earlier questions', exact: true }),
  ).toHaveCount(0);
  const workingNote = page.getByLabel('Start with your work.', { exact: true });
  await expect(workingNote).toBeEditable();
  await workingNote.focus();
  await expect(workingNote).toBeFocused();
  await expect(workingNote).toHaveValue(changed);
  await expect(
    page.getByRole('region', { name: 'Your assistant preview', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Preparing questions from your note…', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  expect(requests.previews).toHaveLength(2);
  expect(requests.claims).toHaveLength(0);
});

test('blocked storage carries exact earlier approval through signup and login without adopting the newer failed result', async ({
  page,
}) => {
  const { requests } = await recoveryHarness(page, 'failed');
  await page.addInitScript(() =>
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    }),
  );
  await firstPreview(page);
  await editAndSubmit(page);
  await page.getByRole('button', { name: 'Save earlier questions', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?from=preview&previewId=${firstId}&version=1`));
  await page.getByLabel(/^Email address/).fill('fictional-recovery@example.test');
  await page.getByLabel(/^Password/).fill('Fictional-password-long!');
  await page.getByRole('button', { name: 'Sign in and save assistant', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  expect(requests.claims).toEqual([
    { id: firstId, body: { expectedVersion: 1, approveIntake: true } },
  ]);
  expect(requests.gets.filter((query) => query.includes('previewId='))).toEqual([
    `?previewId=${firstId}`,
    `?previewId=${firstId}`,
  ]);
  expect(requests.previews).toHaveLength(2);
  expect(requests.logins).toBe(1);
  expect(requests.registrations).toBe(0);
  expect(requests.unexpected).toEqual([]);
});

test('an exact approval version mismatch never registers, claims, or substitutes another result', async ({
  page,
}) => {
  const { requests } = await recoveryHarness(page, 'version-changed');
  await firstPreview(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your preview has changed.' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to your preview', exact: true })).toBeVisible();
  expect(requests.claims).toHaveLength(0);
  expect(requests.registrations).toBe(0);
  expect(requests.previews).toHaveLength(1);
});

test('an authenticated lost successful claim can be explicitly checked by exact intent after proof expiry', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'lost-claim');
  await firstPreview(page);
  await page.getByRole('button', { name: 'Save your assistant', exact: true }).click();
  await register(page);
  await expect(page.getByRole('button', { name: 'Try saving again', exact: true })).toBeVisible();
  control.expire();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Check saved assistant', exact: true }),
  ).toBeVisible();
  expect(control.requests.claims).toHaveLength(1);
  await page.getByRole('button', { name: 'Check saved assistant', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  expect(control.requests.claims).toEqual(
    Array(2).fill({ id: firstId, body: { expectedVersion: 1, approveIntake: true } }),
  );
  expect(control.requests.registrations).toBe(1);
  expect(control.requests.previews).toHaveLength(1);
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null'), draftKey),
  ).toMatchObject({ content: note, editing: true });
  expect(control.requests.unexpected).toEqual([]);
});

test('checking a never-claimed expired preview fails honestly and keeps the note without analysis or adopting recovery', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'expired-owner');
  await page.addInitScript(
    ({ draftKey, approvalKey, note, firstId }) => {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ content: note, requestId: '', editing: false, needsCheck: false }),
      );
      sessionStorage.setItem(approvalKey, JSON.stringify({ previewId: firstId, version: 1 }));
    },
    { draftKey, approvalKey, note, firstId },
  );
  control.expire();
  await page.goto(`/signup?from=preview&previewId=${firstId}&version=1`);
  await expect(
    page.getByRole('button', { name: 'Check saved assistant', exact: true }),
  ).toBeVisible();
  expect(control.requests.claims).toHaveLength(0);
  await page.getByRole('button', { name: 'Check saved assistant', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This preview has expired.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to your preview', exact: true }).click();
  await page.getByRole('button', { name: 'Back to your changes', exact: true }).click();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(note);
  expect(control.requests.claims).toEqual([
    { id: firstId, body: { expectedVersion: 1, approveIntake: true } },
  ]);
  expect(control.requests.previews).toHaveLength(0);
  expect(control.requests.registrations).toBe(0);
});

test('an explicit retry after a null read reuses the exact submitted note and request ID while preserving later edits', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'same-attempt');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByRole('button', { name: 'Retry last submission', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to your changes', exact: true }).click();
  const newest = `${changed} Ask about a delivery deadline too.`;
  await page.getByLabel('Start with your work.', { exact: true }).fill(newest);
  await page.reload();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(newest);
  await page.getByRole('button', { name: 'Retry last submission', exact: true }).click();
  await expect(
    page.getByText('Preparing questions from your note…', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save earlier questions', exact: true }),
  ).toHaveCount(0);
  await page.getByText('Your original note', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText(changed);
  await expect(page.locator('details[open]')).not.toContainText('delivery deadline');
  expect(control.requests.previews).toHaveLength(3);
  expect(control.requests.previews[2]).toEqual({
    ...control.requests.previews[1],
    expectedSessionExpiresAt: '2099-01-01T00:00:00Z',
  });
  await page.getByLabel('Start with your work.', { exact: true }).focus();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(newest);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  control.complete();
  await page.getByRole('button', { name: 'Check for my result', exact: true }).click();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(newest);
  await expect(page.getByText(earlierNotice, { exact: true })).toBeVisible();
  expect(new Set(control.requests.previews.map((item) => item.requestId)).size).toBe(2);
  expect(control.requests.claims).toHaveLength(0);
  expect(control.requests.unexpected).toEqual([]);
});

test('legacy uncertain drafts without an exact submission snapshot remain check-only', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'uncertain');
  await page.addInitScript(
    ({ draftKey, changed }) =>
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          content: changed,
          requestId: '62000000-0000-4000-8000-000000000009',
          editing: true,
          needsCheck: true,
        }),
      ),
    { draftKey, changed },
  );
  await page.goto('/');
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(changed);
  await page.getByRole('button', { name: 'Check for my result', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry last submission', exact: true }),
  ).toHaveCount(0);
  expect(control.requests.previews).toHaveLength(0);
});

test('an expired or changed proof retires the uncertain attempt without resending it and leaves an explicit fresh analysis action', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'same-attempt');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByRole('button', { name: 'Retry last submission', exact: true }),
  ).toBeVisible();
  control.renewProof();
  await page.getByRole('button', { name: 'Check for my result', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'That preview has expired.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(changed);
  await expect(
    page.getByRole('button', { name: 'Retry last submission', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save earlier questions', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeEnabled();
  expect(control.requests.previews).toHaveLength(2);
  expect(control.requests.claims).toHaveLength(0);
});

test('a server-rejected proof change during same-attempt retry clears uncertainty without another automatic analysis', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'same-attempt');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByRole('button', { name: 'Retry last submission', exact: true }),
  ).toBeVisible();
  control.changeProofOnRetry();
  await page.getByRole('button', { name: 'Retry last submission', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'That preview has expired.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Start with your work.', { exact: true })).toHaveValue(changed);
  await expect(
    page.getByRole('button', { name: 'Show me the questions', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Save earlier questions', exact: true }),
  ).toHaveCount(0);
  expect(control.requests.previews).toHaveLength(3);
  expect(control.requests.previews[2]).toEqual({
    ...control.requests.previews[1],
    expectedSessionExpiresAt: '2099-01-01T00:00:00Z',
  });
  expect(new Set(control.requests.previews.map((item) => item.requestId)).size).toBe(2);
  expect(control.requests.claims).toHaveLength(0);
});

test('saving earlier questions while a later attempt is unresolved stays on Teach and retains the later note and check guard', async ({
  page,
}) => {
  const control = await recoveryHarness(page, 'uncertain');
  await firstPreview(page);
  await editAndSubmit(page);
  await expect(
    page.getByRole('button', { name: 'Check for my result', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save earlier questions', exact: true }).click();
  await register(page);
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?service=${serviceId}&step=teach$`));
  await expect(page.getByRole('region', { name: 'Approved questions and pricing' })).toBeVisible();
  const draft = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) || 'null'),
    draftKey,
  );
  expect(draft).toMatchObject({
    content: changed,
    editing: true,
    needsCheck: true,
    requestId: control.requests.previews[1].requestId,
    attemptContent: changed,
  });
  expect(control.requests.previews).toHaveLength(2);
  expect(control.requests.claims).toEqual([
    { id: firstId, body: { expectedVersion: 1, approveIntake: true } },
  ]);
  expect(control.requests.unexpected).toEqual([]);
});
