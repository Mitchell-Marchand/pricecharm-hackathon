import { expect, test, type Page } from '@playwright/test';
import { createBusiness } from './helpers';

// scripts/e2e.sh builds with a pixel id, and playwright.config.ts sends Meta's hosts nowhere, so
// these tests stand in for Meta's script and no test ever reaches Meta.
const SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';

declare global {
  interface Window {
    pixelCalls?: unknown[][];
  }
}

/** Meta's script, replaced by one that keeps every call the page makes. */
async function fakePixel(page: Page) {
  await page.route(SCRIPT, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.pixelCalls = [];
        window.fbq.callMethod = (...args) => window.pixelCalls.push(args);
        window.fbq.queue.splice(0).forEach((args) => window.fbq.callMethod(...args));`,
    }),
  );
}

const tracked = (page: Page) =>
  page.evaluate(() =>
    (window.pixelCalls ?? []).filter(([method]) => method === 'track').map(([, name]) => name),
  );
const pixelLoaded = (page: Page) => page.evaluate(() => Boolean(window.fbq));

test('the pixel counts the public pages and stays off customers’ pages and the owner’s app', async ({
  page,
  browser,
  baseURL,
}) => {
  await fakePixel(page);
  await page.goto('/');
  await expect.poll(() => tracked(page)).toEqual(['PageView']);
  expect(await page.evaluate(() => window.pixelCalls?.[0])).toEqual([
    'set',
    'autoConfig',
    false,
    expect.any(String),
  ]);
  await page.getByRole('link', { name: 'Pricing', exact: true }).first().click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect.poll(() => tracked(page)).toEqual(['PageView', 'PageView']);

  const business = await createBusiness(browser, baseURL!);
  const owner = await business.context.newPage();
  await fakePixel(owner);
  for (const path of [`/q/${business.slug}`, `/embed/${business.slug}`, '/app']) {
    await owner.goto(path);
    await owner.waitForLoadState('networkidle');
    expect(await pixelLoaded(owner), path).toBe(false);
  }
  await business.context.close();
});

test('the pixel hears about a business, a new account and a card, and not from a browser that opts out', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await fakePixel(page);
  const send = async (method: 'post' | 'patch', url: string, data: object) => {
    const response = await context.request[method](url, {
      headers: { Origin: new URL(baseURL!).origin },
      data,
    });
    expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
  };
  await send('post', '/api/v1/onboarding/start', {});
  await send('patch', '/api/v1/onboarding/business', {
    tradeId: 'pressure-washing',
    services: ['Driveways'],
    name: 'Pixel Test Washing',
    area: 'Portland, OR',
  });
  // A business described is the first sign the campaign gets: setup's account comes later.
  await page.goto('/start/about');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/start\/training$/);
  await expect.poll(() => tracked(page)).toContain('Lead');

  await page.goto('/start/account');
  await expect(page).toHaveURL(/\/start\/ready/);
  await page.getByLabel('First name').fill('Maya');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByLabel('Email').fill(`maya-pixel-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('test password strong123');
  await page.getByRole('checkbox', { name: /I agree to the/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/start\/try$/);
  await expect.poll(() => tracked(page)).toContain('CompleteRegistration');

  await page.goto('/start/live');
  await page
    .getByRole('radiogroup', { name: 'Plans' })
    .getByRole('radio', { name: 'Pay per quote' })
    .click();
  await page.getByRole('button', { name: 'Start with $2 a quote' }).click();
  await expect(page.getByText('$2 per quote, card added')).toBeVisible();
  await expect.poll(() => tracked(page)).toEqual(['PageView', 'AddPaymentInfo']);
  await context.close();

  // Global Privacy Control turns it off.
  const optedOut = await browser.newContext({ baseURL });
  await optedOut.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }),
  );
  const quiet = await optedOut.newPage();
  await fakePixel(quiet);
  await quiet.goto('/');
  await quiet.waitForLoadState('networkidle');
  expect(await pixelLoaded(quiet)).toBe(false);
  await optedOut.close();
});
