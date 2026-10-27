import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createBusiness, expectQuoteFromTop } from './helpers';

const photo = path.resolve('public/photos/patio-stains.jpg');

/** Describes the job, then gives a name and email and enters the code from the screen. */
async function askForQuote(page: Page, { withPhoto }: { withPhoto: boolean }) {
  await expect(page.getByText(/I'm the quote assistant for Moss & Stone/)).toBeVisible();
  await page.getByRole('button', { name: 'Driveways' }).click();
  await expect(page.getByText(/\[Demo\] Thanks!/)).toBeVisible();
  await page.getByLabel('Message').fill('About 600 sq ft, fits two cars.');
  await page.getByLabel('Message').press('Enter');
  await expect(page.getByRole('button', { name: 'Skip photos' })).toBeVisible();
  if (withPhoto) {
    await page.locator('input[type=file]').setInputFiles(photo);
    await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
  } else await page.getByRole('button', { name: 'Skip photos' }).click();

  await expect(page.getByText('Where should we send your quote?')).toBeVisible();
  await page.getByLabel('Your name').fill('Sam Kim');
  await page.getByLabel('Your email').fill('sam@example.test');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const hint = await page.getByText(/Local test code: \d{6}/).textContent();
  await page.getByLabel(/We sent a 6-digit code to sam@example.test/).fill(hint!.slice(-6));
  await page.getByRole('button', { name: 'See my quote' }).click();
}

test('a customer gets a quote on the link, comes back to it, and accepts it', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  await shop.autoSend(true);
  await page.goto(`/q/${shop.slug}`);
  await expect(page).toHaveTitle(/Get a quote from Moss & Stone Exterior Care/);
  await askForQuote(page, { withPhoto: true });

  const quote = page.getByRole('article', { name: /from Moss & Stone Exterior Care/ });
  await expect(quote).toBeVisible();
  await expect(quote).toContainText('$275');
  await expect(page.getByText(/Here.s your quote, Sam/)).toBeVisible();
  await expectQuoteFromTop(quote);

  // Coming back to answer it, it opens on the quote again, once their photo has loaded above it.
  await page.reload();
  await expect(quote).toBeVisible();
  await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
  await expectQuoteFromTop(quote);
  await page.getByRole('button', { name: 'Accept quote' }).click();
  await expect(page.getByText(/You.re all set\. Maya will be in touch/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept quote' })).toHaveCount(0);
  await expect(quote).toContainText('Accepted');
  await shop.context.close();
});

test('a quote that needs the owner’s OK appears once they send it', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  await page.goto(`/q/${shop.slug}`);
  await askForQuote(page, { withPhoto: false });
  await expect(
    page.getByText(/Maya at Moss & Stone Exterior Care will look this over/),
  ).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByLabel('Message')).toHaveAttribute('placeholder', 'Add a note for Maya');

  await shop.approveWaiting();
  await expect(page.getByRole('article', { name: /from Moss & Stone/ })).toBeVisible({
    timeout: 25_000,
  });
  await page.getByRole('button', { name: 'Request a site visit' }).click();
  await expect(page.getByText(/Maya will get in touch to set up a visit/)).toBeVisible();
  await shop.context.close();
});

test('the owner trying their own link gets a test chat with no code', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  const page = await shop.context.newPage();
  await page.goto(`/q/${shop.slug}`);
  await page.getByRole('button', { name: 'House wash' }).click();
  await expect(page.getByText(/this is a test\. Nothing is emailed or billed/)).toBeVisible();
  await page.getByLabel('Message').fill('Two-story house, vinyl siding.');
  await page.getByLabel('Message').press('Enter');
  await page.getByRole('button', { name: 'Skip photos' }).click();
  await page.getByLabel('Your name').fill('Test Customer');
  await page.getByLabel('Your email').fill('test@example.test');
  await page.getByRole('button', { name: 'See my quote' }).click();
  await expect(page.getByText(/will look this over/)).toBeVisible();
  await shop.context.close();
});

test('the website widget opens the chat on the business’s site and falls back elsewhere', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  const host = (src: string, style: string) =>
    `<!doctype html><html><body><h1>Moss &amp; Stone</h1><div data-quotefolk-inline="${shop.slug}"></div><script src="${src}" data-quotefolk="${shop.slug}" data-style="${style}" async></script></body></html>`;

  // Quotefolk's own pages may always show it, for the owner's previews.
  await page.route(`${baseURL}/widget-host`, (route) =>
    route.fulfill({ contentType: 'text/html', body: host('/widget.js', 'floating') }),
  );
  await page.goto('/widget-host');
  await page.getByRole('button', { name: 'Get a quote' }).click();
  const chat = page.frameLocator('iframe[title="Get a quote"]');
  await expect(chat.getByText(/I'm the quote assistant for Moss & Stone/)).toBeVisible();
  await chat.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('iframe[title="Get a quote"]')).toBeHidden();

  // Any other site can't frame the chat, so customers get a link to the quote page instead.
  const other = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(host(`${baseURL}/widget.js`, 'inline'));
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  await page.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`);
  await page.getByRole('button', { name: 'Start my quote' }).click();
  const fallback = page.getByRole('link', { name: 'Open the quote form' });
  await expect(fallback).toBeVisible({ timeout: 15_000 });
  await expect(fallback).toHaveAttribute('href', `${new URL(baseURL!).origin}/q/${shop.slug}`);
  other.close();
  await shop.context.close();
});
