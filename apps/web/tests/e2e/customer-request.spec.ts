import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const slug = 'fictional-customer-request-test';
const createdAt = '2026-10-28T12:00:00.000Z';

async function customerHarness(
  page: Page,
  mode: 'review' | 'automatic' = 'review',
  requiredInputs = ['location', 'rooms', 'surface_condition'],
  options: {
    fresh?: boolean;
    multiple?: boolean;
    persona?: 'repair' | 'photographer';
    unitLabel?: string;
    collectedInputs?: Record<string, string>;
    customerMessage?: string;
    pricingQuantityRequired?: boolean;
  } = {},
) {
  const service = {
    id: '41000000-0000-4000-8000-000000000001',
    businessId: '41000000-0000-4000-8000-000000000002',
    name:
      options.persona === 'repair'
        ? 'Wall repair'
        : options.persona === 'photographer'
          ? 'Portrait photography'
          : 'House painting',
    description:
      options.persona === 'repair'
        ? 'Review wall damage before deciding whether a visit or price is possible.'
        : options.persona === 'photographer'
          ? 'Family portrait enquiries with the date and scope confirmed by the photographer.'
          : 'Interior wall painting.',
    unitLabel: options.unitLabel || (options.persona === 'photographer' ? 'session' : 'room'),
    unitPriceCents: mode === 'automatic' ? 20000 : 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: mode === 'automatic' ? 100000 : 0,
    requiredInputs: requiredInputs.filter((field) => field !== 'location'),
    exclusions: [],
    mode,
    pricingQuantityRequired: options.pricingQuantityRequired ?? mode === 'automatic',
    publishedAt: createdAt,
    version: 1,
    pricingRules: [],
  };
  const session = {
    id: '41000000-0000-4000-8000-000000000003',
    serviceId: service.id,
    serviceVersion: service.version,
    source: 'live',
    quoteMode: mode,
    pricingQuantityRequired: service.pricingQuantityRequired,
    requiredInputs,
    status: 'active',
    contact: { verified: false } as { verified: boolean; email?: string },
    collectedInputs:
      options.collectedInputs ||
      ((options.persona === 'photographer'
        ? { location: 'Austin', session_type: 'Family portraits' }
        : { location: 'Austin', rooms: 'Two bedrooms' }) as Record<string, string>),
    missingInputs: options.persona === 'photographer' ? ['shoot_date'] : ['surface_condition'],
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content:
          options.persona === 'repair'
            ? 'Tell us what needs repairing.'
            : options.persona === 'photographer'
              ? 'Tell us about your photography request.'
              : 'Tell us what needs painting.',
        createdAt,
      },
      {
        id: 'm2',
        role: 'user',
        content:
          options.customerMessage ||
          (options.persona === 'repair'
            ? 'Two bedrooms have wall cracks in Austin. I don’t know whether they are surface damage.'
            : options.persona === 'photographer'
              ? 'I would like family portraits in Austin. I do not know the date yet.'
              : 'Please repaint the bedroom walls white in Austin. I don’t know the measurements.'),
        createdAt,
      },
      {
        id: 'm3',
        role: 'assistant',
        content:
          'The business can confirm the measurements. You can send the request when you’re ready.',
        createdAt,
      },
    ],
    quote: undefined as Record<string, unknown> | undefined,
  };
  const requests = {
    submitted: [] as Record<string, unknown>[],
    posts: [] as string[],
    starts: 0,
    messages: [] as string[],
    startDelay: 0,
    uploadDelay: 0,
    uploadAttempts: 0,
    failedUploads: 0,
    restoredPhoto: false,
    codes: 0,
    verified: 0,
    unexpected: [] as string[],
  };
  let failQuote = false;
  const profile = {
    business: {
      name:
        options.persona === 'repair'
          ? 'Fictional Home Repairs'
          : options.persona === 'photographer'
            ? 'Fictional Portrait Photography'
            : 'Fictional House Painting',
      slug,
      description: '',
      serviceArea: 'Austin',
      currency: 'USD',
    },
    services: options.multiple
      ? [
          service,
          { ...service, id: '41000000-0000-4000-8000-000000000005', name: 'Move-out cleaning' },
        ]
      : [service],
  };
  if (options.fresh) {
    session.messages = [session.messages[0]];
    session.collectedInputs = {};
  }
  const persistedPhotos: { id: string; filename: string; previewDataUrl: string }[] = [];
  const photo = await readFile(path.resolve('tests/e2e/fixtures/project-photo.png'));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST') requests.posts.push(pathname);
    if (request.method() === 'GET' && pathname === `/api/v1/public/${slug}`)
      return route.fulfill({
        json: {
          data: {
            ...profile,
            services: profile.services.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.description,
              unitLabel: item.unitLabel,
              requiredInputs,
              exclusions: item.exclusions,
              mode: item.mode,
              pricingQuantityRequired: item.pricingQuantityRequired,
              publishedAt: item.publishedAt,
            })),
          },
        },
      });
    if (request.method() === 'POST' && pathname === `/api/v1/public/${slug}/sessions`) {
      requests.starts++;
      if (requests.startDelay)
        await new Promise((resolve) => setTimeout(resolve, requests.startDelay));
      session.serviceId = request.postDataJSON().serviceId;
      return route.fulfill({ json: { data: { token: 'c'.repeat(43), session } } });
    }
    const base = `/api/v1/public/${slug}/sessions/${session.id}`;
    if (request.method() === 'GET' && pathname === base)
      return route.fulfill({ json: { data: session } });
    if (request.method() === 'GET' && pathname === `${base}/uploads`) {
      if (requests.restoredPhoto) await new Promise((resolve) => setTimeout(resolve, 100));
      return route.fulfill({
        json: {
          data: requests.restoredPhoto
            ? [
                {
                  id: 'fixture-photo',
                  filename: 'fictional-project.png',
                  previewDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
                },
              ]
            : persistedPhotos,
        },
      });
    }
    if (request.method() === 'POST' && pathname === `${base}/messages`) {
      const { content } = request.postDataJSON();
      requests.messages.push(content);
      session.messages.push(
        { id: 'sent-message', role: 'user', content, createdAt },
        {
          id: 'reply-message',
          role: 'assistant',
          content: 'The business can confirm the measurements. What needs painting?',
          createdAt,
        },
      );
      return route.fulfill({ json: { data: { session } } });
    }
    if (request.method() === 'POST' && pathname === `${base}/uploads`) {
      requests.uploadAttempts++;
      if (requests.uploadDelay)
        await new Promise((resolve) => setTimeout(resolve, requests.uploadDelay));
      if (requests.failedUploads > 0) {
        requests.failedUploads--;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'The photo could not be added. Please try again.' } },
        });
      }
      expect(request.headers()['content-type']).toContain('multipart/form-data');
      const upload = {
        id: 'uploaded-photo',
        filename: 'fictional-project.png',
        previewDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
      };
      persistedPhotos.push(upload);
      return route.fulfill({ json: { data: upload } });
    }
    if (request.method() === 'POST' && pathname === `${base}/verification`) {
      requests.codes++;
      return route.fulfill({
        json: {
          data: { verificationId: 'fictional-verification', delivery: 'local', devCode: '654321' },
        },
      });
    }
    if (request.method() === 'POST' && pathname === `${base}/verify-contact`) {
      requests.verified++;
      expect(request.postDataJSON().code).toBe('654321');
      session.contact = { verified: true, email: 'taylor@example.test' };
      return route.fulfill({
        json: { data: { email: 'taylor@example.test', verifiedAt: createdAt } },
      });
    }
    if (request.method() === 'POST' && pathname === `${base}/quote`) {
      if (failQuote) {
        failQuote = false;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'The request could not be sent. Please try again.' } },
        });
      }
      const payload = request.postDataJSON();
      requests.submitted.push(payload);
      session.status = 'submitted';
      session.quote = {
        id: '41000000-0000-4000-8000-000000000004',
        serviceId: service.id,
        customerName: payload.customerName,
        customerEmail: payload.customerEmail,
        status: 'review',
        description: payload.description,
        quantity: payload.quantity,
        totalCents: 0,
        currency: 'USD',
        assumptions: ['An internal pricing detail needs owner confirmation.'],
        lineItems: [],
        createdAt,
        reviewReason: 'INTERNAL REVIEW DETAILS: measurement, policy, contact, pricing.',
        manualPriceRequired: true,
      };
      return route.fulfill({ json: { data: session.quote } });
    }
    requests.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected fictional test request.' } },
    });
  });
  await page.goto(`/q/${slug}`);
  if (!options.fresh) {
    await page.evaluate(
      ({ slug, sessionId, serviceId }) =>
        localStorage.setItem(
          `quotient:${slug}`,
          JSON.stringify({ id: sessionId, token: 'c'.repeat(43), serviceId }),
        ),
      { slug, sessionId: session.id, serviceId: service.id },
    );
    await page.reload();
    await expect(page.getByLabel('Tell us about your project', { exact: true })).toBeVisible();
  }
  return {
    requests,
    session,
    service,
    failNextSubmission: () => {
      failQuote = true;
    },
  };
}

