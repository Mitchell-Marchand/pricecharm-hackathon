import { expect, test, type Page } from '@playwright/test';
import { createBusiness } from './helpers';

/** A draft business set up through the API, at its practice customers. */
async function startPractice(page: Page) {
  await page.goto('/');
  const headers = { Origin: new URL(page.url()).origin };
  const send = async (method: 'post' | 'patch', url: string, data: object) => {
    const response = await page.request[method](url, { headers, data });
    expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
  };
  await send('post', '/api/v1/onboarding/start', {});
  await send('patch', '/api/v1/onboarding/business', {
    tradeId: 'pressure-washing',
    services: ['Driveways', 'Patios & pavers'],
    name: 'Moss & Stone Exterior Care',
    area: 'Portland, OR',
  });
  await send('patch', '/api/v1/onboarding/step', { step: 'practice' });
  await page.goto('/start/practice');
}

test('an owner turns a practice customer down, and the rule it saves can be changed', async ({
  page,
}) => {
  await startPractice(page);
  await expect(page.getByText('Dana R. · Eastgate')).toBeVisible({ timeout: 20_000 });
  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('How big is the patio?');
  await reply.press('Enter');
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible();

  await page.getByRole('button', { name: 'We don’t do this job' }).click();
  const sheet = page.getByRole('dialog', { name: 'Why not?' });
  for (const reason of [
    'Too small',
    'Too big',
    'Not something we do',
    'Too far away',
    'Can’t fit it in',
    'Something else',
  ])
    await expect(sheet.getByRole('button', { name: reason })).toBeVisible();
  await sheet.getByRole('button', { name: 'Too small' }).click();
  // Filled in from this customer's job.
  await expect(sheet.getByRole('textbox', { name: 'Size', exact: true })).not.toHaveValue('');
  await expect(sheet.getByRole('textbox', { name: 'What the size is in' })).toHaveValue('sq ft');
  await sheet.getByRole('textbox', { name: 'Size', exact: true }).fill('400');
  await sheet.getByRole('button', { name: 'Turn it down' }).click();

  await expect(page.getByText('No worries, thanks for letting me know.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Here.s what your Charm picked up/ })).toBeVisible(
    {
      timeout: 15_000,
    },
  );
  await expect(page.getByText('You turned Dana down: too small.')).toBeVisible();
  await expect(page.getByText('Turns down jobs of 400 sq ft or less')).toBeVisible();
  await expect(page.getByText('Asks about size')).toBeVisible();

  await page.getByRole('button', { name: 'Change' }).click();
  const change = page.getByRole('dialog', { name: 'Too small' });
  await change.getByRole('textbox', { name: 'Size', exact: true }).fill('300');
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Turns down jobs of 300 sq ft or less')).toBeVisible();

  // The next customer comes, and this one is too far.
  await page.getByRole('button', { name: /^(Next customer|Keep training)/ }).click();
  await expect(page.getByText('Marcus T. · North Hills')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'We don’t do this job' }).click();
  await page
    .getByRole('dialog', { name: 'Why not?' })
    .getByRole('button', { name: 'Too far away' })
    .click();
  const far = page.getByRole('dialog', { name: 'Why not?' });
  await expect(far.getByText('from Portland, OR')).toBeVisible();
  await far.getByRole('textbox', { name: 'Distance' }).fill('30');
  await far.getByRole('button', { name: 'Turn it down' }).click();
  await expect(
    page.getByText('Turns down jobs more than about 30 mi from Portland, OR'),
  ).toBeVisible({ timeout: 15_000 });
});

test('the live chat says no to what the owner turns down, and the address at the yes reaches only the owner', async ({
  page,
  browser,
  baseURL,
}) => {
  const shop = await createBusiness(browser, baseURL!, { autoSend: true });
  const owner = await shop.context.newPage();
  await owner.goto('/app/train/knows');
  await expect(owner.getByRole('heading', { name: 'Jobs you turn down' })).toBeVisible();
  await expect(owner.getByText(/Until you add one, it quotes every job/)).toBeVisible();
  await owner.getByRole('button', { name: 'Add one' }).click();
  const sheet = owner.getByRole('dialog', { name: 'Why not?' });
  await sheet.getByRole('button', { name: 'Not something we do' }).click();
  await sheet.getByLabel('What part don’t you do?').fill('Gutter repair');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByRole('list', { name: 'Jobs you turn down' })).toContainText(
    'Gutter repair',
  );

  // A customer asks for it: a kind no, no quote, and the request is closed.
  await page.goto(`/q/${shop.slug}`);
  await page.getByLabel('Message').fill('Hi, I need gutter repair on our house.');
  await page.getByLabel('Message').press('Enter');
  await expect(
    page.getByText(
      'Sorry, Moss & Stone Exterior Care doesn’t do gutter repair. Thanks for asking.',
    ),
  ).toBeVisible();
  await expect(page.getByText('This request is closed.')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);

  // The owner sees it turned down, with why.
  await owner.goto('/app');
  await owner.getByRole('tab', { name: 'All' }).click();
  await expect(owner.getByText('Turned down', { exact: true })).toBeVisible();
  await expect(
    owner.getByText(/Turned down: not something you do \(gutter repair\)/),
  ).toBeVisible();

  // A customer who says yes leaves the job's address with their details.
  const yes = await browser.newPage({ baseURL });
  await yes.goto(`/q/${shop.slug}`);
  await yes.getByRole('button', { name: 'Driveways' }).click();
  await expect(yes.getByText(/\[Demo\] Thanks!/)).toBeVisible();
  await yes.getByLabel('Message').fill('About 600 sq ft, fits two cars, in 97214.');
  await yes.getByLabel('Message').press('Enter');
  await yes.getByRole('button', { name: 'Skip photos' }).click();
  await expect(yes.getByRole('article', { name: /from Moss & Stone/ })).toBeVisible();
  await yes.getByRole('button', { name: 'Looks good to me' }).click();
  await yes.getByLabel('Your name').fill('Sam Kim');
  await yes.getByLabel('Your email').fill('sam@example.test');
  await yes.getByLabel('The job’s street address').fill('12 Elm Street, Portland');
  await expect(yes.getByText(/gets your name, how to reach you, the job address/)).toBeVisible();
  await yes.getByRole('button', { name: /^Let .+ know$/ }).click();
  await expect(yes.getByText(/be in touch to schedule/)).toBeVisible();
  await expect(yes.getByText('12 Elm Street')).toHaveCount(0);

  const accepted = (
    await (await shop.context.request.get('/api/v1/app/quotes?filter=accepted')).json()
  ).data;
  await owner.goto(`/app/quotes/${accepted[0].id}`);
  await expect(owner.getByText('Job address: 12 Elm Street, Portland')).toBeVisible();

  // The owner can stop asking for it.
  await owner.goto('/app/settings');
  await expect(owner.getByRole('heading', { name: 'Jobs you turn down' })).toBeVisible();
  await expect(owner.getByRole('heading', { name: 'Where you work' })).toBeVisible();
  await owner.getByRole('radio', { name: 'Don’t ask' }).click();
  await expect(owner.getByText('Saved. Customers aren’t asked for the address.')).toBeVisible();
  await yes.close();
  await shop.context.close();
});
