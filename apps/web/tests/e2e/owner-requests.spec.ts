import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Quote } from '../../src/lib/types';

const at = '2026-10-28T12:00:00.000Z';
const serviceId = 'b1000000-0000-4000-8000-000000000001';
const manualId = 'b1000000-0000-4000-8000-000000000011';
const pricedId = 'b1000000-0000-4000-8000-000000000012';
const issuedId = 'b1000000-0000-4000-8000-000000000013';
const acceptedId = 'b1000000-0000-4000-8000-000000000014';
const declinedId = 'b1000000-0000-4000-8000-000000000015';
const freeId = 'b1000000-0000-4000-8000-000000000016';
const project =
  'Paint the living room and hallway. The walls are dark red, with two small holes to fill. Furniture needs protecting. I do not know the measurements.';

async function harness(page: Page, { failPriceSave = true, failPhotoRead = false } = {}) {
  const business = {
    id: 'fictional-owner-requests-business',
    name: 'Fictional Rivera Painting',
    slug: 'fictional-rivera-painting',
    industry: 'Painting',
    description: 'Interior wall painting.',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  const service = {
    id: serviceId,
    businessId: business.id,
    name: 'Interior painting',
    description: business.description,
    unitLabel: 'project',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['rooms', 'location'],
    pricingRules: [],
    exclusions: [],
    mode: 'review',
    publishedAt: at,
    version: 3,
  };
  const rows: Quote[] = [
    {
      id: manualId,
      customerName: 'Fictional Maya',
      status: 'review',
      totalCents: 0,
      manualPriceRequired: true,
      description: project,
    },
    {
      id: pricedId,
      customerName: 'Fictional Leo',
      status: 'review',
      totalCents: 24500,
      description: 'Paint a prepared bedroom with straightforward access.',
    },
    {
      id: issuedId,
      customerName: 'Fictional Iris',
      status: 'issued',
      totalCents: 30000,
      description: 'Approved living-room painting.',
    },
    {
      id: acceptedId,
      customerName: 'Fictional Noah',
      status: 'accepted',
      totalCents: 18000,
      description: 'Accepted hallway painting.',
    },
    {
      id: declinedId,
      customerName: 'Fictional Zoe',
      status: 'declined',
      totalCents: 22000,
      description: 'Declined study painting.',
    },
    {
      id: freeId,
      customerName: 'Fictional Warranty',
      status: 'issued',
      totalCents: 0,
      description: 'An owner-issued warranty repair with no additional charge.',
    },
  ].map(
    (row) =>
      ({
        ...row,
        serviceId,
        customerEmail: `${row.customerName.toLowerCase().replaceAll(' ', '-')}@example.test`,
        quantity: 1,
        currency: 'USD',
        createdAt: at,
        issuedBy: row.id === issuedId ? 'automatic' : row.status !== 'review' ? 'owner' : undefined,
        assumptions:
          row.status === 'review'
            ? [
                'Owner approval is required before this price is issued.',
                'Furniture protection is included in this project.',
              ]
            : row.id === issuedId
              ? [
                  'Calculated using the business owner’s approved pricing policy and your confirmed project details.',
                ]
              : ['Reviewed and approved by the business owner.'],
        lineItems:
          row.id === pricedId
            ? [
                {
                  description: 'Painting scope',
                  quantity: 1,
                  unitPriceCents: 27500,
                  totalCents: 27500,
                },
                {
                  description: 'Owner adjustment',
                  quantity: 1,
                  unitPriceCents: -3000,
                  totalCents: -3000,
                },
              ]
            : row.totalCents
              ? [
                  {
                    description: 'Painting scope',
                    quantity: 1,
                    unitPriceCents: row.totalCents,
                    totalCents: row.totalCents,
                  },
                ]
              : [],
      }) as Quote,
  );
  const conversations = new Map(
    rows.map((quote) => [
      quote.id,
      [
        {
          id: `customer-${quote.id}`,
          role: 'user',
          author: 'customer',
          content: quote.description,
          createdAt: at,
        },
      ],
    ]),
  );
  const requests = {
    calculations: [] as unknown[],
    revisions: [] as unknown[],
    approvals: [] as string[],
    replies: [] as unknown[],
    photoReads: 0,
    unexpected: [] as string[],
  };
  let failPrice = failPriceSave,
    failReply = true;
  const photo = await readFile(path.resolve('tests/e2e/fixtures/project-photo.png'));
  const photoId = 'b1000000-0000-4000-8000-000000000020';
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      method = request.method(),
      pathname = new URL(request.url()).pathname;
    let data: unknown;
    if (method === 'GET' && pathname === '/api/v1/auth/me')
      data = {
        business,
        user: {
          id: 'fictional-owner-requests-user',
          name: business.name,
          email: 'fictional-owner-requests@example.test',
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
        recentQuotes: rows,
        stats: {
          totalQuotes: rows.length,
          reviewQuotes: rows.filter((quote) => quote.status === 'review').length,
          issuedQuotes: rows.filter((quote) => quote.status === 'issued').length,
          trainingCompleted: 0,
          examplesCount: 0,
          quotedValueCents: 0,
        },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (method === 'GET' && pathname === '/api/v1/quotes/page') {
      const filter = new URL(request.url()).searchParams.get('filter') || 'all';
      data = {
        quotes: rows.filter((quote) => filter === 'all' || quote.status === filter),
        counts: {
          all: rows.length,
          review: rows.filter((quote) => quote.status === 'review').length,
          issued: rows.filter((quote) => quote.status === 'issued').length,
        },
        pageSize: 25,
        olderCursor: null,
        newerCursor: null,
      };
    } else if (method === 'GET' && pathname === '/api/v1/quotes') data = rows;
    else if (method === 'POST' && pathname === '/api/v1/playground') {
      requests.calculations.push(request.postDataJSON());
      data = { quote: rows.find((quote) => quote.id === pricedId), calculation: {} };
    } else if (method === 'GET' && pathname === `/api/v1/uploads/${photoId}`)
      return route.fulfill({ contentType: 'image/png', body: photo });
    else {
      const match =
        /^\/api\/v1\/quotes\/([^/]+)(?:\/(photos|conversation|messages|approve))?$/.exec(pathname);
      const quote = rows.find((item) => item.id === match?.[1]);
      if (!quote) {
        requests.unexpected.push(`${method} ${pathname}`);
        return route.fulfill({
          status: 500,
          json: { error: { message: pathname } },
        });
      }
      if (method === 'GET' && !match?.[2]) data = quote;
      else if (method === 'GET' && match?.[2] === 'photos') {
        requests.photoReads++;
        if (failPhotoRead) {
          failPhotoRead = false;
          return route.fulfill({
            status: 503,
            json: { error: { message: 'Project photos could not be loaded.' } },
          });
        }
        data =
          quote.id === manualId
            ? [
                {
                  id: photoId,
                  filename: 'fictional-wall.png',
                  url: `/api/v1/uploads/${photoId}`,
                },
              ]
            : [];
      } else if (method === 'GET' && match?.[2] === 'conversation')
        data = conversations.get(quote.id);
      else if (method === 'POST' && match?.[2] === 'messages') {
        requests.replies.push(request.postDataJSON());
        if (failReply) {
          failReply = false;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                message: 'The reply could not be sent. Please try again.',
              },
            },
          });
        }
        conversations.get(quote.id)!.push({
          id: `owner-${quote.id}`,
          role: 'assistant',
          author: 'owner',
          content: request.postDataJSON().content,
          createdAt: at,
        });
        data = { messages: conversations.get(quote.id) };
      } else if (method === 'PATCH' && !match?.[2]) {
        const body = request.postDataJSON();
        requests.revisions.push(body);
        if (failPrice) {
          failPrice = false;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                message: 'The price could not be saved. Please try again.',
              },
            },
          });
        }
        const firstPrice = quote.manualPriceRequired === true;
        quote.totalCents = body.totalCents;
        quote.manualPriceRequired = false;
        quote.lineItems = [
          {
            description: firstPrice ? 'Project price' : 'Owner adjustment',
            quantity: 1,
            unitPriceCents: body.totalCents,
            totalCents: body.totalCents,
          },
        ];
        data = quote;
      } else if (method === 'POST' && match?.[2] === 'approve') {
        expect(quote.manualPriceRequired).not.toBe(true);
        requests.approvals.push(quote.id);
        quote.status = 'issued';
        quote.issuedBy = 'owner';
        quote.assumptions = ['Reviewed and approved by the business owner.'];
        data = quote;
      } else {
        requests.unexpected.push(`${method} ${pathname}`);
        return route.fulfill({
          status: 500,
          json: { error: { message: pathname } },
        });
      }
    }
    return route.fulfill({ json: { data } });
  });
  await page.goto('/dashboard/quotes');
  return { rows, requests };
}

