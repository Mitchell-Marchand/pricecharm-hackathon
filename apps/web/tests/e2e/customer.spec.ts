import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createBusiness, expectQuoteFromTop } from './helpers';

const photo = path.resolve('public/photos/patio-stains.jpg');
// Three seconds of a test pattern: demo mode measures any video the same way.
const walkaround = path.resolve('tests/e2e/fixtures/walkaround.mp4');

/** Describes the job. The quote, or the owner's hold on it, follows the last answer. */
async function askForQuote(page: Page, { withPhoto }: { withPhoto: boolean }) {
  await expect(page.getByText(/I'm the quote assistant for Moss & Stone/)).toBeVisible();
  await page.getByRole('button', { name: 'Driveways' }).click();
  await expect(page.getByText(/\[Demo\] Thanks!/)).toBeVisible();
  await page.getByLabel('Message').fill('About 600 sq ft, fits two cars.');
  await page.getByLabel('Message').press('Enter');
  await expect(page.getByRole('button', { name: 'Skip photos' })).toBeVisible();
  if (withPhoto) {
    await page.locator('input[type=file][accept="image/*"]').setInputFiles(photo);
    await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
    // Like a video, the photo is read while the chat says so, and the assistant carries on after.
    await expect(
      page.getByText('Looking over your photos and counting what’s in them…'),
    ).toBeVisible();
  } else await page.getByRole('button', { name: 'Skip photos' }).click();
}

test('a customer sees a quote on the owner’s page, comes back to it, and says yes', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!, { acceptLabel: '' });
  await shop.learnDriveways();
  await shop.autoSend(true);

  // The owner adds their logo, says who customers hear from and what they read after a yes, and
  // picks the button's words rather than letting PriceCharm try some.
  const owner = await shop.context.newPage();
  await owner.goto('/app/settings');
  await owner.getByLabel('Logo').setInputFiles(photo);
  await expect(owner.getByText('Your logo is on your chat and your quotes.')).toBeVisible();
  await expect(owner.locator('img[src*="/logo/"]')).toBeVisible();
  await owner.getByLabel('Name customers see').fill('Jenny');
  await owner.getByLabel('Name customers see').blur();
  await expect(owner.getByText('Saved. Customers hear from Jenny.')).toBeVisible();
  const afterYes = owner.getByLabel('After a customer accepts');
  await expect(afterYes).toHaveValue('You’re all set. Jenny will be in touch to schedule.');
  await afterYes.fill('Thanks! Jenny will text you today to pick a day.');
  await afterYes.blur();
  await expect(owner.getByText('Saved. Customers see this after they accept.')).toBeVisible();
  await expect(
    owner.getByText(/PriceCharm tries “Looks good to me”, “Works for me”/),
  ).toBeVisible();
  await owner.getByRole('radio', { name: 'Choose my own' }).click();
  await owner.getByRole('button', { name: 'Works for me' }).click();
  await expect(owner.getByText('Saved. The button says “Works for me”.')).toBeVisible();

  await page.goto(`/q/${shop.slug}`);
  await expect(page).toHaveTitle(/Get a quote from Moss & Stone Exterior Care/);
  await expect(page.locator('header img[src*="/logo/"]')).toBeVisible();
  await askForQuote(page, { withPhoto: true });

  const quote = page.getByRole('article', { name: /from Moss & Stone Exterior Care/ });
  await expect(quote).toBeVisible();
  await expect(quote).toContainText('$275');
  await expect(quote.locator('img[src*="/logo/"]')).toBeVisible();
  await expect(page.getByText('Here’s your quote.')).toBeVisible();
  await expect(page.getByText('Where should we send your quote?')).toHaveCount(0);
  await expectQuoteFromTop(quote);

  // Coming back to answer it, it opens on the quote again, once their photo has loaded above it.
  await page.reload();
  await expect(quote).toBeVisible();
  await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
  await expectQuoteFromTop(quote);
  // The browser can move the chat on its own as things load. Until the customer scrolls or taps,
  // the quote goes back to the top.
  await quote.evaluate((card) => {
    let scroller = card.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto')
      scroller = scroller.parentElement;
    scroller!.scrollTop = scroller!.scrollHeight;
  });
  await expectQuoteFromTop(quote);
  // Saying yes asks where Jenny can reach them, and that's the yes.
  await expect(quote).toContainText('No payment now. Jenny will reach out to book a time.');
  await quote.getByRole('button', { name: 'Works for me' }).click();
  await expect(page.getByText('Where can Jenny reach you to book?')).toBeVisible();
  await page.getByLabel('Your name').fill('Sam Kim');
  await page.getByLabel('Your phone number').fill('503 555 0142');
  await page.getByRole('button', { name: 'Let Jenny know' }).click();
  await expect(page.getByText('Thanks! Jenny will text you today to pick a day.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Works for me' })).toHaveCount(0);
  await expect(quote).toContainText('Accepted');
  await expect(quote).toContainText('Sam K.');

  // The owner sees which words the customer tapped.
  const accepted = (
    await (await shop.context.request.get('/api/v1/app/quotes?filter=accepted')).json()
  ).data;
  await owner.goto(`/app/quotes/${accepted[0].id}`);
  await expect(owner.getByText('Sam tapped “Works for me”.')).toBeVisible();
  await expect(owner.getByText(/503 555 0142/)).toBeVisible();
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
    page.getByText(/Maya at Moss & Stone Exterior Care wants to look this one over/),
  ).toBeVisible();
  await page.getByLabel('Your name').fill('Sam Kim');
  await page.getByLabel('Your email').fill('sam@example.test');
  await page.getByRole('button', { name: 'Send it to me' }).click();
  await expect(page.getByText(/We’ll email you as soon as Maya sends it/)).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByLabel('Message')).toHaveAttribute('placeholder', 'Add a note for Maya');

  await shop.approveWaiting();
  await expect(page.getByRole('article', { name: /from Moss & Stone/ })).toBeVisible({
    timeout: 25_000,
  });
  await page.getByRole('button', { name: 'Request a site visit' }).click();
  await expect(page.getByText(/Maya will get in touch to set up a visit/)).toBeVisible();

  // Another customer films the job instead. It's measured after the upload, the assistant carries
  // on from what was found, and the owner sees the count and the video with the quote.
  const filming = await browser.newPage({ baseURL });
  await filming.goto(`/q/${shop.slug}`);
  await filming.getByRole('button', { name: 'House wash' }).click();
  await expect(filming.getByText(/\[Demo\] Thanks!/)).toBeVisible();
  await filming.locator('input[type=file][accept^="video"]').setInputFiles(walkaround);
  await expect(filming.getByText('Counted: 12 windows')).toBeVisible({ timeout: 20_000 });
  await expect(filming.getByText(/Watching your video/)).toHaveCount(0);
  await expect(filming.getByText(/wants to look this one over/)).toBeVisible();
  await filming.getByLabel('Your name').fill('Ana Ruiz');
  await filming.getByLabel('Your email').fill('ana@example.test');
  await filming.getByRole('button', { name: 'Send it to me' }).click();
  await expect(filming.getByText(/We’ll email you as soon as Maya sends it/)).toBeVisible();
  const waiting = await shop.context.request.get('/api/v1/app/quotes?filter=review');
  const [filmed] = (await waiting.json()).data;
  const owner = await shop.context.newPage();
  await owner.goto(`/app/quotes/${filmed.id}`);
  await expect(owner.getByRole('heading', { name: 'Measured from their video' })).toBeVisible();
  await expect(owner.getByText('12 windows', { exact: true })).toBeVisible();
  await expect(
    owner.getByText(/each one followed through the video and counted once/),
  ).toBeVisible();
  await expect(owner.getByLabel('Ana Ruiz’s video')).toBeVisible();
  await filming.close();
  await shop.context.close();
});

