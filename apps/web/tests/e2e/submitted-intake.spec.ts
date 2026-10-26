import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Quote } from '../../src/lib/types';

const at = '2026-10-28T12:00:00.000Z';
const slug = 'fictional-submitted-detailing';
const serviceId = 'd2600000-0000-4000-8000-000000000001';
const sessionId = 'd2600000-0000-4000-8000-000000000002';
const quoteId = 'd2600000-0000-4000-8000-000000000003';
const token = 'd'.repeat(43);
const note = 'I would like my hatchback cleaned in Austin.';
const returnUrl = `/q/${slug}#session=${sessionId}&token=${token}`;

async function harness(context: BrowserContext, initial?: Quote['submittedIntake']) {
  const business = {
    id: 'd2600000-0000-4000-8000-000000000004',
    name: 'Fictional Mobile Detailing',
    slug,
    industry: 'Vehicle detailing',
    description: 'Mobile vehicle detailing.',
    serviceArea: 'Austin and Round Rock',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Mobile detailing',
    description: business.description,
    unitLabel: 'vehicle',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['vehicle_type', 'interior_condition'],
    exclusions: [],
    pricingRules: [],
    mode: 'review',
    pricingQuantityRequired: false,
    publishedAt: at,
    version: 1,
  };
  let quote: Quote | undefined = initial === undefined ? undefined : makeQuote(initial);
  const session = {
    id: sessionId,
    serviceId,
    serviceVersion: 1,
    source: 'live',
    quoteMode: 'review',
    pricingQuantityRequired: false,
    requiredInputs: ['location', ...service.requiredInputs],
    status: quote ? 'submitted' : 'active',
    collectedInputs: { location: 'Austin', vehicle_type: 'Hatchback' } as Record<string, string>,
    messages: [
      { id: 'customer', role: 'user', content: note, createdAt: at },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'You can add photos and send your request.',
        createdAt: at,
      },
    ],
  };
  const requests = {
    submissions: [] as Record<string, unknown>[],
    saves: [] as unknown[],
    approvals: 0,
    decisions: 0,
    unexpected: [] as string[],
  };
  const errors: string[] = [];
  const recordErrors = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
  context.pages().forEach(recordErrors);
  context.on('page', recordErrors);
  const photo = await readFile(path.resolve('tests/e2e/fixtures/project-photo.png'));
  const photos = [
    {
      id: 'fixture-photo',
      filename: 'fictional-vehicle.png',
      previewDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
    },
  ];
  const genericQuote = () => {
    if (!quote) return [];
    const { submittedIntake: omitted, ...generic } = quote;
    void omitted;
    return [generic];
  };
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const base = `/api/v1/public/${slug}/sessions/${sessionId}`;
    let data: unknown;
    if (method === 'GET' && pathname === `/api/v1/public/${slug}`) {
      const {
        unitPriceCents,
        basePriceCents,
        minimumChargeCents,
        maxAutoQuoteCents,
        pricingRules,
        ...publicService
      } = service;
      void [unitPriceCents, basePriceCents, minimumChargeCents, maxAutoQuoteCents, pricingRules];
      data = { business, services: [publicService] };
    } else if (method === 'GET' && pathname === base) data = { ...session, quote };
    else if (method === 'GET' && pathname === `${base}/uploads`) data = photos;
    else if (method === 'POST' && pathname === `${base}/quote`) {
      const body = request.postDataJSON();
      requests.submissions.push(body);
      quote = {
        ...makeQuote({ inputs: { ...body.inputs }, quantityUnknown: body.quantityUnknown }),
        description: body.description,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        quantity: body.quantity,
      };
      session.status = 'submitted';
      data = quote;
    } else if (method === 'POST' && pathname === `${base}/decision` && quote) {
      requests.decisions++;
      quote.status = request.postDataJSON().decision;
      session.status = quote.status;
      data = quote;
    } else if (method === 'GET' && pathname === '/api/v1/auth/me')
      data = {
        business,
        user: {
          id: 'fictional-detailer-owner',
          name: business.name,
          email: 'detailer@example.test',
          emailVerified: true,
        },
      };
    else if (method === 'GET' && pathname === '/api/v1/settings')
      data = {
        aiMode: 'demo',
        providers: { openai: false, anthropic: false },
        billingConfigured: false,
      };
    else if (method === 'GET' && pathname === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: genericQuote(),
        stats: {
          totalQuotes: quote ? 1 : 0,
          reviewQuotes: quote?.status === 'review' ? 1 : 0,
          issuedQuotes: quote?.status === 'issued' ? 1 : 0,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (method === 'GET' && pathname === '/api/v1/quotes/page')
      data = {
        quotes: genericQuote(),
        counts: {
          all: quote ? 1 : 0,
          review: quote?.status === 'review' ? 1 : 0,
          issued: quote?.status === 'issued' ? 1 : 0,
        },
        pageSize: 25,
        olderCursor: null,
        newerCursor: null,
      };
    else if (method === 'GET' && pathname === `/api/v1/quotes/${quoteId}`) data = quote;
    else if (method === 'GET' && pathname === `/api/v1/quotes/${quoteId}/photos`)
      data = [
        {
          id: 'fixture-photo',
          filename: 'fictional-vehicle.png',
          url: '/api/v1/uploads/fixture-photo',
        },
      ];
    else if (method === 'GET' && pathname === '/api/v1/uploads/fixture-photo')
      return route.fulfill({ contentType: 'image/png', body: photo });
    else if (method === 'GET' && pathname === `/api/v1/quotes/${quoteId}/conversation`)
      data = session.messages;
    else if (method === 'PATCH' && pathname === `/api/v1/quotes/${quoteId}` && quote) {
      const body = request.postDataJSON();
      requests.saves.push(body);
      quote.totalCents = body.totalCents;
      quote.manualPriceRequired = false;
      quote.lineItems = [
        {
          description: 'Project price',
          quantity: 1,
          unitPriceCents: body.totalCents,
          totalCents: body.totalCents,
        },
      ];
      data = quote;
    } else if (method === 'POST' && pathname === `/api/v1/quotes/${quoteId}/approve` && quote) {
      requests.approvals++;
      quote.status = 'issued';
      quote.issuedBy = 'owner';
      session.status = 'issued';
      data = quote;
    } else if (method === 'POST' && pathname === '/api/v1/playground')
      data = {
        quote: {
          ...makeQuote({
            inputs: { private_marker: 'Never use this as live facts' },
            quantityUnknown: true,
          }),
          manualPriceRequired: false,
          totalCents: 15000,
        },
        calculation: {},
      };
    else {
      requests.unexpected.push(`${method} ${pathname}`);
      return route.fulfill({
        status: 500,
        json: { error: { message: `Unexpected fictional route: ${pathname}` } },
      });
    }
    return route.fulfill({ json: { data } });
  });
  return {
    session,
    service,
    requests,
    errors,
    current: () => quote!,
    setQuote: (next: Quote) => {
      quote = next;
    },
  };
}