async function openRequest(page: Page) {
  await expect(page.getByRole('button', { name: 'See request summary', exact: true })).toHaveCount(
    0,
  );
  const action = page.getByRole('button', { name: 'Get a quote', exact: true });
  const form = page.locator('.public-request-form');
  await expect(action.or(form)).toBeVisible();
  if (await action.isVisible()) await action.click();
  await expect(form).toBeVisible();
  await expect(
    page
      .locator('.public-chat-header')
      .getByRole('heading', { name: 'Request a quote', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      form.evaluate((element) => {
        const form = element.getBoundingClientRect();
        const body = element.closest('.public-chat-body')!.getBoundingClientRect();
        const contact = element
          .querySelector('input[name="customerName"]')!
          .closest('label')!
          .getBoundingClientRect();
        return (
          form.top >= Math.max(0, body.top) - 2 &&
          contact.top >= Math.max(0, body.top) - 2 &&
          contact.bottom <= Math.min(innerHeight, body.bottom) + 2
        );
      }),
    )
    .toBe(true);
}

test('a repair request reuses known facts and survives Back and reload without restoring consent or codes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, failNextSubmission } = await customerHarness(page, 'review', undefined, {
    persona: 'repair',
  });
  await openRequest(page);
  const form = page.locator('.public-request-form');
  await expect(form.getByLabel(/^Approximate quantity/)).toHaveCount(0);
  await expect(form.locator('input[name^="fact-"]')).toHaveCount(0);
  await expect(
    form.getByRole('button', { name: 'Send verification code', exact: true }),
  ).toBeHidden();
  await expect(form.getByRole('region', { name: 'Your project summary' })).toContainText(
    'Two bedrooms',
  );
  await page.getByLabel(/^Your name/).fill('Fictional Taylor');
  await page.getByLabel(/^Email address/).fill('taylor@example.test');
  await page.getByRole('button', { name: 'Edit project details', exact: true }).click();
  const uncertain = page.getByLabel('I’m not sure about surface condition.', { exact: true });
  await expect(uncertain).toBeChecked();
  await uncertain.uncheck();
  await page.getByLabel(/^Surface condition/).fill('Paint chipped near the door');
  await page.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await page.getByText('Get email updates', { exact: false }).click();
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await page.getByLabel('Email verification code', { exact: true }).fill('654321');
  await page.getByLabel(/I agree to share/).check();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await openRequest(page);
  await expect(page.getByLabel(/^Your name/)).toHaveValue('Fictional Taylor');
  await expect(page.getByLabel(/^Email address/)).toHaveValue('taylor@example.test');
  await expect(form.getByRole('region', { name: 'Your project summary' })).toContainText(
    'Paint chipped near the door',
  );
  await expect(page.getByLabel(/I agree to share/)).not.toBeChecked();
  await expect(page.getByLabel('Email verification code', { exact: true })).toHaveCount(0);
  await page.reload();
  await openRequest(page);
  await expect(page.getByLabel(/^Your name/)).toHaveValue('Fictional Taylor');
  await expect(page.getByLabel(/^Email address/)).toHaveValue('taylor@example.test');
  await expect(page.getByLabel(/I agree to share/)).not.toBeChecked();
  const drafts = await page.evaluate(() =>
    Object.entries(sessionStorage)
      .filter(([key]) => key.includes(':details') || key.includes('request-draft'))
      .map(([, value]) => JSON.parse(value)),
  );
  expect(drafts).toHaveLength(1);
  expect(JSON.stringify(drafts)).not.toContain('654321');
  expect(drafts[0].draft).not.toHaveProperty('contactConsent');
  await page.getByLabel(/I agree to share/).check();
  failNextSubmission();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(
    page.getByText('The request could not be sent. Please try again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Your name/)).toHaveValue('Fictional Taylor');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(sessionStorage).filter(
            (key) => key.includes(':details') || key.includes('request-draft'),
          ).length,
      ),
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  expect(requests.submitted).toHaveLength(1);
  expect(requests.submitted[0]).toMatchObject({
    customerName: 'Fictional Taylor',
    quantityUnknown: true,
    inputs: {
      location: 'Austin',
      rooms: 'Two bedrooms',
      surface_condition: 'Paint chipped near the door',
    },
    contactConsent: true,
  });
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'What you would receive', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('INTERNAL REVIEW DETAILS:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept quote', exact: true })).toHaveCount(0);
  await expect(
    page.getByText('The business will review your request and reply here.', { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(sessionStorage).filter(
            (key) => key.includes(':details') || key.includes('request-draft'),
          ).length,
      ),
    )
    .toBe(0);
  expect(requests.codes).toBe(1);
  expect(requests.verified).toBe(0);
  expect(requests.unexpected).toEqual([]);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('photography intake keeps desired coverage separate from pricing and preserves automatic verification', async ({
  page,
}) => {
  await test.step('review keeps approved facts without duplicating location or billable hours', async () => {
    const reviewPage = await page.context().newPage();
    try {
      await reviewPage.setViewportSize({ width: 390, height: 844 });
      const inputs = {
        'Coverage wanted (hours)': '2 hours',
        'Number of subjects': '2',
        'Desired number of edited photos': '12',
        location: 'Denver',
      };
      const required = [
        'Coverage wanted (hours)',
        'Number of subjects',
        'Location of shoot',
        'Desired number of edited photos',
        'location',
      ];
      const { requests, session, service } = await customerHarness(reviewPage, 'review', required, {
        persona: 'photographer',
        unitLabel: 'hour',
        collectedInputs: inputs,
        customerMessage:
          'I’d like birthday portraits in Denver for 2 people, with 2 hours of coverage and about 12 edited photos.',
      });
      await openRequest(reviewPage);
      const form = reviewPage.locator('.public-request-form');
      const summary = form.getByRole('region', { name: 'Your project summary' });
      await expect(summary.locator('dt').filter({ hasText: /^City or area$/ })).toHaveCount(1);
      await expect(summary).toContainText('The business can confirm: Location of shoot.');
      await expect(summary.getByText('2 hour', { exact: true })).toHaveCount(0);
      await expect(summary.getByText('Measurement:', { exact: false })).toHaveCount(0);
      await expect(form.getByLabel(/^Approximate quantity/)).toHaveCount(0);
      await reviewPage.getByRole('button', { name: 'Edit project details', exact: true }).click();
      await expect(
        form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
      ).toHaveCount(0);
      await expect(form.getByLabel(/^Coverage wanted \(hours\)/)).toHaveValue('2 hours');
      await form.getByLabel('I’m not sure about coverage wanted (hours).', { exact: true }).check();
      await expect(
        form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
      ).toBeChecked();
      await form
        .getByLabel('I’m not sure about coverage wanted (hours).', { exact: true })
        .uncheck();
      await expect(
        form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
      ).toHaveCount(0);
      await expect(form.getByLabel(/^City or area/)).toHaveValue('Denver');
      await form.getByLabel('I’m not sure about location of shoot.', { exact: true }).uncheck();
      await form.getByLabel(/^Location of shoot/).fill('Denver');
      await reviewPage.getByRole('button', { name: 'Done editing details', exact: true }).click();
      await expect(summary.locator('dt').filter({ hasText: /^City or area$/ })).toHaveCount(0);
      await expect(summary.locator('dt').filter({ hasText: /^Location of shoot$/ })).toHaveCount(1);
      await expect(summary.locator('dd').filter({ hasText: /^Denver$/ })).toHaveCount(1);
      await reviewPage.getByRole('button', { name: 'Edit project details', exact: true }).click();
      await expect(form.getByLabel(/^City or area/)).toHaveValue('Denver');
      await expect(form.getByLabel(/^Location of shoot/)).toHaveValue('Denver');
      await form.getByLabel(/^Location of shoot/).fill('A studio near Union Station');
      await reviewPage.getByRole('button', { name: 'Done editing details', exact: true }).click();
      await expect(summary.locator('dt').filter({ hasText: /^City or area$/ })).toHaveCount(1);
      await expect(summary).toContainText('A studio near Union Station');

      // A configured review price still requires the existing pricing quantity confirmation.
      service.unitPriceCents = 9000;
      service.pricingQuantityRequired = true;
      session.pricingQuantityRequired = true;
      await reviewPage.reload();
      await openRequest(reviewPage);
      await expect(summary.getByText('2 hour', { exact: true })).toBeVisible();
      await reviewPage.getByRole('button', { name: 'Edit project details', exact: true }).click();
      await expect(form.getByLabel(/^Approximate quantity/)).toHaveValue('2');
      service.unitPriceCents = 0;
      service.pricingQuantityRequired = false;
      session.pricingQuantityRequired = false;

      // Without a matching coverage unit, keep the customer's explicit uncertainty control.
      service.unitLabel = 'project';
      await reviewPage.reload();
      await openRequest(reviewPage);
      await reviewPage.getByRole('button', { name: 'Edit project details', exact: true }).click();
      await expect(
        form.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
      ).toBeChecked();
      await expect(form.getByLabel(/^Approximate quantity/)).toHaveCount(0);

      // A quantity explicitly entered in an earlier draft must survive the narrower default.
      await form.getByLabel('I don’t know the quantity or measurement.', { exact: true }).uncheck();
      await form.getByLabel(/^Approximate quantity/).fill('3');
      await expect
        .poll(() =>
          reviewPage.evaluate(() =>
            Object.values(sessionStorage).some((value) => {
              try {
                const saved = JSON.parse(value);
                return saved.draft?.quantityEdited && saved.draft.quantity === '3';
              } catch {
                return false;
              }
            }),
          ),
        )
        .toBe(true);
      service.unitLabel = 'hour';
      await reviewPage.reload();
      await openRequest(reviewPage);
      await expect(summary.getByText('3 hour', { exact: true })).toBeVisible();
      await reviewPage.getByRole('button', { name: 'Edit project details', exact: true }).click();
      await expect(form.getByLabel(/^Approximate quantity/)).toHaveValue('3');

      // A new unconfigured-review draft keeps desired coverage solely as an intake answer.
      await reviewPage.evaluate(() => sessionStorage.clear());
      session.collectedInputs['Location of shoot'] = 'Denver';
      await reviewPage.reload();
      await openRequest(reviewPage);
      await expect(summary.getByText('2 hour', { exact: true })).toHaveCount(0);
      await expect(summary.locator('dd').filter({ hasText: /^Denver$/ })).toHaveCount(1);
      await reviewPage.getByLabel(/^Your name/).fill('Fictional Photography Customer');
      await reviewPage.getByLabel(/^Email address/).fill('photography-customer@example.test');
      await reviewPage.getByLabel(/I agree to share/).check();
      await reviewPage.getByRole('button', { name: 'Send request', exact: true }).click();
      await expect(
        reviewPage.getByRole('heading', { name: 'Request sent', exact: true }),
      ).toBeVisible();
      expect(requests.submitted).toHaveLength(1);
      expect(requests.submitted[0]).toMatchObject({
        quantity: 1,
        quantityUnknown: true,
        inputs: { ...inputs, 'Location of shoot': 'Denver' },
      });
      expect(requests.codes).toBe(0);
      expect(requests.messages).toEqual([]);
      expect(requests.unexpected).toEqual([]);
    } finally {
      await reviewPage.close();
    }
  });

  const { requests } = await customerHarness(
    page,
    'automatic',
    ['location', 'session_type', 'shoot_date', 'Coverage wanted (hours)'],
    {
      persona: 'photographer',
      unitLabel: 'hour',
      collectedInputs: {
        location: 'Austin',
        session_type: 'Family portraits',
        'Coverage wanted (hours)': '2 hours',
      },
      customerMessage:
        'I would like family portraits in Austin with 2 hours of coverage. I do not know the date yet.',
    },
  );
  await openRequest(page);
  await page.getByLabel(/^Your name/).fill('Fictional Taylor');
  await page.getByLabel(/^Email address/).fill('taylor@example.test');
  await expect(
    page.getByRole('button', { name: 'Send verification code', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.public-request-form input[name="fact-0"]')).toHaveCount(0);
  await expect(page.locator('.public-request-form input[name="fact-1"]')).toHaveCount(0);
  await expect(page.getByLabel(/^Approximate quantity \(hour\)/)).toHaveValue('2');
  await expect(
    page.getByLabel('I don’t know the quantity or measurement.', { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('I’m not sure about shoot date.', { exact: true }).check();
  await page.getByLabel(/I don.t know the quantity or measurement/).check();
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await page.getByLabel('Email verification code', { exact: true }).fill('654321');
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByText('Email verified for this request.', { exact: true })).toBeVisible();
  await page.getByLabel(/I agree to share/).check();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  expect(requests.submitted[0]).toMatchObject({
    quantityUnknown: true,
    inputs: { shoot_date: 'unknown' },
  });
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept quote', exact: true })).toHaveCount(0);
  await expect(page.getByText('INTERNAL REVIEW DETAILS:', { exact: false })).toHaveCount(0);
  expect(requests.verified).toBe(1);
  expect(requests.unexpected).toEqual([]);
});

test('contact drafts from a different inquiry or private preview are not reused', async ({
  page,
}) => {
  await page.addInitScript(
    ({ slug }) => {
      const old = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        draft: {
          name: 'Private Previous Customer',
          email: 'previous@example.test',
          description: 'An unrelated private project.',
          inputs: {},
          unsureFields: [],
          quantity: '5',
          quantityUnknown: false,
          editedInputs: [],
          descriptionEdited: true,
          quantityEdited: true,
        },
      });
      sessionStorage.setItem(`quotient:${slug}:draft:previous-inquiry:details`, old);
      sessionStorage.setItem(
        `quotient:playground:${slug}:draft:41000000-0000-4000-8000-000000000003:details`,
        old,
      );
    },
    { slug },
  );
  await customerHarness(page, 'review', ['surface_condition']);
  await openRequest(page);
  await expect(page.getByLabel(/^Your name/)).toHaveValue('');
  await expect(page.getByLabel(/^Email address/)).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Your project summary' })).not.toContainText(
    'An unrelated private project.',
  );
  await page.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(page.getByLabel(/^City or area/)).toHaveCount(0);
  await expect(page.getByLabel('I’m not sure about city or area.', { exact: true })).toHaveCount(0);
});

test('a private request link restores the quote in view after its photo loads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, session } = await customerHarness(page);
  await openRequest(page);
  await page.getByLabel(/^Your name/).fill('Fictional Return Customer');
  await page.getByLabel(/^Email address/).fill('return-customer@example.test');
  await page.getByLabel(/I agree to share/).check();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  requests.restoredPhoto = true;
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('about:blank');
  await page.goto(`/q/${slug}#session=${session.id}&token=${'c'.repeat(43)}`);
  const photo = page.getByRole('img', {
    name: 'Project photo: fictional-project.png',
    exact: true,
  });
  await expect(photo).toBeVisible();
  await photo.evaluate((image: HTMLImageElement) => image.decode());
  const heading = page.getByRole('heading', { name: 'Request sent', exact: true });
  await expect
    .poll(() =>
      heading.evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          body = element.closest('.public-chat-body')!.getBoundingClientRect();
        return (
          rect.top >= Math.max(0, body.top) - 2 &&
          rect.bottom <= Math.min(innerHeight, body.bottom) + 2
        );
      }),
    )
    .toBe(true);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 480 });
  await expect
    .poll(() =>
      page
        .locator('.public-chat-body')
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThanOrEqual(100);
  await expect
    .poll(() =>
      page.locator('.public-composer').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight + 2;
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(requests.unexpected).toEqual([]);
});

