import { expect, test } from '@playwright/test';

test('the hero shows accepted quotes from different trades', async ({ page }) => {
  await page.goto('/');
  const quote = page.getByRole('article', { name: /^Quote number/ });
  await expect(quote).toHaveAttribute('aria-label', /Moss & Stone Exterior Care/);
  await expect(quote).toContainText('Accepted');
  await page.getByRole('button', { name: 'House cleaning', exact: true }).click();
  await expect(quote).toHaveAttribute('aria-label', /Brightside Cleaning Co\., total \$400/);
  await expect(quote).toContainText('Accepted');
  await expect(page.getByRole('button', { name: 'Play the examples' })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
    'smooth',
  );
});

test('the home page demo quotes a sample job for the trade you pick', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try the demo' }).click();
  await expect(page).toHaveURL(/#demo$/);
  const demo = page.locator('#demo');
  await demo.getByLabel('Pick an industry').selectOption('junk');
  await expect(demo.getByText(/quote assistant for Clean Sweep Junk Removal/)).toBeVisible();
  for (const answer of ['Garage cleanouts', 'Half a truck', 'Skip photos', 'Yes'])
    await demo.getByRole('button', { name: answer, exact: true }).click();
  await demo.getByRole('button', { name: 'See my quote' }).click();
  const quote = demo.getByRole('article', { name: /^Quote number/ });
  await expect(quote).toHaveAttribute('aria-label', /total \$440/);
  await demo.getByRole('button', { name: 'Accept quote' }).click();
  await expect(
    demo.getByText('You’re all set. Marcus will be in touch to schedule.'),
  ).toBeVisible();
  await expect(quote).toContainText('Accepted');
  await demo.getByRole('button', { name: 'Start over' }).click();
  await expect(quote).toHaveCount(0);
});

test('a demo link opens on its trade, and every trade is there', async ({ page }) => {
  await page.goto('/demo?trade=hvac');
  await expect(page.getByText(/quote assistant for Comfort Air Heating & Cooling/)).toBeVisible();
  const industries = page.getByRole('navigation', { name: 'Industries' }).getByRole('button');
  await expect(industries).toHaveCount(24);
  await expect(industries.filter({ hasText: 'HVAC' })).toHaveAttribute('aria-current', 'true');
  await industries.filter({ hasText: 'Photography' }).click();
  await expect(page).toHaveURL(/\/demo\?trade=photography$/);
  await expect(page.getByText(/quote assistant for Golden Hour Studio/)).toBeVisible();
});
