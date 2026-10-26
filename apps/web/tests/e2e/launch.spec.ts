import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { recordQaOwner } from './qa-fixtures';
const errors = new WeakMap<Page, string[]>();
function observe(page: Page, list: string[]) {
  page.on('pageerror', (error) => list.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') list.push(message.text());
  });
}
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  observe(page, list);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page) || []).toEqual([]);
});

async function register(page: Page) {
  const stamp = randomUUID().slice(0, 8);
  const origin = new URL((test.info().project.use.baseURL as string) || 'http://localhost:3100')
    .origin;
  const email = `launch-${stamp}@example.test`,
    password = `Quotient-${stamp}-secure!`,
    businessName = `Launch Cleaning ${stamp}`;
  const result = await page.request.post('/api/v1/auth/register', {
    headers: { Origin: origin },
    data: { name: 'Launch Owner', businessName, email, password },
  });
  expect(result.status(), await result.text()).toBe(201);
  const profile = (await result.json()).data;
  await recordQaOwner(profile);
  await page.request.patch('/api/v1/business', {
    headers: { Origin: origin },
    data: {
      description: 'Residential concrete driveway cleaning.',
      serviceArea: 'Austin',
      industry: 'Exterior cleaning',
      onboardingComplete: true,
    },
  });
  return { ...profile, origin, email, password, businessName };
}