test('single-service entry keeps an idle draft without POSTs and first Send creates one inquiry and one reply', async ({
  page,
}) => {
  const { requests } = await customerHarness(page, 'review', undefined, { fresh: true });
  const composer = page.getByLabel('Tell us about your project', { exact: true });
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', { name: 'House painting', exact: true })).toHaveCount(0);
  expect(requests.posts).toEqual([]);
  expect(requests.starts).toBe(0);
  expect(requests.messages).toHaveLength(0);
  await composer.fill('Please paint two bedroom walls white.');
  await page.reload();
  await expect(composer).toHaveValue('Please paint two bedroom walls white.');
  expect(requests.posts).toEqual([]);
  expect(requests.starts).toBe(0);
  expect(requests.messages).toHaveLength(0);
  requests.startDelay = 150;
  await page.locator('form.public-composer').evaluate((form) => {
    for (let i = 0; i < 2; i++)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(
    page.getByText('The business can confirm the measurements. What needs painting?', {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.starts).toBe(1);
  expect(requests.posts).toHaveLength(2);
  expect(requests.messages).toEqual(['Please paint two bedroom walls white.']);
  await expect(composer).toHaveValue('');
  await page.reload();
  await expect(composer).toHaveValue('');
  expect(requests.starts).toBe(1);
  expect(requests.messages).toHaveLength(1);
  expect(requests.unexpected).toEqual([]);
});

test('the first photo creates only a free inquiry and can retry failed bytes without losing the project draft', async ({
  page,
}) => {
  const { requests } = await customerHarness(page, 'review', undefined, { fresh: true });
  const composer = page.getByLabel('Tell us about your project', { exact: true });
  await composer.fill('Please confirm the measurements from this room photo.');
  requests.startDelay = 100;
  requests.uploadDelay = 150;
  requests.failedUploads = 1;
  await page
    .locator('input[type=file]')
    .setInputFiles(path.resolve('tests/e2e/fixtures/project-photo.png'));
  await expect(page.getByRole('button', { name: 'Get a quote', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(
    page.getByText('The photo could not be added. Please try again.', { exact: false }),
  ).toBeVisible();
  await expect(composer).toHaveValue('Please confirm the measurements from this room photo.');
  expect(requests.starts).toBe(1);
  expect(requests.uploadAttempts).toBe(1);
  expect(requests.messages).toHaveLength(0);
  await page.getByRole('button', { name: 'Try photo again', exact: true }).click();
  const image = page.getByRole('img', {
    name: 'Project photo: fictional-project.png',
    exact: true,
  });
  await expect(image).toBeVisible();
  await image.evaluate((element: HTMLImageElement) => element.decode());
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const photo = element.getBoundingClientRect(),
          body = element.closest('.public-chat-body')!.getBoundingClientRect();
        return photo.top >= body.top - 2 && photo.bottom <= body.bottom + 2;
      }),
    )
    .toBe(true);
  expect(requests.starts).toBe(1);
  expect(requests.uploadAttempts).toBe(2);
  expect(requests.messages).toHaveLength(0);
  await page.reload();
  await expect(composer).toHaveValue('Please confirm the measurements from this room photo.');
  await expect(image).toBeVisible();
  expect(requests.starts).toBe(1);
  expect(requests.uploadAttempts).toBe(2);
  expect(requests.messages).toHaveLength(0);
  expect(requests.unexpected).toEqual([]);
});

test('Get a quote starts a free inquiry and carries the unsent project into confirmation without an AI reply', async ({
  page,
}) => {
  const { requests } = await customerHarness(page, 'review', undefined, { fresh: true });
  const composer = page.getByLabel('Tell us about your project', { exact: true });
  await composer.fill('Please repaint the hallway walls. I do not know the measurements.');
  await openRequest(page);
  await expect(page.getByRole('region', { name: 'Your project summary' })).toContainText(
    'Please repaint the hallway walls.',
  );
  expect(requests.starts).toBe(1);
  expect(requests.messages).toHaveLength(0);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer).toHaveValue(
    'Please repaint the hallway walls. I do not know the measurements.',
  );
  await openRequest(page);
  expect(requests.starts).toBe(1);
  expect(requests.messages).toHaveLength(0);
  expect(requests.unexpected).toEqual([]);
});

test('an empty direct request exposes its required description and preserves one inquiry through editing and reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { requests, session } = await customerHarness(page, 'review', undefined, { fresh: true });
  await openRequest(page);
  const form = page.locator('.public-request-form');
  const summary = form.getByRole('region', { name: 'Your project summary', exact: true });
  const description = form.getByRole('textbox', { name: 'Project description', exact: true });
  await expect(description).toHaveCount(1);
  await expect(
    summary.getByRole('textbox', { name: 'Project description', exact: true }),
  ).toHaveValue('');
  await expect(form.locator('input[name^="fact-"]')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  expect(requests.starts).toBe(1);
  expect(requests.messages).toEqual([]);
  expect(requests.submitted).toEqual([]);

  const originalEditor = await description.elementHandle();
  if (!originalEditor) throw new Error('The required description editor was not rendered.');
  const sameEditor = async () => {
    await expect(description).toHaveCount(1);
    expect(
      await originalEditor.evaluate(
        (node) =>
          node.isConnected && node === document.querySelector('textarea[name="description"]'),
      ),
    ).toBe(true);
    await expect(
      summary.getByRole('textbox', { name: 'Project description', exact: true }),
    ).toHaveCount(1);
  };
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await sameEditor();
  await form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await sameEditor();

  const note = 'Please repaint the bedroom walls white and protect the furniture.';
  await description.focus();
  await description.pressSequentially(note, { delay: 0 });
  await expect(description).toHaveValue(note);
  await expect(description).toBeFocused();
  await sameEditor();
  await expect(summary.locator('p').filter({ hasText: note })).toHaveCount(0);
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await sameEditor();
  await form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  await expect(description).toHaveCount(0);
  await expect(summary.locator('p').filter({ hasText: note })).toHaveCount(1);
  await originalEditor.dispose();

  await form.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Rowan');
  await form
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('rowan@example.test');
  await form.getByLabel(/I agree to share/).check();
  await form.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveValue('');
  await openRequest(page);
  await expect(summary.locator('p').filter({ hasText: note })).toHaveCount(1);
  await expect(description).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: 'Your name', exact: true })).toHaveValue(
    'Fictional Rowan',
  );
  await expect(form.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue(
    'rowan@example.test',
  );
  await expect(form.getByLabel(/I agree to share/)).not.toBeChecked();
  await page.reload();
  await openRequest(page);
  await expect(summary.locator('p').filter({ hasText: note })).toHaveCount(1);
  await expect(description).toHaveCount(0);
  await expect(form.getByLabel(/I agree to share/)).not.toBeChecked();
  await form.getByRole('button', { name: 'Edit project details', exact: true }).click();
  await expect(description).toHaveValue(note);
  await form.getByRole('button', { name: 'Done editing details', exact: true }).click();
  expect(requests.starts).toBe(1);
  expect(requests.messages).toEqual([]);
  expect(requests.submitted).toEqual([]);

  await form.getByLabel(/I agree to share/).check();
  await form.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  expect(requests.submitted).toEqual([
    {
      customerName: 'Fictional Rowan',
      customerEmail: 'rowan@example.test',
      description: note,
      quantity: 1,
      quantityUnknown: true,
      inputs: { location: 'unknown', rooms: 'unknown', surface_condition: 'unknown' },
      contactConsent: true,
    },
  ]);
  expect(requests.posts).toEqual([
    `/api/v1/public/${slug}/sessions`,
    `/api/v1/public/${slug}/sessions/${session.id}/quote`,
  ]);
  expect(requests.codes).toBe(0);
  expect(requests.verified).toBe(0);
  expect(requests.messages).toEqual([]);
  expect(requests.starts).toBe(1);
  expect(requests.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.locator('.public-final-price')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept quote', exact: true })).toHaveCount(0);
});

test('multiple services retain an explicit chooser and selection makes no AI request', async ({
  page,
}) => {
  const { requests } = await customerHarness(page, 'review', undefined, {
    fresh: true,
    multiple: true,
  });
  await expect(page.getByRole('button', { name: 'House painting', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move-out cleaning', exact: true })).toBeVisible();
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveCount(0);
  expect(requests.starts).toBe(0);
  await page.getByRole('button', { name: 'House painting', exact: true }).click();
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toBeVisible();
  expect(requests.starts).toBe(1);
  expect(requests.messages).toHaveLength(0);
  expect(requests.unexpected).toEqual([]);
});
