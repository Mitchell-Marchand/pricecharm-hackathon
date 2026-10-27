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
  for (const path of ['/', '/demo', '/pricing', '/privacy', '/terms']) {
    await page.goto(path);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      path,
    ).toBe(false);
  }
  await page.goto('/pricing');
  const pricing = (await (await page.request.get('/api/v1/pricing')).json()).data;
  await expect(
    page.getByText(`$${pricing.perQuoteCents / 100} per quote`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`${pricing.accepted.basisPoints / 100}% when they say yes`),
  ).toBeVisible();
  await page.goto('/privacy');
  const site = (await (await page.request.get('/api/v1/site')).json()).data;
  await expect(page.locator('#contact')).toContainText(site.operatorName);
});

test('step 2 asks for a small, a usual and a big job, and edits and removes them', async ({
  page,
}) => {
  await finishStepOne(page, 'Moss & Stone Exterior Care');
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Driveways' })).toContainText('0 of 3 with a size');
  await expect(page.getByRole('button', { name: 'Add a Patios & pavers job' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a usual Driveways job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await expect(sheet).toContainText('A usual Driveways job, the kind you do most.');
  await sheet.locator('input[type=file]').setInputFiles(photo);
  await expect(sheet.getByRole('img', { name: 'Job photo 1' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Patios & pavers' }).click();
  await sheet.getByLabel('What was the job?').fill('Back patio and walkway.');
  await sheet.getByLabel('What did you charge?').fill('275');
  await expect(sheet.getByLabel('How big was it?')).toHaveAttribute('placeholder', '600 sq ft');
  await sheet.getByLabel('How big was it?').fill('600 sq ft');
  await sheet.getByRole('button', { name: 'More details' }).click();
  await sheet.getByLabel('Discount amount').fill('25');
  await sheet.getByPlaceholder('Why? For example: repeat customer').fill('Repeat customer');
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(sheet).toBeHidden();

  const patios = page.getByRole('region', { name: 'Patios & pavers' });
  await expect(patios).toContainText('1 of 3 with a size');
  const card = page.getByRole('listitem').filter({ hasText: 'Back patio and walkway' });
  await expect(card).toContainText('Usual');
  await expect(card).toContainText('$275');
  await expect(card).toContainText('Patios & pavers · 600 sq ft');
  await expect(card).toContainText('$25 off, repeat customer');
  await expect(card.locator('img')).toBeVisible();
  await expect(patios.getByRole('button', { name: 'Add a big Patios & pavers job' })).toBeVisible();
  await expect(next).toBeEnabled();

  await page.reload();
  await card.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit job' });
  await edit.getByLabel('What did you charge?').fill('290');
  await edit.getByLabel('How big was it?').fill('');
  await edit.getByRole('button', { name: 'Remove photo 1' }).click();
  await edit.getByRole('button', { name: 'Save job' }).click();
  await expect(card).toContainText('$290');
  await expect(card).toContainText('No photos');
  await expect(card).toContainText('Usual', { ignoreCase: false });
  await expect(card).toContainText(
    'Add how big it was, like 600 sq ft, so it can learn your rate.',
  );
  await expect(patios).toContainText('0 of 3 with a size');

  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: 'Add a Patios & pavers job' })).toBeVisible();
  await expect(next).toBeDisabled();
});

test('several old invoices are read in the background and saved together', async ({ page }) => {
  await finishStepOne(page, 'Driveway Pros');
  await page.locator('input[type=file][multiple][accept*="application/pdf"]').setInputFiles([
    {
      name: 'invoice-1187.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fixture'),
    },
    {
      name: 'invoice-1188.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 second fixture'),
    },
  ]);
  const list = page.getByRole('list', { name: 'Jobs from your files' });
  const first = list.getByRole('listitem', { name: 'Job from invoice-1187.pdf' });
  const second = list.getByRole('listitem', { name: 'Job from invoice-1188.pdf' });
  await expect(first.getByLabel('What did you charge?')).toHaveValue('320', { timeout: 15_000 });
  await expect(first).toContainText(
    'Also on it: 3 hours · $25 materials · $20 off, repeat customer',
  );
  await expect(second.getByLabel('What did you charge?')).toHaveValue('320');

  // Everything is checked before anything is saved.
  await second.getByLabel('What did you charge?').fill('');
  await page.getByRole('button', { name: 'Save 2 jobs' }).click();
  await expect(second).toContainText('Add what you charged.');
  await second.getByLabel('What did you charge?').fill('410');
  await second.getByLabel('Service').selectOption('House wash');
  await page.getByRole('button', { name: 'Save 2 jobs' }).click();

  await expect(page.getByRole('heading', { name: 'Check these jobs' })).toHaveCount(0);
  await expect(
    page
      .getByRole('list', { name: 'Your Driveways jobs' })
      .getByRole('listitem')
      .filter({ hasText: 'Driveway wash' }),
  ).toContainText('$20 off, repeat customer');
  await expect(page.getByRole('list', { name: 'Your House wash jobs' })).toContainText('$410');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Check these jobs' })).toHaveCount(0);
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

  await expect(page.getByRole('heading', { name: 'Your AI is ready.' })).toBeVisible();
  await expect(
    page.getByText('It learned from 1 past job and 3 practice customers.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('How big is the area?')).toBeVisible();
  await expect(page.getByText('Asks about size and stains')).toHaveCount(0);
  await expect(page.getByText(/^Charges about \$0\.51 per sq ft for patios$/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Dana R.' })).toBeVisible();
  await expect(page.getByText('Anything over $1,500')).toBeVisible();
  await expect(
    page.getByText(/^You.ll approve each quote for now\.$/),
    'One past job is too few for any service to send on its own',
  ).toBeVisible();
  const readiness = page.getByRole('region', { name: 'Agent readiness' });
  await expect(readiness.getByRole('meter', { name: 'Agent readiness' })).toHaveAttribute(
    'aria-valuenow',
    /^\d+$/,
  );
  await expect(readiness).toContainText(/Next: (Add a .+ job with its size|Practice a .+ job)\./);
  const services = page.getByRole('list', { name: 'Your services' });
  const driveways = services.getByRole('listitem').filter({ hasText: 'Driveways' });
  await expect(driveways).toContainText(
    'Checks with you until it has 2 more Driveways jobs with a size.',
  );
  await expect(services.getByRole('listitem').filter({ hasText: 'House wash' })).toContainText(
    'Checks with you until it has 3 House wash jobs with a size.',
  );

  // Each gap is one tap away: a job to add here, or a practice customer for that service.
  await driveways.getByRole('button', { name: 'Add a Driveways job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await sheet.getByLabel('What was the job?').fill('Long gravel-edged driveway.');
  await sheet.getByLabel('What did you charge?').fill('400');
  await sheet.getByLabel('How big was it?').fill('1,000 sq ft');
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(driveways).toContainText(
    'Checks with you until it has 1 more Driveways job with a size.',
  );
  await driveways.getByRole('button', { name: 'Practice a Driveways job' }).click();
  await expect(page).toHaveURL(/\/start\/practice$/);
  await expect(page.getByRole('heading', { name: 'Practice a Driveways job' })).toBeVisible();
  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 15_000 });
  await quote('Driveway wash, about 800 sq ft', '330');
  await page.getByRole('button', { name: 'See what your AI learned' }).click();
  await expect(page).toHaveURL(/\/start\/ready$/);
  await expect(
    page.getByText('It learned from 2 past jobs and 4 practice customers.', { exact: false }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Create your free account' }).click();
  await expect(page).toHaveURL(/\/start\/account$/);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Add your first name.')).toBeVisible();
  await page.getByLabel('First name').fill('Maya');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByLabel('Email').fill(`maya-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('test password strong123');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Straight to the plans, then a card, then deploying. No email check first.
  await expect(page).toHaveURL(/\/start\/live$/);
  await expect(page.getByRole('heading', { name: 'Pick a plan. Then go live.' })).toBeVisible();
  const plans = page.getByRole('list', { name: 'Plans' });
  for (const name of ['Pay per quote', 'Pay when you win', 'Subscription'])
    await expect(plans.getByRole('listitem', { name, exact: true })).toBeVisible();
  const subscription = plans.getByRole('listitem', { name: 'Subscription' });
  await expect(subscription).toContainText('First week free');
  await subscription.getByRole('radio', { name: 'Yearly' }).click();
  await expect(subscription).toContainText('$499');
  await expect(page.getByText('Switch plans or cancel any time.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toHaveCount(0);
  await plans
    .getByRole('listitem', { name: 'Pay per quote' })
    .getByRole('button', { name: 'Start with $2 a quote' })
    .click();
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await expect(page.getByText('$2 per quote, card added')).toBeVisible();
  await expect(page.getByText(/It.s \d+% ready, so for now it drafts each quote/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Deploy your agent' }).click();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toBeVisible();
  await expect(page).toHaveURL(/\/start\/live$/);
  await expect(page.getByText(/You.re all set, Maya/)).toBeVisible();
  await expect(page.getByText(/\/q\/moss-and-stone-exterior-care-[0-9a-f]{8}$/)).toBeVisible();
  await expect(
    page.getByRole('img', { name: /QR code for the Moss & Stone Exterior Care quote link/ }),
  ).toBeVisible();
  const websiteSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/share') && response.request().method() === 'PATCH',
  );
  await page.getByLabel(/What.s your website\?/).fill('https://www.MossAndStone.com/contact');
  await page.getByLabel(/What.s your website\?/).press('Tab');
  await websiteSaved;
  await expect(
    page.getByText('Only mossandstone.com and www.mossandstone.com can show your widget.'),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Section on a page' }).click();
  await expect(page.locator('pre code')).toContainText('data-quotefolk-inline=');
  await page.reload();
  await expect(page.getByLabel(/What.s your website\?/)).toHaveValue('mossandstone.com');
  await expect(page.getByRole('radio', { name: 'Section on a page' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