test('independent approval enables verified autonomous delivery, acceptance, billing, and global pause', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  test.skip(
    process.env.LIVE_SETUP_TESTS !== '1',
    'Set LIVE_SETUP_TESTS=1 to exercise live automatic-quote readiness and delivery.',
  );
  const owner = await register(page);
  const headers = { Origin: owner.origin };
  const aiSettings = (await (await page.request.get('/api/v1/settings')).json()).data;
  test.skip(
    aiSettings.aiMode !== 'live',
    'Autonomous readiness requires a configured live AI provider; demo cannot approve automatic quotes.',
  );
  const created = await page.request.post('/api/v1/services', {
    headers,
    data: {
      name: 'Concrete driveway wash',
      description: 'Routine cleaning of concrete driveways with easy access.',
      unitLabel: 'sq ft',
      unitPriceCents: 20,
      minimumChargeCents: 15000,
      basePriceCents: 0,
      maxAutoQuoteCents: 50000,
      requiredInputs: ['surface', 'access', 'condition'],
      exclusions: ['roof cleaning'],
      pricingRules: [
        {
          id: randomUUID(),
          name: 'Unsupported surface',
          field: 'surface',
          operator: 'not_equals',
          value: 'concrete',
          kind: 'review',
          amount: 0,
        },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const service = (await created.json()).data;
  const facts = {
    location: 'Austin',
    surface: 'concrete',
    access: 'ground-level',
    condition: 'routine',
  };
  for (const [quantity, price] of [
    [500, 15000],
    [1000, 20000],
    [1500, 30000],
  ]) {
    const result = await page.request.post(`/api/v1/services/${service.id}/test-cases`, {
      headers,
      data: {
        title: `Independent driveway ${quantity}`,
        description: `${quantity} square feet of routine concrete driveway cleaning in Austin with easy access.`,
        quantity,
        expectedCents: price,
        inputs: facts,
        expectedOutcome: 'quote',
        toleranceCents: 100,
        tolerancePercent: 5,
      },
    });
    expect(result.status(), await result.text()).toBe(201);
    const example = await page.request.post('/api/v1/examples', {
      headers,
      data: {
        serviceId: service.id,
        title: `Historical driveway ${quantity}`,
        description: 'Concrete driveway in Austin, routine condition and easy access.',
        quantity,
        finalPriceCents: price,
        rationale: 'Current area rate with a minimum visit price.',
        source: 'historical',
      },
    });
    expect(example.status(), await example.text()).toBe(201);
  }
  await page.goto('/dashboard/settings');
  await page.getByRole('button', { name: 'Send verification email', exact: true }).click();
  await page.getByRole('link', { name: 'Open local verification link', exact: true }).click();
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByText('Your email is verified.', { exact: false })).toBeVisible();
  await page.goto('/dashboard/publish');
  await page.getByRole('button', { name: 'Add a blind test case', exact: true }).click();
  await page.getByLabel('Test case title').fill('Unsupported timber surface');
  await page.getByLabel('Customer request').fill('A timber driveway requires cleaning in Austin.');
  await page.getByLabel('What should the assistant do?').selectOption('review');
  await page.getByLabel(/^Quantity/).fill('1000');
  await page.getByLabel('Project location').fill('Austin');
  await page.getByLabel('surface').fill('timber');
  await page.getByLabel('access').fill('ground-level');
  await page.getByLabel('condition').fill('routine');
  await page.getByRole('button', { name: 'Save independent case', exact: true }).click();
  await expect(
    page.getByRole('form', { name: 'New independent test case', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run independent evaluation', exact: true }).click();
  await expect(
    page.getByText('Independent checks support automatic quotes.', { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByLabel(/I reviewed the test results/).check();
  await page.getByRole('button', { name: 'Activate automatic quotes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause automatic quotes', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/automatic-launch.png', fullPage: true });
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  observe(customer, errors.get(page)!);
  await customer.goto(`${owner.origin}/q/${owner.business.slug}`);
  await expect(customer.getByLabel('Tell us about your project', { exact: true })).toBeVisible();
  await customer.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await customer.getByLabel('Your name').fill('Verified Customer');
  await customer
    .getByLabel('Email address')
    .fill(`customer-${randomUUID().slice(0, 8)}@example.test`);
  const verificationResponse = customer.waitForResponse(
    (response) =>
      response.url().endsWith('/verification') && response.request().method() === 'POST',
  );
  await customer.getByRole('button', { name: 'Send verification code', exact: true }).click();
  const verificationResult = await verificationResponse;
  expect(verificationResult.status(), await verificationResult.text()).toBe(200);
  const code = (await customer.getByText(/Development code:/).textContent())?.match(
    /\b\d{6}\b/,
  )?.[0];
  expect(code).toBeTruthy();
  await customer.getByLabel('Email verification code').fill(code!);
  await customer.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(
    customer.getByText('Email verified for this request.', { exact: true }),
  ).toBeVisible();
  await customer.getByLabel('Project location').fill('Austin');
  for (const [field, value] of Object.entries(facts).filter(([field]) => field !== 'location'))
    await customer.getByLabel(new RegExp(field.replace(/[_-]+/g, ' '), 'i')).fill(value);
  await customer.getByLabel(/^Approximate quantity/).fill('1000');
  await customer
    .getByLabel('Project description')
    .fill('Routine cleaning of a 1000 square foot concrete driveway in Austin with easy access.');
  await customer.getByLabel(/I agree to share/).check();
  await customer.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(customer.locator('.public-final-price')).toHaveText('$200', { timeout: 45000 });
  await customer.getByRole('button', { name: 'Accept quote', exact: true }).click();
  await expect(
    customer.getByRole('heading', { name: 'Quote accepted', exact: true }),
  ).toBeVisible();
  await customer.screenshot({ path: 'test-results/autonomous-quote-accepted.png', fullPage: true });
  const access = await customer.evaluate(
    (slug) => JSON.parse(localStorage.getItem(`quotient:${slug}`) || '{}'),
    owner.business.slug,
  );
  const secondDevice = await browser.newContext();
  await secondDevice.addInitScript(() =>
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    }),
  );
  const restored = await secondDevice.newPage();
  observe(restored, errors.get(page)!);
  await restored.goto(
    `${owner.origin}/q/${owner.business.slug}#session=${access.id}&token=${access.token}`,
  );
  await expect(restored.locator('.public-final-price')).toHaveText('$200');
  await expect(
    restored.getByRole('heading', { name: 'Quote accepted', exact: true }),
  ).toBeVisible();
  expect(new URL(restored.url()).hash).toBe('');
  expect(new URL(restored.url()).searchParams.has('token')).toBe(false);
  await secondDevice.close();
  const billing = (await (await page.request.get('/api/v1/billing')).json()).data;
  expect(billing.usage.deliveredQuotes).toBe(1);
  expect(billing.trial.remainingQuotes).toBe(billing.trial.quoteLimit - 1);
  await page.getByRole('button', { name: 'Pause automatic quotes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Enable automatic quotes', exact: true }),
  ).toBeVisible();
  await page.goto('/dashboard/billing');
  await expect(
    page.getByRole('heading', { name: 'Billing & delivery usage', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Monthly platform spending cap ($)').fill('75');
  await page.getByRole('button', { name: 'Save cap', exact: true }).click();
  await expect(
    page.getByText('Your monthly spending cap has been saved.', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/publish');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/automatic-launch-mobile.png', fullPage: true });
  await customerContext.close();
});

test('password recovery rotates access and account export and deletion are self-service', async ({
  page,
}) => {
  const owner = await register(page);
  await page.goto('/forgot-password');
  await page.getByLabel('Account email').fill(owner.email);
  await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
  await page.getByRole('link', { name: 'Open the local reset link', exact: true }).click();
  const password = `Recovered-${randomUUID()}!`;
  await page.getByLabel('New password').fill(password);
  const resetResponse = page.waitForResponse((response) =>
    response.url().endsWith('/auth/reset-password'),
  );
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  const resetResult = await resetResponse;
  expect(resetResult.status(), await resetResult.text()).toBe(200);
  await expect(page.getByText('Your password has been reset.', { exact: false })).toBeVisible();
  const oldLogin = await page.request.post('/api/v1/auth/login', {
    headers: { Origin: owner.origin },
    data: { email: owner.email, password: owner.password },
  });
  expect(oldLogin.status()).toBe(401);
  await page.goto('/login');
  await page.getByLabel('Email address').fill(owner.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/dashboard/settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace data', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('workspace-export.json');
  await page.getByRole('button', { name: 'Send verification email', exact: true }).click();
  await page.getByRole('link', { name: 'Open local verification link', exact: true }).click();
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByText('Your email is verified.', { exact: false })).toBeVisible();
  await page.goto('/dashboard/billing');
  await page.getByRole('button', { name: 'Activate paid delivery', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/billing\?local=active/);
  await page.getByRole('button', { name: 'Payment methods & invoices', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/billing\?local=portal/);
  await page.goto('/dashboard/settings');
  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await page.getByLabel(`Type “${owner.businessName}” to confirm`).fill(owner.businessName);
  await page.getByLabel('Your current password').fill(password);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete workspace', exact: true })
    .click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});

test('document evidence is reviewed and learned pricing stays private until applied', async ({
  page,
}) => {
  test.setTimeout(180000);
  const owner = await register(page),
    headers = { Origin: owner.origin };
  const settings = (await (await page.request.get('/api/v1/settings')).json()).data;
  test.skip(
    settings.aiMode === 'live' && process.env.LIVE_SETUP_TESTS !== '1',
    'Set LIVE_SETUP_TESTS=1 to make live document and pricing-provider calls.',
  );
  const created = await page.request.post('/api/v1/services', {
    headers,
    data: {
      name: 'Document driveway wash',
      description: 'Concrete driveway cleaning with ground-level access.',
      unitLabel: 'sq ft',
      unitPriceCents: 20,
      minimumChargeCents: 15000,
      requiredInputs: ['surface'],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const service = (await created.json()).data;
  await page.goto('/dashboard/examples');
  await page.getByRole('button', { name: 'Import document', exact: true }).click();
  await page
    .getByRole('dialog')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'historical-invoice.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Historical project. Title: Standard Austin driveway. Service: concrete driveway cleaning. Location: Austin. Surface: concrete. Access: ground-level. Quantity: 1000 square feet. Final price: USD 200. Rationale: Standard 20 cents per square foot, minimum visit charge USD150. No discount. No tax. One project only.',
      ),
    });
  await page.getByRole('button', { name: 'Read this document', exact: true }).click();
  if (settings.aiMode === 'demo') {
    await expect(page.getByRole('alert')).toContainText('live AI provider');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    return;
  }
  await expect(
    page.getByRole('heading', { name: 'Review jobs and notes', exact: true }),
  ).toBeVisible({ timeout: 60000 });
  expect((await (await page.request.get('/api/v1/examples')).json()).data).toHaveLength(0);
  await page.getByText('Edit details', { exact: true }).first().click();
  await page.getByLabel('Job title').first().fill('Reviewed imported driveway');
  await page
    .getByLabel('Scope and details')
    .first()
    .fill('1000 square feet of concrete driveway in Austin with ground-level access.');
  await page.getByLabel('Quantity unit', { exact: true }).first().fill('sq ft');
  await page.getByLabel('Quantity', { exact: true }).first().fill('1000');
  await page.getByRole('combobox', { name: 'Currency', exact: true }).first().selectOption('USD');
  await page.getByLabel('Confirmed amount in USD').first().fill('200');
  await page
    .getByLabel('Why this price?')
    .first()
    .fill('Current standard area rate; minimum did not apply.');
  await page.getByRole('button', { name: 'Save this job', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Reviewed imported driveway', exact: true }),
  ).toBeVisible();
  for (const [quantity, price] of [
    [500, 15000],
    [1500, 30000],
  ]) {
    const saved = await page.request.post('/api/v1/examples', {
      headers,
      data: {
        serviceId: service.id,
        title: `Evidence ${quantity}`,
        description: 'Concrete driveway cleaning in Austin with easy access.',
        quantity,
        finalPriceCents: price,
        rationale: '20 cents per square foot with minimum visit price150 dollars.',
        source: 'historical',
        inputs: { location: 'Austin', surface: 'concrete' },
      },
    });
    expect(saved.status(), await saved.text()).toBe(201);
  }
  await page.goto('/dashboard/services');
  await page.getByRole('button', { name: 'Learn from my examples', exact: true }).click();
  await page
    .getByLabel('What should the assistant understand?')
    .fill(
      'Use USD. Preserve the standard area rate20 cents per square foot and minimum150 dollars. All supported work is concrete with straightforward access. Do not invent extras.',
    );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Learn from my examples', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Suggested pricing', exact: true })).toBeVisible({
    timeout: 60000,
  });
  const before = (await (await page.request.get('/api/v1/services')).json()).data[0];
  await page.getByRole('button', { name: 'Apply this playbook', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('applied', { exact: true })).toBeVisible();
  const after = (await (await page.request.get('/api/v1/services')).json()).data[0];
  expect(after.version).toBeGreaterThan(before.version);
  expect(after.publishedAt).toBeNull();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto('/dashboard/playground');
  await page.getByRole('button', { name: 'Try the full conversation', exact: true }).click();
  await expect(
    page.getByText('Private test. Nothing is sent or billed.', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel('Customer’s project', { exact: true })
    .fill('I need a concrete driveway cleaned in Austin.');
  await page.getByRole('button', { name: 'Try this request', exact: true }).click();
  await expect(page.locator('.public-message-list .message')).toHaveCount(3, { timeout: 45000 });
  const usage = (await (await page.request.get('/api/v1/billing')).json()).data;
  expect(usage.usage.deliveredQuotes).toBe(0);
  expect(usage.usage.billableQuotes).toBe(0);
  await page.screenshot({ path: 'test-results/learning-private-playground.png', fullPage: true });
});

test('pricing and policy pages show the configured tariff and operator', async ({ page }) => {
  const pricing = (await (await page.request.get('/api/v1/pricing')).json()).data;
  const site = (await (await page.request.get('/api/v1/site')).json()).data;
  await page.goto('/pricing');
  await expect(page.getByText(`${pricing.feeBasisPoints / 100}%`, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`${pricing.trialQuotes} automatic quotes to try`, { exact: true }),
  ).toBeVisible();
  await page.goto('/privacy');
  await expect(page.locator('.legal-page article')).toContainText(site.operatorName);
  await expect(page.getByRole('link', { name: site.supportEmail }).first()).toHaveAttribute(
    'href',
    `mailto:${site.supportEmail}`,
  );
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'Platform fees', exact: true })).toBeVisible();
  const tokenHeaders = await page.request.get('/reset-password');
  expect(tokenHeaders.headers()['referrer-policy']).toBe('no-referrer');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
});
