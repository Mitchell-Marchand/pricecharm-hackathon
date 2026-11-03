import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const photo = path.resolve('public/photos/patio-overview.jpg');

/** Setup's first screens, done the way an owner does them, up to the training intro. */
async function describeBusiness(page: Page, name: string) {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/trade$/);
  await page.getByRole('radio', { name: 'Pressure washing' }).click();
  await expect(page).toHaveURL(/\/start\/services$/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/why$/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/about$/);
  await page.getByLabel('Business name').fill(name);
  await page.getByLabel('Main location').fill('Portland, OR');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/training$/);
}

/**
 * A signed-up pressure washing business on the try page, with its past jobs open. Past jobs come
 * after the account now, so the business and the account are made through the API.
 */
async function pastJobsAfterSignup(page: Page, name: string) {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/trade$/);
  const headers = { Origin: new URL(page.url()).origin };
  const send = async (url: string, method: 'post' | 'patch', data: object) => {
    const response = await page.request[method](url, { headers, data });
    expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
  };
  await send('/api/v1/onboarding/business', 'patch', {
    tradeId: 'pressure-washing',
    services: ['Driveways', 'House wash', 'Patios & pavers'],
    name,
    locations: ['Portland, OR'],
  });
  await send('/api/v1/auth/register', 'post', {
    firstName: 'Maya',
    lastName: 'Lopez',
    email: `maya-jobs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    password: 'test password strong123',
  });
  await page.goto('/start/try');
  await page.getByRole('button', { name: 'Add past jobs' }).click();
}

test('the landing page leads into setup', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Accurate quotes for your customers with your own AI' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Get started' }).first().click();
  await expect(page).toHaveURL(/\/start\/trade$/);
  await expect(
    page.getByRole('heading', { name: 'What kind of business do you run?' }),
  ).toBeVisible();
});

test('a trade’s ad lands on the funnel and starts setup on that trade', async ({ page }) => {
  await page.goto('/go?trade=window-cleaning&utm_source=meta');
  await expect(
    page.getByRole('heading', { name: /4 in 10 quote requests come in after you.ve closed/ }),
  ).toBeVisible();
  await expect(page.getByText('Free to train. Free to start.', { exact: false })).toBeVisible();
  // Channels that aren't ready for new owners say so.
  await expect(page.getByText('Instagram')).toContainText('soon');
  await page.getByRole('link', { name: 'Deliver more quotes' }).first().click();
  await expect(page).toHaveURL(/\/start\/services$/);
  await expect(page.getByRole('button', { name: 'Exterior windows' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('setup asks one thing a screen and saves each as you go', async ({ page }) => {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/trade$/);
  // Continue never sits disabled: it says what's missing instead.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Pick your trade, or type it in the search.')).toBeVisible();
  await expect(page).toHaveURL(/\/start\/trade$/);
  // A tap on a trade is the answer: it moves straight on.
  await page.getByRole('radio', { name: 'Window cleaning' }).click();
  await expect(page).toHaveURL(/\/start\/services$/);
  await expect(page.getByRole('button', { name: 'Exterior windows' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Skylights' }).click();
  await page.getByPlaceholder('Add a service').fill('Solar panels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Coming back, tapping the trade they picked keeps the services they chose.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/start\/trade$/);
  await page.getByRole('radio', { name: 'Window cleaning' }).click();
  await expect(page).toHaveURL(/\/start\/services$/);
  for (const service of ['Exterior windows', 'Skylights', 'Solar panels'])
    await expect(page.getByRole('button', { name: service })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

  // Between questions, a number about their trade.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/why$/);
  // How customers shop, never a claim about a business setup knows nothing about yet.
  await expect(page.getByText('Window cleaning customers')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /7 in 10\s*want a price before they call anyone/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/start\/about$/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Add your business name.')).toBeVisible();
  await expect(page.getByLabel('Business name')).toBeFocused();
  await page.getByLabel('Business name').fill('Clearview Windows');
  await page.getByLabel('Main location').fill('Boise, ID');
  await page.getByRole('button', { name: 'Add another location' }).click();
  await page.getByLabel('Location 2').fill('Meridian, ID');
  await expect(page.getByText(/How far you.ll travel/)).toHaveCount(0);
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Business name')).toHaveValue('Clearview Windows');
  await expect(page.getByLabel('Main location')).toHaveValue('Boise, ID');
  await expect(page.getByLabel('Location 2')).toHaveValue('Meridian, ID');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/training$/);
  await expect(page.getByRole('heading', { name: 'Ready to start training?' })).toBeVisible();
  await expect(page.getByText('By starting, you agree to our', { exact: false })).toBeVisible();
  // The fact and training screens aren't bookmarks: setup picks up at practice.
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/practice$/, { timeout: 15_000 });
});

test('a trade that isn’t listed is picked straight from the search', async ({ page }) => {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/trade$/);
  const search = page.getByLabel('Search trades');
  await search.fill('Dog grooming');
  await page.getByRole('radio', { name: 'Use “Dog grooming”' }).click();
  await expect(page).toHaveURL(/\/start\/services$/);
  await expect(page.getByRole('button', { name: 'Dog grooming', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Back' }).click();
  const picked = page.getByRole('radio', { name: 'Dog grooming', exact: true });
  await expect(picked).toHaveAttribute('aria-checked', 'true');

  await page.getByLabel('Search trades').fill('Pet sitting');
  await page.getByLabel('Search trades').press('Enter');
  await expect(page).toHaveURL(/\/start\/services$/);
  await expect(page.getByRole('button', { name: 'Pet sitting', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('radio', { name: 'Pet sitting', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Its card takes them on too, as a listed trade's does.
  await page.getByRole('radio', { name: 'Pet sitting', exact: true }).click();
  await expect(page).toHaveURL(/\/start\/services$/);
});

test('the public pages render without sideways scrolling on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/go', '/demo', '/pricing', '/privacy', '/terms']) {
    await page.goto(path);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      path,
    ).toBe(false);
  }
  await page.goto('/pricing');
  const pricing = (await (await page.request.get('/api/v1/pricing')).json()).data;
  await expect(page.getByText('up front', { exact: true })).toHaveCount(2);
  await expect(
    page.getByText(`$${pricing.perQuoteCents / 100} per quote`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`${pricing.accepted.basisPoints / 100}% of accepted quotes`, { exact: true }),
  ).toBeVisible();
  await page.goto('/privacy');
  const site = (await (await page.request.get('/api/v1/site')).json()).data;
  await expect(page.locator('#contact')).toContainText(site.operatorName);
});

test('the job sheet marks what the API turned down', async ({ page }) => {
  await pastJobsAfterSignup(page, 'Moss & Stone Exterior Care');
  await page.getByRole('button', { name: 'Add a usual Driveways job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await sheet.getByLabel('What was the job?').fill('Two-car driveway.');
  await sheet.getByLabel('What did you charge?').fill('250');
  const size = sheet.getByLabel('How big was it?');
  await size.fill('x'.repeat(81));
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(sheet.getByText('Check the highlighted fields.')).toBeVisible();
  await expect(size).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByText('Keep this to 80 characters or fewer.')).toBeVisible();
  await size.fill('600 sq ft');
  await expect(size).not.toHaveAttribute('aria-invalid');
  await expect(sheet.getByText('Check the highlighted fields.')).toHaveCount(0);

  // A page from a newer release than the API sends a field the API doesn't know yet.
  await page.route('**/api/v1/onboarding/jobs', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the highlighted fields.',
          details: [{ field: '', message: 'Unrecognized key: "slot"' }],
        },
      }),
    }),
  );
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(
    sheet.getByText('We couldn’t save this. Refresh the page and try again.'),
  ).toBeVisible();
  await page.unroute('**/api/v1/onboarding/jobs');
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await expect(sheet).toBeHidden();
});

test('past jobs ask for a small, a usual and a big job, and edit and remove them', async ({
  page,
}) => {
  await pastJobsAfterSignup(page, 'Moss & Stone Exterior Care');
  await expect(page.getByRole('region', { name: 'Driveways' })).toContainText('0 of 3 with a size');
  await expect(page.getByRole('button', { name: 'Add a Patios & pavers job' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a usual Driveways job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await expect(sheet).toContainText('A usual Driveways job, the kind you do most.');
  // Photos picked together all arrive, however many: they upload in turn.
  await sheet.locator('input[type=file]').setInputFiles([photo, photo, photo, photo]);
  for (const index of [1, 2, 3, 4])
    await expect(sheet.getByRole('img', { name: `Job photo ${index}` })).toBeVisible();
  for (const index of [4, 3, 2])
    await sheet.getByRole('button', { name: `Remove photo ${index}` }).click();
  await expect(sheet.getByRole('img', { name: 'Job photo 2' })).toHaveCount(0);
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

  await page.reload();
  await page.getByRole('button', { name: 'Add past jobs' }).click();
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
});

test('several old invoices are read in the background and saved together', async ({ page }) => {
  await pastJobsAfterSignup(page, 'Driveway Pros');
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
  await page.reload();
  await page.getByRole('button', { name: 'Add past jobs' }).click();
  await expect(page.getByRole('heading', { name: 'Check these jobs' })).toHaveCount(0);
});

test('practice comes first, then the account, a test, the plans and going live', async ({
  page,
}) => {
  await describeBusiness(page, 'Moss & Stone Exterior Care');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(page).toHaveURL(/\/start\/practice$/);
  const meter = page.getByRole('meter', { name: 'How trained your Charm is' });
  await expect(meter).toHaveAttribute('aria-valuenow', '0');

  const quote = async (label: string, price: string) => {
    await page.getByRole('button', { name: 'I have enough to quote' }).click();
    const builder = page.getByRole('dialog', { name: /^Quote for / });
    await builder.getByRole('textbox', { name: 'Item 1', exact: true }).fill(label);
    await builder.getByRole('textbox', { name: 'Price for item 1' }).fill(price);
    await builder.getByRole('button', { name: 'Send quote' }).click();
    await expect(
      page.getByRole('heading', { name: /Here.s what your Charm picked up/ }),
    ).toBeVisible({
      timeout: 15_000,
    });
  };

  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 15_000 });
  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('How big is the patio?');
  await reply.press('Enter');
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible();
  await quote('Patio wash, about 550 sq ft', '280');
  await expect(meter).not.toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByText(/About \d+ more to reach 85%/)).toBeVisible();
  // Once the quote is out, the Charm asks one thing about how they price, answered with a tap.
  const question = page.locator('section').filter({ hasText: 'One question from your Charm' });
  await question.getByRole('button').first().click();
  await expect(page.getByText(/Got it\. It follows this on every quote now/)).toBeVisible();
  // After one customer they can stop and pick it up later, from an emailed link.
  await page.getByRole('button', { name: /finish this later/ }).click();
  await expect(page.getByRole('dialog', { name: 'Save your Charm' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Asks about size')).toBeVisible();
  // A quote sent without a reason can get one here, and the Charm keeps it with this job.
  await page.getByRole('button', { name: /Add why you priced it this way/ }).click();
  await page.getByLabel('Why this price?').fill('Heavy moss on half of it, so a second pass.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Remembers why: “Heavy moss on half of it, so a second pass.”'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Add why you priced it this way/ })).toHaveCount(0);
  // Coming back before the next customer opens this one again, chat and all.
  await page.reload();
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText('Remembers why: “Heavy moss on half of it, so a second pass.”'),
  ).toBeVisible();
  // No guess on the first customers: it makes one once three of your prices are in.
  await expect(page.getByText(/makes its first guess after 2 more customers/)).toBeVisible();
  await expect(page.getByText(/Before you sent yours, it guessed/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Fix' }).first().click();
  await page.getByLabel('Correct this').fill('Asks about size and stains');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Asks about size and stains')).toBeVisible();

  await page.getByRole('button', { name: /^(Next customer|Keep training)/ }).click();
  await expect(page.getByText('Marcus T. · North Hills')).toBeVisible({ timeout: 15_000 });
  // Wanting to see it first is said in the chat. The customer asks once for a rough price.
  await expect(page.getByRole('button', { name: /see it first/i })).toHaveCount(0);
  const marcus = page.getByLabel('Reply to Marcus');
  await marcus.fill("I'd need to come by and see it first.");
  await marcus.press('Enter');
  await expect(page.getByText(/Any chance of a rough price from the pics/)).toBeVisible();
  await marcus.fill('Sorry, I really need to see it in person.');
  await marcus.press('Enter');
  await expect(page.getByText(/Wants to see jobs like this before giving a price/)).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole('button', { name: /^(Next customer|Keep training)/ }).click();
  await expect(page.getByText('Priya S. · Old Town')).toBeVisible({ timeout: 15_000 });
  await quote('Flagstone wash, about 350 sq ft', '175');
  // A quote they sent says nothing about wanting to see it first: practice is for pricing online.
  await expect(page.getByText(/would also have asked to see/)).toHaveCount(0);
  // Demo mode's three customers come round again for the rest of setup.
  for (const [name, label, price] of [
    ['Dana R. · Eastgate', 'Patio wash, about 550 sq ft', '280'],
    ['Marcus T. · North Hills', 'Patio wash, about 400 sq ft', '220'],
    ['Priya S. · Old Town', 'Flagstone wash, about 350 sq ft', '175'],
  ]) {
    await page.getByRole('button', { name: /^(Next customer|Keep training)/ }).click();
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await quote(label, price);
  }
  await page.getByRole('button', { name: 'See your Charm' }).click();
  await expect(page).toHaveURL(/\/start\/ready$/);

  // The headline says what the score means, never more.
  await expect(
    page.getByRole('heading', { name: /^Your Charm is (\d+% trained|ready to quote)\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByText('It learned from 6 practice customers.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('How big is the area?')).toBeVisible();
  // How it prices is the rate its drafts are held to, not a line from each practice run.
  await expect(page.getByText(/^About \$\d+\.\d\d per sq ft, lowest \$\d+$/).first()).toBeVisible();
  await expect(page.getByText(/^Charges about/)).toHaveCount(0);
  await expect(page.getByText('Asks about size and stains')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Dana R.' }).first()).toBeVisible();
  await expect(
    page.getByText(/^Anything over \$/),
    'No price limit unless they set one',
  ).toHaveCount(0);
  // Quoting is on from the start. While it's learning, it says so and recommends checking first.
  const charm = page.getByRole('region', { name: 'Your Charm', exact: true });
  await expect(charm.getByRole('meter', { name: 'How trained your Charm is' })).toHaveAttribute(
    'aria-valuenow',
    /^\d+$/,
  );
  await expect(charm).toContainText('customers get a price range for services under 60%');
  const quoting = charm.getByRole('switch', { name: 'Quotes customers on its own' });
  await expect(quoting).toBeChecked();
  await charm.getByRole('button', { name: 'Check with me first' }).click();
  await expect(quoting).not.toBeChecked();
  await expect(charm).toContainText('Every quote waits for your OK first.');
  await quoting.click();
  await expect(quoting).toBeChecked();
  const services = charm.getByRole('list', { name: 'Your services' });
  const driveways = services.getByRole('listitem').filter({ hasText: 'Driveways' });
  await expect(driveways).toContainText(/Add (\d+ more |\d+ |a )Driveways jobs? with a size\./);
  await expect(services.getByRole('listitem').filter({ hasText: 'House wash' })).toContainText(
    /Add (\d+ more |\d+ |a )House wash jobs? with a size\./,
  );

  // Each gap is one tap away: a job to add here, or a practice customer for that service.
  await driveways.getByRole('button', { name: 'Add a Driveways job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a job' });
  await sheet.getByLabel('What was the job?').fill('Long gravel-edged driveway.');
  await sheet.getByLabel('What did you charge?').fill('400');
  await sheet.getByLabel('How big was it?').fill('1,000 sq ft');
  await sheet.getByRole('button', { name: 'Save job' }).click();
  await driveways.getByRole('button', { name: 'Practice a Driveways job' }).click();
  await expect(page).toHaveURL(/\/start\/practice$/);
  await expect(page.getByRole('heading', { name: 'Practice a Driveways job' })).toBeVisible();
  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 15_000 });
  await quote('Driveway wash, about 800 sq ft', '330');
  await page.getByRole('button', { name: 'See your Charm' }).click();
  await expect(page).toHaveURL(/\/start\/ready$/);
  await expect(
    page.getByText('It learned from 7 practice customers and 1 past job.', { exact: false }),
  ).toBeVisible();

  // The account is made right here, next to what it learned.
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Add your first name.')).toBeVisible();
  await expect(page.getByText('Check the box to agree first.')).toBeVisible();
  await page.getByLabel('First name').fill('Maya');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByLabel('Email').fill(`maya-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('test password strong123');
  await page.getByRole('checkbox', { name: /I agree to the/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();

  // Then trying it as a customer would, in the same chat, before any plan.
  await expect(page).toHaveURL(/\/start\/try$/);
  await expect(page.getByRole('heading', { name: 'Test your Charm.' })).toBeVisible();
  await page.getByRole('button', { name: 'Test your Charm' }).click();
  const trial = page.getByRole('dialog', { name: 'Try your Charm' });
  await expect(trial.getByText(/this is a test\. Nothing is emailed or billed\./)).toBeVisible();
  await expect(trial.getByText(/I'm the quote assistant for Moss & Stone/)).toBeVisible();
  await trial.getByRole('button', { name: 'Close' }).click();

  // Then the plans, then a card, then going live. No email check first.
  await page.getByRole('button', { name: 'Let’s go live' }).click();
  await expect(page).toHaveURL(/\/start\/live$/);
  await expect(page.getByRole('heading', { name: 'Pick how you pay.' })).toBeVisible();
  const plans = page.getByRole('radiogroup', { name: 'Plans' });
  for (const name of ['Pay per quote', 'Pay when you win', 'Subscription'])
    await expect(plans.getByRole('radio', { name, exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  // Nothing is picked for them: the button says to pick one.
  await page.getByRole('button', { name: 'Pick a plan' }).click();
  await expect(page.getByText('Tap one of the plans above first.')).toBeVisible();
  const subscription = plans.getByRole('radio', { name: 'Subscription' });
  await expect(subscription).toContainText('First week free');
  await page.getByRole('radio', { name: 'Yearly' }).click();
  await expect(subscription).toHaveAttribute('aria-checked', 'true');
  await expect(subscription).toContainText('$499');
  await expect(page.getByText('Switch plans or cancel any time.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toHaveCount(0);
  await plans.getByRole('radio', { name: 'Pay per quote' }).click();
  await expect(subscription).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Start with $2 a quote' }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await expect(page.getByText('$2 per quote, card added')).toBeVisible();
  await expect(
    page.getByText(/^Your Charm quotes on its own\. While it learns, customers get a price range/),
  ).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Quotes customers on its own' })).toBeChecked();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
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
  await expect(page.locator('pre code')).toContainText('data-pricecharm-inline=');
  await page.reload();
  await expect(page.getByLabel(/What.s your website\?/)).toHaveValue('mossandstone.com');
  await expect(page.getByRole('radio', { name: 'Section on a page' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