test('an unpriced request is visible on phones, shows project facts first, and requires a saved price before explicit approval', async ({
  page,
}, testInfo) => {
  const app = await harness(page, { failPhotoRead: true });
  const request = page.getByRole('button', {
    name: 'Review request for Fictional Maya',
    exact: true,
  });
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await request.scrollIntoViewIfNeeded();
    await expect(request).toContainText('Price needed');
    await expect(request).toContainText('Interior painting');
    await expect(request).toContainText('Needs your response');
    await expect(request.locator('time')).toContainText('Oct 28');
    expect(
      await request.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight
        );
      }),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`owner-request-list-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await request.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('region', {
    name: 'Review request',
    exact: true,
  });
  const facts = dialog.getByRole('region', {
    name: 'Customer project',
    exact: true,
  });
  await expect(facts).toContainText(project);
  await expect(dialog.getByText(/^\$0(?:\.00)?$/)).toHaveCount(0);
  await expect(dialog.getByText('1 project', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('textbox', {
      name: 'Reply directly to the customer',
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Approve this quote', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('link', { name: 'Project details', exact: true }).click();
  await expect(
    dialog.getByRole('complementary', { name: 'Request details', exact: true }),
  ).toBeFocused();
  await expect(facts.getByRole('heading', { name: 'Project details', exact: true })).toBeVisible();
  await expect(dialog.getByRole('log', { name: 'Customer conversation' })).toContainText(project);
  const projectPhotos = dialog.getByRole('region', {
    name: 'Customer project photos',
    exact: true,
  });
  await expect(projectPhotos.getByRole('alert')).toContainText(
    'Project photos could not be loaded.',
  );
  const retryPhotos = projectPhotos.getByRole('button', { name: 'Retry photos', exact: true });
  await expect(retryPhotos).toBeVisible();
  await retryPhotos.click();
  await expect.poll(() => app.requests.photoReads).toBe(2);
  const image = dialog.getByRole('img', {
    name: 'Customer project: fictional-wall.png',
    exact: true,
  });
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth > 0))
    .toBe(true);
  expect(
    await facts.evaluate((element) =>
      Boolean(
        element.compareDocumentPosition(
          document.querySelector('[aria-label="Customer project photos"]')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('owner-request-review-390.png'),
    animations: 'disabled',
  });

  const reply = dialog.getByRole('textbox', {
    name: 'Reply directly to the customer',
    exact: true,
  });
  const question = 'Could you send a closer photo of the damaged corner?';
  await reply.fill(question);
  await expect(dialog.locator('.button-primary:visible:not([disabled])')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Set a price', exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Sending stops automatic replies for this request.', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Set a price', exact: true }).click();
  await expect(reply).toBeHidden();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reply).toHaveValue(question);
  await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'The reply could not be sent. Please try again.',
  );
  await expect(reply).toHaveValue(question);
  expect(app.requests.replies).toEqual([{ content: question }]);
  await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(reply).toHaveValue('');
  expect(app.requests.replies).toEqual([{ content: question }, { content: question }]);
  await expect(dialog.getByRole('log', { name: 'Customer conversation' })).toContainText(question);
  await expect(dialog.getByRole('log', { name: 'Customer conversation' })).toContainText('You');

  await dialog.getByRole('button', { name: 'Set a price', exact: true }).click();
  const price = dialog.getByRole('spinbutton', { name: 'Quote total ($)', exact: true });
  const reason = dialog.getByRole('textbox', {
    name: 'Private reason for this price',
    exact: true,
  });
  await expect(price).toHaveValue('');
  await expect(
    dialog.getByRole('textbox', { name: 'Reply directly to the customer', exact: true }),
  ).toBeHidden();
  await expect(dialog.locator('.button-primary:visible:not([disabled])')).toHaveCount(1);
  await expect(reason).toHaveAttribute('required');
  await price.fill('275');
  await reason.fill('Wall preparation and protecting furniture are included.');
  await dialog.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'The price could not be saved. Please try again.',
  );
  await expect(price).toHaveValue('275');
  await expect(reason).toHaveValue('Wall preparation and protecting furniture are included.');
  await expect(dialog.getByRole('button', { name: 'Approve this quote', exact: true })).toHaveCount(
    0,
  );
  expect(app.requests.approvals).toEqual([]);
  await dialog.getByRole('button', { name: 'Save price', exact: true }).click();
  const saved = page.getByRole('region', { name: 'Review quote', exact: true });
  const receipt = saved.getByRole('article', { name: 'Quote receipt', exact: true });
  await expect(saved.getByText('Interior painting', { exact: true })).toBeVisible();
  await expect(saved.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(receipt).toContainText(project);
  await expect(receipt.getByText('Draft total', { exact: true })).toBeVisible();
  await expect(
    receipt.getByRole('heading', { name: 'Project details', exact: true }),
  ).toBeVisible();
  await expect(saved.getByRole('heading', { level: 2 })).toHaveText('Fictional Maya');
  await expect(receipt.getByText('Customer quote', { exact: true })).toHaveCount(0);
  await expect(saved.locator('.quote-total strong')).toHaveText('$275');
  await expect(saved.locator('.quote-assumptions')).toContainText(
    'Furniture protection is included in this project.',
  );
  await expect(saved.locator('.quote-assumptions')).not.toContainText(
    'Owner approval is required before this price is issued.',
  );
  expect(app.rows.find((quote) => quote.id === manualId)?.assumptions).toContain(
    'Owner approval is required before this price is issued.',
  );
  await expect(saved.locator('.quote-lines')).toContainText('Project price');
  const approve = saved.getByRole('button', {
    name: 'Approve this quote',
    exact: true,
  });
  await expect(approve).toBeEnabled();
  await expect(saved.locator('.button-primary:visible:not([disabled])')).toHaveCount(1);
  expect(app.requests.approvals).toEqual([]);
  expect(app.requests.revisions).toEqual([
    {
      totalCents: 27500,
      reason: 'Wall preparation and protecting furniture are included.',
    },
    {
      totalCents: 27500,
      reason: 'Wall preparation and protecting furniture are included.',
    },
  ]);
  await approve.click();
  await expect(
    page.getByRole('region', { name: 'Quote details', exact: true }).locator('.quote-total strong'),
  ).toHaveText('$275');
  expect(app.requests.approvals).toEqual([manualId]);
  expect(app.rows.find((quote) => quote.id === manualId)?.status).toBe('issued');
  expect(app.requests.unexpected).toEqual([]);
});

test('priced drafts retain their calculation and issued or closed quotes retain their states, including a real zero-price quote', async ({
  page,
}) => {
  const app = await harness(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.getByRole('button', { name: /^All requests 6$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Needs review 2$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Issued 2$/ })).toBeVisible();
  await page.getByRole('button', { name: /^Needs review 2$/ }).click();
  await expect(page.getByRole('button', { name: /^Needs review 2$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'View quote for Fictional Iris', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /^All requests 6$/ }).click();
  await page
    .getByRole('button', {
      name: 'Review quote for Fictional Leo',
      exact: true,
    })
    .click();
  let dialog = page.getByRole('region', { name: 'Review quote', exact: true });
  await expect(dialog.locator('.quote-total strong')).toHaveText('$245');
  await expect(dialog.locator('.quote-lines')).toContainText('Owner adjustment');
  await expect(dialog.locator('.quote-lines').getByText('-$30', { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Approve this quote', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Adjust draft price', exact: true }).click();
  await expect(
    dialog.getByRole('spinbutton', { name: 'Revised quote total ($)', exact: true }),
  ).toHaveValue('245.00');
  await expect(
    dialog.getByRole('textbox', { name: 'Internal reason for the adjustment', exact: true }),
  ).toHaveAttribute('required');
  await dialog.getByRole('button', { name: 'Cancel revision', exact: true }).click();
  await dialog.getByRole('button', { name: 'Back to requests', exact: true }).click();
  for (const item of [
    { name: 'Fictional Iris', amount: '$300', status: 'Issued', closed: false },
    { name: 'Fictional Noah', amount: '$180', status: 'Accepted', closed: true },
    { name: 'Fictional Zoe', amount: '$220', status: 'Declined', closed: true },
    { name: 'Fictional Warranty', amount: '$0', status: 'Issued', closed: false },
  ]) {
    await page.getByRole('button', { name: `View quote for ${item.name}`, exact: true }).click();
    dialog = page.getByRole('region', { name: 'Quote details', exact: true });
    const receipt = dialog.getByRole('article', { name: 'Quote receipt', exact: true });
    await expect(dialog.getByText('Interior painting', { exact: true })).toBeVisible();
    await expect(dialog.getByText(item.status, { exact: true })).toBeVisible();
    await expect(receipt.getByText('Approved total', { exact: true })).toBeVisible();
    await expect(receipt).toContainText(
      app.rows.find((quote) => quote.customerName === item.name)!.description,
    );
    await expect(
      receipt.getByRole('heading', { name: 'Project details', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(item.name);
    await expect(receipt.getByText('Customer quote', { exact: true })).toHaveCount(0);
    await expect(dialog.locator('.quote-total strong')).toHaveText(item.amount);
    if (item.name === 'Fictional Iris') {
      await expect(dialog.getByText('Issued automatically.', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Approved by you.', { exact: false })).toHaveCount(0);
    }
    if (item.name === 'Fictional Noah')
      await expect(
        receipt.getByText('The customer accepted this quote.', { exact: true }),
      ).toBeVisible();
    if (item.name === 'Fictional Zoe')
      await expect(
        receipt.getByText('The customer declined this quote.', { exact: true }),
      ).toBeVisible();
    if (item.name === 'Fictional Warranty')
      await expect(receipt.getByText('Issued by your business.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Price needed', { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Approve this quote', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Adjust draft price', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('textbox', { name: 'Reply directly to the customer', exact: true }),
    ).toHaveCount(item.closed ? 0 : 1);
    await expect(dialog.getByRole('button', { name: 'Accept quote', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Back to requests', exact: true }).click();
  }
  expect(app.requests.revisions).toEqual([]);
  expect(app.requests.approvals).toEqual([]);
  expect(app.requests.replies).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('an explicit zero price is saved with a private reason and still needs a separate owner approval', async ({
  page,
}) => {
  const app = await harness(page, { failPriceSave: false });
  await page
    .getByRole('button', { name: 'Review request for Fictional Maya', exact: true })
    .click();
  let dialog = page.getByRole('region', { name: 'Review request', exact: true });
  await expect(dialog.getByRole('button', { name: 'Approve this quote', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: 'Set a price', exact: true }).click();
  const price = dialog.getByRole('spinbutton', { name: 'Quote total ($)', exact: true });
  await expect(price).toHaveValue('');
  await expect(price).toHaveAttribute('required');
  await expect(price).toHaveAttribute('min', '0');
  await price.fill('0');
  await dialog
    .getByRole('textbox', { name: 'Private reason for this price', exact: true })
    .fill('A warranty visit covered by the original job.');
  await dialog.getByRole('button', { name: 'Save price', exact: true }).click();
  dialog = page.getByRole('region', { name: 'Review quote', exact: true });
  await expect(dialog.locator('.quote-total strong')).toHaveText('$0');
  expect(app.rows.find((quote) => quote.id === manualId)?.manualPriceRequired).toBe(false);
  expect(app.requests.revisions).toEqual([
    { totalCents: 0, reason: 'A warranty visit covered by the original job.' },
  ]);
  expect(app.requests.approvals).toEqual([]);
  const approve = dialog.getByRole('button', { name: 'Approve this quote', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(
    page.getByRole('region', { name: 'Quote details', exact: true }).locator('.quote-total strong'),
  ).toHaveText('$0');
  expect(app.requests.approvals).toEqual([manualId]);
  expect(app.requests.unexpected).toEqual([]);
});

test('the private calculator retains its original test card and never uses the live request receipt', async ({
  page,
}) => {
  const app = await harness(page);
  await page.goto('/dashboard/playground');
  await page.getByRole('spinbutton', { name: 'Quantity (project)', exact: true }).fill('1');
  await page.getByRole('textbox', { name: 'Describe the request', exact: true }).fill(project);
  await page.getByRole('button', { name: 'Calculate a test quote', exact: true }).click();
  const card = page.locator('.quote-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('Private test', { exact: true })).toHaveCount(2);
  await expect(card.getByText('Calculated draft', { exact: true })).toBeVisible();
  await expect(card.locator('.quote-total strong')).toHaveText('$245');
  await expect(
    card.getByText('A private test. No customer delivery or charge.', { exact: true }),
  ).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Draft quote', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Quote receipt', exact: true })).toHaveCount(0);
  expect(app.requests.calculations).toHaveLength(1);
  expect(app.requests.revisions).toEqual([]);
  expect(app.requests.approvals).toEqual([]);
  expect(app.requests.replies).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});