test('the owner trying their own link always sees the quote, and why it would wait', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!, { autoSend: true });
  const page = await shop.context.newPage();
  const tryHouseWash = async () => {
    await page.getByRole('button', { name: 'House wash' }).click();
    await expect(page.getByText(/this is a test\. Nothing is emailed or billed/)).toBeVisible();
    await expect(page.getByText(/\[Demo\] Thanks!/)).toBeVisible();
    await page.getByLabel('Message').fill('Two-story house, vinyl siding.');
    await page.getByLabel('Message').press('Enter');
    await page.getByRole('button', { name: 'Skip photos' }).click();
  };
  await page.goto(`/q/${shop.slug}`);

  // Quoting on its own, for a service it hasn't priced yet: a price range, right away.
  await tryHouseWash();
  const quote = page.getByRole('article', { name: /from Moss & Stone.*price range \$/ });
  await expect(quote).toBeVisible();
  await expect(quote).toContainText('Price range');
  await expect(page.getByText(/Maya confirms the final price before starting\./)).toBeVisible();
  await expect(page.getByText(/will look this over/)).toHaveCount(0);

  // Checking each quote first: it still shows the draft, and why a customer would wait.
  await shop.autoSend(false);
  await page.getByRole('button', { name: 'Try another request' }).click();
  await tryHouseWash();
  await expect(page.getByText('Here’s the quote your Charm drafted.')).toBeVisible();
  await expect(page.getByText('A real customer would wait for your OK on this one.')).toBeVisible();
  await expect(page.getByText('You approve each quote for now.')).toBeVisible();
  await expect(page.getByRole('article', { name: /from Moss & Stone/ })).toContainText('Draft');
  await expect(page.getByRole('link', { name: 'Open it in your quotes' })).toBeVisible();
  await shop.context.close();
});

test('the website widget opens the chat on the business’s site and falls back elsewhere', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  const host = (src: string, style: string) =>
    `<!doctype html><html><body><h1>Moss &amp; Stone</h1><div data-pricecharm-inline="${shop.slug}"></div><script src="${src}" data-pricecharm="${shop.slug}" data-style="${style}" async></script></body></html>`;

  // PriceCharm's own pages may always show it, for the owner's previews.
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
