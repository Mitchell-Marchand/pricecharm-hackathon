import { expect, test } from '@playwright/test';

test('the hero cycles through accepted quotes from different trades', async ({ page }) => {
  await page.goto('/');
  const quote = page.getByRole('article', { name: /^Quote number/ });
  await expect(quote).toHaveAttribute('aria-label', /Moss & Stone Exterior Care/);
  await expect(quote).toContainText('Accepted');
  // It moves on by itself, every few seconds, with no buttons to manage it.
  await expect(quote).toHaveAttribute('aria-label', /Brightside Cleaning Co\., total \$400/, {
    timeout: 6_000,
  });
  await expect(quote).toContainText('Accepted');
  await expect(page.getByRole('button', { name: /Pause|Play/ })).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
    'smooth',
  );
});

test('a visitor types to the demo and gets a quote for the trade they pick', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try the demo' }).click();
  await expect(page).toHaveURL(/#demo$/);
  const demo = page.locator('#demo');
  await demo.getByLabel('Pick an industry').selectOption('junk');
  await expect(demo.getByText(/quote assistant for Clean Sweep Junk Removal/)).toBeVisible();

  const message = demo.getByLabel('Message', { exact: true });
  await message.fill('We need a garage cleanouts quote, please.');
  await message.press('Enter');
  await expect(demo.getByText('[Demo] Thanks! About how much is there?')).toBeVisible();
  await message.fill('About half a truck of old furniture.');
  await message.press('Enter');
  await expect(demo.getByText(/send a photo or two/)).toBeVisible();
  await expect(demo.getByText('File uploads are disabled in demo mode.')).toBeVisible();
  await demo.getByRole('button', { name: 'Skip photos' }).click();
  await demo.getByRole('button', { name: 'See my quote' }).click();

  const quote = demo.getByRole('article', { name: /^Quote number/ });
  await expect(quote).toHaveAttribute('aria-label', /Clean Sweep Junk Removal, total \$395/);
  await expect(quote).toContainText('not an offer from a real business');
  await message.fill('Can you come Saturday?');
  await message.press('Enter');
  await expect(demo.getByText(/this goes straight to Marcus/)).toBeVisible();
  await demo.getByRole('button', { name: 'Accept quote' }).click();
  await expect(
    demo.getByText('You’re all set. Marcus will be in touch to schedule.'),
  ).toBeVisible();
  await expect(quote).toContainText('Accepted');
  await expect(message).toHaveCount(0);
  await demo.getByRole('button', { name: 'Start over' }).click();
  await expect(quote).toHaveCount(0);
  await expect(message).toBeVisible();
});

test('the camera says uploads are off, and a demo link opens on its trade', async ({ page }) => {
  await page.goto('/demo?trade=hvac');
  await expect(page.getByText(/quote assistant for Comfort Air Heating & Cooling/)).toBeVisible();
  await page.getByRole('button', { name: 'Add a photo' }).click();
  await expect(page.getByText('File uploads are disabled in demo mode.')).toBeVisible();
  const industries = page.getByRole('navigation', { name: 'Industries' }).getByRole('button');
  await expect(industries).toHaveCount(24);
  await expect(industries.filter({ hasText: 'HVAC' })).toHaveAttribute('aria-current', 'true');
  await industries.filter({ hasText: 'Photography' }).click();
  await expect(page).toHaveURL(/\/demo\?trade=photography$/);
  await expect(page.getByText(/quote assistant for Golden Hour Studio/)).toBeVisible();
});

test('when the live demo is busy, it carries on as a quick scripted version', async ({ page }) => {
  await page.route('**/api/v1/demo/start', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DEMO_BUSY', message: 'The live demo is busy right now.' },
      }),
    }),
  );
  await page.goto('/demo?trade=painting');
  await page.getByRole('button', { name: 'Interior', exact: true }).click();
  await expect(page.getByText(/busy right now, so here’s the quick version/)).toBeVisible();
  await page.getByRole('button', { name: '2–3 rooms' }).click();
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByRole('button', { name: 'A few nail holes' }).click();
  await page.getByRole('button', { name: 'See my quote' }).click();
  await expect(page.getByRole('article', { name: /^Quote number/ })).toHaveAttribute(
    'aria-label',
    /True Coat Painting, total \$1,320/,
  );
});
