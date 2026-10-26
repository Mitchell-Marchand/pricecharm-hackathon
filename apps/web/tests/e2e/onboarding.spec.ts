import { expect, test } from '@playwright/test';

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
