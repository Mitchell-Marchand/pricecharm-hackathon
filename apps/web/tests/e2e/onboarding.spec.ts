import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const photo = path.resolve('public/photos/patio-overview.jpg');

async function finishStepOne(page: Page, name: string) {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/business$/);
  await page.getByRole('radio', { name: 'Pressure washing' }).click();
  await page.getByLabel('Business name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/jobs$/);
}

test('the landing page leads into setup', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: 'Train an AI to produce real quotes for you in 3 easy steps.',
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Get started' }).first().click();
  await expect(page).toHaveURL(/\/start\/business$/);
  await expect(
    page.getByRole('heading', { name: 'What kind of business do you run?' }),
  ).toBeVisible();
});

test('step 1 saves the trade, services and business details as you go', async ({ page }) => {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/business$/);
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  await page.getByRole('radio', { name: 'Window cleaning' }).click();
  await expect(page.getByRole('button', { name: 'Exterior windows' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Skylights' }).click();
  await page.getByPlaceholder('Add a service').fill('Solar panels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Business name').fill('Clearview Windows');
  await page.getByLabel('Where do you work?').fill('Boise, ID');
  await page.getByLabel(/How far you.ll travel/).selectOption('50');
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Business name')).toHaveValue('Clearview Windows');
  await expect(page.getByLabel('Where do you work?')).toHaveValue('Boise, ID');
  await expect(page.getByLabel(/How far you.ll travel/)).toHaveValue('50');
  for (const service of ['Exterior windows', 'Skylights', 'Solar panels'])
    await expect(page.getByRole('button', { name: service })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

  await next.click();
  await expect(page).toHaveURL(/\/start\/jobs$/);
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/jobs$/, { timeout: 15_000 });
});

test('the public pages render without sideways scrolling on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/pricing', '/privacy', '/terms']) {
    await page.goto(path);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      path,
    ).toBe(false);
  }
  await page.goto('/pricing');
  const pricing = (await (await page.request.get('/api/v1/pricing')).json()).data;
  await expect(page.getByText(`${pricing.trialQuotes} quotes free`)).toBeVisible();
  await page.goto('/privacy');
  const site = (await (await page.request.get('/api/v1/site')).json()).data;
  await expect(page.locator('#contact')).toContainText(site.operatorName);
});

test('step 2 saves past jobs with photos, and edits and removes them', async ({ page }) => {
  await finishStepOne(page, 'Moss & Stone Exterior Care');
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: 'Add a job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await sheet.locator('input[type=file]').setInputFiles(photo);
  await expect(sheet.getByRole('img', { name: 'Job photo 1' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Patios & pavers' }).click();
  await sheet.getByLabel('What was the job?').fill('Back patio and walkway, about 600 sq ft.');
  await sheet.getByLabel('What did you charge?').fill('275');
  await sheet.getByRole('button', { name: 'More details' }).click();
  await sheet.getByLabel('How big was it?').fill('600 sq ft');
  await sheet.getByLabel('Discount amount').fill('25');
  await sheet.getByPlaceholder('Why? For example: repeat customer').fill('Repeat customer');
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(sheet).toBeHidden();

  const card = page.getByRole('listitem').filter({ hasText: 'Back patio and walkway' });
  await expect(card).toContainText('$275');
  await expect(card).toContainText('Patios & pavers · 600 sq ft');
  await expect(card).toContainText('$25 off, repeat customer');
  await expect(card.locator('img')).toBeVisible();
  await expect(next).toBeEnabled();

  await page.reload();
  await card.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit job' });
  await edit.getByLabel('What did you charge?').fill('290');
  await edit.getByRole('button', { name: 'Remove photo 1' }).click();
  await edit.getByRole('button', { name: 'Save job' }).click();
  await expect(card).toContainText('$290');
  await expect(card).toContainText('No photos');

  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Start with a job you remember well')).toBeVisible();
});

test('an uploaded invoice fills in a job for the owner to check', async ({ page }) => {
  await finishStepOne(page, 'Driveway Pros');
  await page.getByRole('button', { name: 'Upload an old quote or invoice' }).click();
  await page
    .getByRole('dialog', { name: 'Upload a quote or invoice' })
    .locator('input[type=file]')
    .setInputFiles({
      name: 'invoice-1187.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fixture'),
    });
  const check = page.getByRole('dialog', { name: 'Check this job' });
  await expect(check).toContainText('We filled this in from invoice-1187.pdf');
  await expect(check.getByLabel('What did you charge?')).toHaveValue('320');
  await check.getByRole('button', { name: 'Save job' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Driveway wash' })).toContainText(
    '$20 off, repeat customer',
  );
});

test('step 3 runs three practice customers and learns from each one', async ({ page }) => {
  await finishStepOne(page, 'Moss & Stone Exterior Care');
  const created = await page.request.post('/api/v1/onboarding/jobs', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      serviceName: 'Driveways',
      description: 'Back patio and walkway, about 600 sq ft.',
      priceCents: 27500,
      size: '600 sq ft',
    },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/practice$/);

  const quote = async (label: string, price: string) => {
    await page.getByRole('button', { name: 'Create quote' }).click();
    const builder = page.getByRole('dialog', { name: /^Quote for / });
    await builder.getByRole('textbox', { name: 'Item 1', exact: true }).fill(label);
    await builder.getByRole('textbox', { name: 'Price for item 1' }).fill(price);
    await builder.getByRole('button', { name: 'Send quote' }).click();
    await expect(page.getByRole('heading', { name: /Here.s what your AI picked up/ })).toBeVisible({
      timeout: 15_000,
    });
  };

  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 15_000 });
  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('How big is the patio?');
  await reply.press('Enter');
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible();
  await quote('Patio wash, about 550 sq ft', '280');
  await expect(page.getByText('Asks about size')).toBeVisible();
  await expect(page.getByText(/Before you sent yours, it guessed \$/)).toBeVisible();
  await page.getByRole('button', { name: 'Fix' }).first().click();
  await page.getByLabel('Correct this').fill('Asks about size and stains');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Asks about size and stains')).toBeVisible();

  await page.getByRole('button', { name: 'Next practice request' }).click();
  await expect(page.getByText('Marcus T. · North Hills')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /I.d need to see it first|Visit first/ }).click();
  const visit = page.getByRole('dialog', { name: 'Ask for a site visit' });
  await visit.getByLabel('What do you need to check?').fill('How green it is by the planters.');
  await visit.getByRole('button', { name: 'Send to Marcus' }).click();
  await expect(page.getByText(/Asks to see jobs like this first/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Next practice request' }).click();
  await expect(page.getByText('Priya S. · Old Town')).toBeVisible({ timeout: 15_000 });
  await quote('Flagstone wash, about 350 sq ft', '175');
  await expect(page.getByText(/It would also have asked to see this one first/)).toBeVisible();
  await page.getByRole('button', { name: 'See what your AI learned' }).click();
  await expect(page).toHaveURL(/\/start\/ready$/);
});
