import { expect, test } from '@playwright/test';

for (const snapshot of [
  { label: 'changed policy', source: 1, applied: 2, revision: 0, restores: true },
  { label: 'unchanged policy', source: 2, applied: 2, revision: 0, restores: true },
  { label: 'different result version', source: 1, applied: 1, revision: 0, restores: false },
  { label: 'missing result version', source: 1, applied: null, revision: 0, restores: false },
  { label: 'newer teaching notes', source: 1, applied: 2, revision: 1, restores: false },
]) {
  test(`approved recovery binds the actual result version and teaching revision: ${snapshot.label}`, async ({
    page,
  }) => {
    const serviceId = '10000000-0000-4000-8000-000000000091';
    const createdAt = '2026-10-28T12:00:00.000Z';
    const business = {
      id: '10000000-0000-4000-8000-000000000092',
      name: 'Fictional Approved Summary Test',
      slug: 'fictional-approved-summary-test',
      description: 'Window cleaning.',
      industry: 'Services',
      serviceArea: 'Austin',
      currency: 'USD',
      onboardingComplete: true,
      autoQuoteEnabled: false,
      createdAt,
    };
    const service = {
      id: serviceId,
      businessId: business.id,
      name: 'Window cleaning',
      description: 'Fictional saved window cleaning configuration.',
      unitLabel: 'window',
      unitPriceCents: 900,
      basePriceCents: 2000,
      minimumChargeCents: 12000,
      maxAutoQuoteCents: 0,
      requiredInputs: [
        'windowCount',
        'Screen cleaning',
        'Does your HOA require on-site access approval?',
      ],
      exclusions: [],
      pricingRules: [
        {
          id: 'screen',
          field: 'Screen_cleaning',
          operator: 'equals',
          value: 'yes',
          kind: 'per_unit',
          amount: 300,
          name: 'Screens',
        },
        {
          id: 'height',
          field: 'access height',
          operator: 'gt',
          value: '2',
          kind: 'review',
          amount: 0,
          name: 'High windows',
        },
      ],
      mode: 'review',
      publishedAt: null,
      version: 2,
    };
    const writes: string[] = [];
    const unexpected: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        writes.push(path);
        return route.abort();
      }
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
      if (path === '/api/v1/auth/me')
        return route.fulfill({
          json: {
            data: {
              user: {
                id: 'fictional-owner',
                name: 'Fictional Owner',
                email: 'fictional-summary@example.test',
                emailVerified: true,
              },
              business,
            },
          },
        });
      if (path === '/api/v1/dashboard')
        return route.fulfill({
          json: {
            data: {
              business,
              services: [service],
              examples: [],
              trainingSessions: [],
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
            },
          },
        });
      if (path === `/api/v1/services/${serviceId}/proposals`)
        return route.fulfill({
          json: {
            data: {
              teaching: {
                revision: snapshot.revision,
                notes: snapshot.revision
                  ? [
                      {
                        id: 'fictional-new-teaching-note',
                        content: 'Ask about access restrictions.',
                        createdAt,
                      },
                    ]
                  : [],
              },
              proposals: [
                {
                  id: 'fictional-applied-proposal',
                  serviceId,
                  serviceVersion: snapshot.source,
                  appliedServiceVersion: snapshot.applied,
                  status: 'applied',
                  teachingRevision: 0,
                  parentProposalId: null,
                  sourceExampleIds: [],
                  createdAt,
                  proposal: {
                    unitPriceCents: 99999,
                    basePriceCents: 0,
                    minimumChargeCents: 0,
                    requiredInputs: ['stale proposal question'],
                    pricingRules: [],
                    exclusions: [],
                    explanation: '',
                    uncertainties: [],
                  },
                },
              ],
            },
          },
        });
      unexpected.push(path);
      return route.fulfill({
        status: 404,
        json: { error: { code: 'TEST_UNEXPECTED', message: path } },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dashboard?service=${serviceId}`);
    const approved = page.getByRole('region', { name: 'Approved questions and pricing' });
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      if (!snapshot.restores) {
        await page.waitForLoadState('networkidle');
        await expect(approved).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Suggest customer questions', exact: true }),
        ).toBeVisible();
        if (snapshot.revision) {
          const feedback = page.getByRole('region', { name: 'Your teaching notes', exact: true });
          await expect(feedback.locator(':scope > details')).toHaveJSProperty('open', true);
          await expect(
            feedback.getByLabel('Anything to add or change?', { exact: true }),
          ).toBeVisible();
          await expect(
            feedback.getByText('Ask about access restrictions.', { exact: true }),
          ).toBeVisible();
        }
        continue;
      }
      await expect(approved).toBeVisible();
      await expect(approved.getByText('Ask customers', { exact: true })).toBeVisible();
      await expect(approved).toContainText('$9 per window · $20 base charge · $120 minimum');
      await expect(approved.getByRole('listitem')).toHaveText([
        'window count',
        'Screen cleaning',
        'Does your HOA require on-site access approval?',
        'access height',
      ]);
      await expect(approved).not.toContainText('stale proposal question');
      await expect(approved).not.toContainText('$999.99');
      await expect(
        approved.getByRole('button', { name: 'Price a practice job', exact: true }),
      ).toHaveCount(1);
      const corrections = page.getByLabel('Anything to add or change?', { exact: true });
      await expect(corrections).toBeHidden();
      await page.getByText('Add or change a detail', { exact: true }).click();
      await expect(corrections).toBeVisible();
    }
    expect(writes).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  });
}
