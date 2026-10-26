import { expect, test, type Page } from '@playwright/test';
import { createBusiness, OWNER_PASSWORD, waitingQuote } from './helpers';

async function signIn(page: Page, email: string, password = OWNER_PASSWORD) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('an owner signs in, edits and sends one quote, and declines another', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  await waitingQuote(baseURL!, shop.slug, 'Sam Kim');
  await waitingQuote(baseURL!, shop.slug, 'Ana Ruiz');

  await page.goto('/app');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  await signIn(page, shop.email, 'not the password');
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  await signIn(page, shop.email);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: '2 quotes need your OK.' })).toBeVisible();

  await page.getByRole('link', { name: /Sam Kim/ }).click();
  await expect(page.getByRole('heading', { name: 'Sam Kim' })).toBeVisible();
  await expect(page.getByText('You approve each quote for now.')).toBeVisible();
  await expect(page.getByText('[Demo] Thanks! About how big is the job?')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Price for item 1').fill('260');
  await page.getByRole('dialog').getByRole('button', { name: 'Send quote' }).click();
  await expect(page.getByText('Sent. Sam has the quote in their inbox.')).toBeVisible();
  const card = page.getByRole('article', { name: /Quote number \d+ .* total \$260/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Sent');
  await expect(page.getByText(/Here.s your quote, Sam/)).toBeVisible();

  await page.getByLabel('Message Sam').fill('Can you move the cars before we arrive?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Can you move the cars before we arrive?')).toBeVisible();

  await page.getByRole('link', { name: 'All quotes' }).click();
  await expect(page.getByRole('heading', { name: '1 quote needs your OK.' })).toBeVisible();
  await page.getByRole('link', { name: /Ana Ruiz/ }).click();
  await page.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByLabel('Your message to Ana')).toHaveValue(/Thanks for asking, Ana/);
  await page.getByRole('button', { name: 'Decline and send' }).click();
  await expect(page.getByText('Declined. Ana got your message.')).toBeVisible();
  await expect(page.getByText('You declined this one.')).toBeVisible();

  await page.getByRole('link', { name: 'Quotes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re all caught up.' })).toBeVisible();
  await shop.context.close();
});

test('an owner adds a payment method, turns on automatic quotes and signs out', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!, { billing: false });
  const page = await shop.context.newPage();
  await page.goto('/app');
  const payment = page.getByRole('region', { name: 'Add a payment method so quotes can go out' });
  await expect(payment).toContainText('1% of each quote');
  await expect(payment).toContainText('Confirm your email first.');
  await expect(payment.getByRole('button', { name: 'Add a payment method' })).toBeDisabled();

  // Locally no email is sent, so the banner offers the link itself.
  await page.getByRole('button', { name: 'Send the link again' }).click();
  await page.getByRole('link', { name: 'Local test: confirm it now' }).click();
  await expect(page.getByRole('heading', { name: 'Your email is confirmed' })).toBeVisible();
  await page.goto('/app');
  await payment.getByRole('button', { name: 'Add a payment method' }).click();
  await expect(page).toHaveURL(/\/app\/settings/);
  await expect(page.getByText('Billing is on.')).toBeVisible();
  await page.goto('/app');
  await expect(page.getByText('Hi Maya')).toBeVisible();
  await expect(payment).toHaveCount(0);

  await page.goto('/app/settings');
  await page.getByRole('radio', { name: 'Send them on their own' }).click();
  await expect(page.getByText('Quotes can go out on their own now.')).toBeVisible();
  await page.getByLabel('Always ask me about quotes over').fill('900');
  await page.getByLabel('Always ask me about quotes over').blur();
  await expect(page.getByText('Saved. Quotes over $900 wait for you.')).toBeVisible();

  await page.goto('/app');
  await expect(page.getByText(/Quotes up to \$900 that match your usual prices/)).toBeVisible();
  await page.getByRole('link', { name: 'Train' }).click();
  await expect(page.getByRole('heading', { name: 'What your AI knows' })).toBeVisible();
  await expect(page.getByText('It learned from 3 past jobs.')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Your past jobs' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.getByRole('link', { name: 'Share' }).click();
  await expect(page.getByText(new RegExp(`/q/${shop.slug}$`))).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
  await shop.context.close();
});

test('an owner resets a forgotten password', async ({ page, browser, baseURL }) => {
  const shop = await createBusiness(browser, baseURL!);
  await shop.context.close();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(shop.email);
  await page.getByRole('button', { name: 'Send me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByRole('link', { name: 'open the reset link' }).click();
  await page.getByLabel('New password').fill('a brand new password');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signIn(page, shop.email, 'a brand new password');
  await expect(page).toHaveURL(/\/app$/);
});