function makeQuote(submittedIntake: Quote['submittedIntake']): Quote {
  return {
    id: quoteId,
    serviceId,
    customerName: 'Fictional Alex',
    customerEmail: 'alex@example.test',
    status: 'review',
    description: note,
    quantity: 1,
    totalCents: 0,
    currency: 'USD',
    manualPriceRequired: true,
    assumptions: [],
    lineItems: [],
    createdAt: at,
    submittedIntake,
  };
}

async function row(region: Locator, label: string, value: string) {
  const term = region.locator('dt').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(term).toHaveCount(1);
  await expect(term.locator('..').locator('dd')).toHaveText(value);
}

async function details(page: Page, noteLabel: 'Your note' | 'Customer note') {
  const region = page.getByRole('region', { name: 'Submitted project details', exact: true });
  await expect(region.getByRole('heading', { name: 'Project details', exact: true })).toBeVisible();
  await row(region, 'City or area', 'Round Rock');
  await row(region, 'Vehicle type', 'SUV');
  await row(region, 'Interior condition', 'Unknown');
  await row(region, 'Quantity', 'Unknown');
  await expect(region.getByRole('heading', { name: noteLabel, exact: true })).toBeVisible();
  await expect(region.locator('p')).toHaveText(note);
  return region;
}

test('final form corrections reach the customer return and owner price/approval receipts without rewriting the original note', async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await harness(context);
  await page.goto(returnUrl);
  await expect(
    page.getByRole('img', { name: 'Project photo: fictional-vehicle.png' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Alex');
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('alex@example.test');
  await page.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await page.getByRole('textbox', { name: 'City or area', exact: true }).fill('Round Rock');
  await page.getByRole('textbox', { name: 'Vehicle type', exact: true }).fill('SUV');
  await page.getByLabel('I’m not sure about interior condition.', { exact: true }).check();
  await page.getByLabel('I don’t know the quantity or measurement.', { exact: true }).check();
  await page.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await page.getByLabel(/I agree to share/).check();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  await details(page, 'Your note');
  expect(app.requests.submissions).toHaveLength(1);
  expect(app.requests.submissions[0]).toMatchObject({
    description: note,
    quantityUnknown: true,
    inputs: { location: 'Round Rock', vehicle_type: 'SUV', interior_condition: 'unknown' },
  });
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  expect(app.requests.approvals).toBe(0);
  // Later session extraction/current service policy must not rewrite the submitted snapshot.
  app.session.collectedInputs = {
    location: 'Georgetown',
    vehicle_type: 'Truck',
    interior_condition: 'Clean',
  };
  app.service.unitLabel = 'square foot';
  await page.evaluate(() => localStorage.clear());
  await page.goto('about:blank');
  await page.goto(returnUrl);
  await details(page, 'Your note');
  await expect(
    page.getByRole('img', { name: 'Project photo: fictional-vehicle.png' }),
  ).toBeVisible();

  const owner = await context.newPage();
  await owner.setViewportSize({ width: 320, height: 844 });
  await owner.goto(`/dashboard/quotes?quote=${quoteId}`);
  let dialog = owner.getByRole('region', { name: 'Review request', exact: true });
  const facts = await details(owner, 'Customer note');
  await expect(dialog.getByRole('button', { name: 'Approve this quote', exact: true })).toHaveCount(
    0,
  );
  const photo = dialog.getByRole('img');
  await expect(photo).toBeVisible();
  expect(await facts.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(
    await photo.evaluate((el) => el.getBoundingClientRect().top),
  );
  await dialog.getByRole('button', { name: 'Set a price', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: 'Quote total ($)', exact: true }).fill('180');
  await dialog
    .getByRole('textbox', { name: 'Private reason for this price', exact: true })
    .fill('SUV interior cleaning; final scope checked from the request.');
  await dialog.getByRole('button', { name: 'Save price', exact: true }).click();
  dialog = owner.getByRole('region', { name: 'Review quote', exact: true });
  await expect(dialog.getByText('Draft total', { exact: true })).toBeVisible();
  await details(owner, 'Customer note');
  expect(app.requests.approvals).toBe(0);
  await dialog.getByRole('button', { name: 'Approve this quote', exact: true }).click();
  await expect(owner.getByRole('region', { name: 'Quote details', exact: true })).toBeVisible();
  await details(owner, 'Customer note');
  await owner.reload();
  await details(owner, 'Customer note');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your quote', exact: true })).toBeVisible();
  await details(page, 'Your note');
  await expect(page.locator('.public-final-price')).toHaveText('$180');
  await page.getByRole('button', { name: 'Accept quote', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quote accepted', exact: true })).toBeVisible();
  await details(page, 'Your note');
  await owner.reload();
  await details(owner, 'Customer note');
  await expect(owner.getByRole('button', { name: 'Approve this quote', exact: true })).toHaveCount(
    0,
  );
  expect(app.requests.saves).toHaveLength(1);
  expect(app.requests.approvals).toBe(1);
  expect(app.requests.decisions).toBe(1);
  expect(app.requests.unexpected).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('submitted facts retain unknown, blank, false and zero while measurement uses only the explicit snapshot flag', async ({
  context,
  page,
}) => {
  const app = await harness(context, {
    inputs: {
      access: 'unknown',
      optional_detail: '',
      pet_hair: 'false',
      child_seats: '0',
      covered: 'true',
    },
    quantityUnknown: false,
  });
  app.current().quantity = 2.5;
  app.service.unitLabel = 'current policy units';
  await page.goto(returnUrl);
  const region = page.getByRole('region', { name: 'Submitted project details', exact: true });
  for (const [label, value] of [
    ['Access', 'Unknown'],
    ['Optional detail', 'Not provided'],
    ['Pet hair', 'No'],
    ['Child seats', '0'],
    ['Covered', 'Yes'],
    ['Quantity', '2.5'],
  ])
    await row(region, label, value);
  await expect(region).not.toContainText('current policy units');
  app.current().submittedIntake!.quantityUnknown = null;
  await page.reload();
  await expect(region.locator('dt').filter({ hasText: /^Quantity$/ })).toHaveCount(0);
  await row(region, 'Child seats', '0');
  app.current().submittedIntake!.quantityUnknown = true;
  app.current().quantity = 1;
  await page.reload();
  await row(region, 'Quantity', 'Unknown');
  expect(app.requests.submissions).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('legacy or empty snapshots retain the old note presentation and private calculator ignores submitted live facts', async ({
  context,
  page,
}) => {
  const app = await harness(context, null);
  for (const snapshot of [null, { inputs: {}, quantityUnknown: null }]) {
    app.current().submittedIntake = snapshot;
    await page.goto(returnUrl);
    await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Submitted project details', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.public-request-summary small')).toHaveText(note);
    await page.goto('about:blank');
  }
  await page.goto(`/dashboard/quotes?quote=${quoteId}`);
  await expect(
    page.getByRole('region', { name: 'Customer project', exact: true }).locator('p'),
  ).toHaveText(note);
  await expect(
    page.getByRole('region', { name: 'Submitted project details', exact: true }),
  ).toHaveCount(0);
  await page.goto('/dashboard/playground');
  await page.getByRole('spinbutton', { name: 'Quantity (vehicle)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Describe the request', exact: true }).fill(note);
  await page.getByRole('button', { name: 'Calculate a test quote', exact: true }).click();
  const card = page.locator('.quote-card');
  await expect(card.getByText('Private test', { exact: true })).toHaveCount(2);
  await expect(card.getByText('Calculated draft', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('Never use this as live facts');
  await expect(
    page.getByRole('region', { name: 'Submitted project details', exact: true }),
  ).toHaveCount(0);
  expect(app.requests.unexpected).toEqual([]);
  expect(app.errors).toEqual([]);
});
