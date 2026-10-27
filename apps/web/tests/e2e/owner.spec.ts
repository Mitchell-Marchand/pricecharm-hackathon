import { expect, test, type Page } from '@playwright/test';
import { approveLinkFor, createBusiness, OWNER_PASSWORD, waitingQuote } from './helpers';

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

test('an owner goes live from the dashboard, turns on automatic quotes and signs out', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!, { billing: false });
  const page = await shop.context.newPage();
  await page.goto(`/q/${shop.slug}`);
  await expect(
    page.getByText(/I'm the quote assistant for Moss & Stone/),
    'Not deployed yet, but the owner still gets their test chat',
  ).toBeVisible();
  const visitor = await browser.newPage({ baseURL });
  await visitor.goto(`/q/${shop.slug}`);
  await expect(
    visitor.getByText('Moss & Stone Exterior Care isn’t taking quote requests here right now.'),
  ).toBeVisible();

  await page.goto('/app');
  const goLive = page.getByRole('region', { name: 'Choose a plan to go live' });
  await expect(goLive).toBeVisible();
  // Confirming the email is asked for, never in the way.
  await expect(page.getByLabel('Code from the email')).toBeVisible();
  await goLive.getByRole('link', { name: 'Finish going live' }).click();
  await expect(page).toHaveURL(/\/start\/live$/);
  await page
    .getByRole('listitem', { name: 'Pay when you win' })
    .getByRole('button', { name: 'Start with 1% a job' })
    .click();
  await page.getByRole('button', { name: 'Deploy your agent' }).click();
  await expect(page.getByRole('heading', { name: /You.re live\./ })).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByText(/I'm the quote assistant for Moss & Stone/)).toBeVisible();
  await visitor.close();

  await page.goto('/app');
  await expect(page.getByText('Hi Maya')).toBeVisible();
  await expect(goLive).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Agent readiness' })).toContainText(
    'Keep training',
  );
  await page.goto('/app/settings');
  await expect(page.getByText('1% when they say yes', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Paused' }).click();
  await expect(page.getByText('Your quote link is paused.')).toBeVisible();
  await page.getByRole('radio', { name: 'Taking requests' }).click();
  await expect(page.getByText('Your quote link is on.')).toBeVisible();

  await page.getByRole('radio', { name: 'Send them on their own' }).click();
  await expect(page.getByText('Quotes can go out on their own now.')).toBeVisible();
  await page.getByLabel('Always ask me about quotes over').fill('900');
  await page.getByLabel('Always ask me about quotes over').blur();
  await expect(page.getByText('Saved. Quotes over $900 wait for you.')).toBeVisible();

  await page.goto('/app');
  await expect(page.getByText(/Quotes up to \$900 that match your usual prices/)).toBeVisible();
  await page.getByRole('link', { name: 'Train', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What your AI knows' })).toBeVisible();
  await expect(page.getByText('It learned from 3 past jobs.')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Your Driveways jobs' }).getByRole('listitem'),
    'Three driveway jobs fill its small, usual and big slots',
  ).toHaveCount(3);
  await expect(
    page.getByRole('list', { name: 'Your services' }).getByRole('listitem').first(),
  ).toContainText('Checks with you until it comes within 15% of your price on 2 jobs.');
  await page.getByRole('link', { name: 'Share' }).click();
  await expect(page.getByText(new RegExp(`/q/${shop.slug}$`))).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
  await shop.context.close();
});

test('an owner resets a forgotten password, then signs out from the menu at the top', async ({
  page,
  browser,
  baseURL,
}) => {
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

  // Signups are rate limited, so signing out rides along with this owner.
  const account = page.getByRole('button', { name: /^Account/ });
  await account.click();
  const menu = page.locator(`[id="${await account.getAttribute('aria-controls')}"]`);
  await expect(menu).toContainText(shop.email);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();

  await page.goto('/start/business');
  await expect(page.getByRole('button', { name: /Finish later/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Account/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
});

test('after setup, an owner practices with as many customers as they like', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  const page = await shop.context.newPage();
  await page.goto('/app/train');
  await page.getByRole('link', { name: 'Practice with a customer' }).click();
  await expect(page).toHaveURL(/\/app\/train\/practice\?run=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Practice with a customer' })).toBeVisible();
  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 15_000 });

  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('How big is the patio?');
  await reply.press('Enter');
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible();
  // The customer is in the address, so a reload comes back to the same chat.
  await page.reload();
  await expect(page.getByText('How big is the patio?')).toBeVisible();

  await page.getByRole('button', { name: 'Create quote' }).click();
  const builder = page.getByRole('dialog', { name: /^Quote for / });
  await builder.getByRole('textbox', { name: 'Item 1', exact: true }).fill('Patio wash');
  await builder.getByRole('textbox', { name: 'Price for item 1' }).fill('280');
  await builder.getByRole('button', { name: 'Send quote' }).click();
  await expect(page.getByRole('heading', { name: /Here.s what your AI picked up/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('1 practice customer so far.')).toBeVisible();

  await page.getByRole('button', { name: 'Practice another' }).click();
  await expect(page.getByText('Marcus T. · North Hills')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Reply to Marcus')).toBeEditable();
  await page.goto('/app/train');
  await expect(
    page.getByText(/It learned from 3 past jobs and 1 practice customer\./),
  ).toBeVisible();
  await shop.context.close();
});

test('the "needs your OK" email opens the quote with one tap to send it', async ({
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!);
  const link = await approveLinkFor(await waitingQuote(baseURL!, shop.slug, 'Lee Park'));
  // A fresh browser, like a phone's mail app: nobody is signed in.
  const page = await browser.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Lee wants a driveways quote' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Why it.s waiting for you/ })).toBeVisible();
  await expect(page, 'The token leaves the address bar').toHaveURL(/\/approve\/[0-9a-f-]{36}$/);
  await page.reload();
  const approve = page.getByRole('button', { name: /^Approve and send \$/ });
  await expect(approve, 'A reload in the same tab still works').toBeVisible();
  await expect(page.getByRole('link', { name: 'Open it in your dashboard' })).toHaveAttribute(
    'href',
    /\/app\/quotes\/[0-9a-f-]{36}$/,
  );
  await approve.click();
  await expect(page.getByRole('heading', { name: 'Sent to Lee.' })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'This quote has already gone out.' }),
  ).toBeVisible();
  await page.close();
  await shop.context.close();
});
