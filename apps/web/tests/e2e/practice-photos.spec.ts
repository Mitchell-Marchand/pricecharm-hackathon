import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import mysql from 'mysql2/promise';

// A phone: 390 by 844, with touch, so the page is laid out and hinted the way a phone has it.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/**
 * A setup draft made through the API, straight into practice: a pressure-washing business in
 * Portland with one past job, so its customers are demo mode's written ones.
 */
async function practiceDraft(page: Page) {
  await page.goto('/');
  const headers = { Origin: new URL(page.url()).origin };
  const send = async (method: 'post' | 'patch', url: string, data: object) => {
    const response = await page.request[method](url, { headers, data });
    expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  };
  await send('post', '/api/v1/onboarding/start', {});
  await send('patch', '/api/v1/onboarding/business', {
    tradeId: 'pressure-washing',
    services: ['Patios & pavers', 'Driveways'],
    name: 'Moss & Stone Exterior Care',
    area: 'Portland, OR',
  });
  await send('post', '/api/v1/onboarding/jobs', {
    serviceName: 'Patios & pavers',
    description: 'Back patio and walkway, about 600 sq ft.',
    priceCents: 27500,
    size: '600 sq ft',
  });
  await page.goto('/start/practice');
  await expect(page.getByRole('heading', { name: 'Dana R.' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Practice · Eastgate · 6 mi away')).toBeVisible();
}

async function database<T>(task: (db: mysql.Connection) => Promise<T>) {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'quoting_engine',
    password: process.env.DB_PASS ?? 'local-dev-only',
    database: process.env.DB_NAME ?? 'quoting_test',
  });
  try {
    return await task(db);
  } finally {
    await db.end();
  }
}

/** Nothing on the page reaches past the screen's edge, so it never slides sideways. */
async function expectNoSideways(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

/** Two fingers on the photo, spread apart, the way a pinch reaches the page. */
async function pinch(stage: Locator, spread: number) {
  await stage.evaluate((element, apart) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    const fire = (type: string, pointerId: number, dx: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          clientX: x + dx,
          clientY: y,
          bubbles: true,
          isPrimary: pointerId === 1,
        }),
      );
    fire('pointerdown', 1, -20);
    fire('pointerdown', 2, 20);
    for (let step = 1; step <= 5; step++) {
      fire('pointermove', 1, -20 - (apart * step) / 5);
      fire('pointermove', 2, 20 + (apart * step) / 5);
    }
    fire('pointerup', 1, -20 - apart);
    fire('pointerup', 2, 20 + apart);
  }, spread);
}

async function swipe(stage: Locator, dx: number) {
  await stage.evaluate((element, distance) => {
    const box = element.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const fire = (type: string, x: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          isPrimary: true,
        }),
      );
    const from = box.left + box.width / 2;
    fire('pointerdown', from);
    fire('pointermove', from + distance / 2);
    fire('pointerup', from + distance);
  }, dx);
}

test('on a phone, the owner looks over the photos, asks for more and zooms in', async ({
  page,
}) => {
  await practiceDraft(page);
  await expect(page.getByText('What your Charm saw')).toHaveCount(0);

  // The photos open full screen, zoom with a pinch and swipe to the next one.
  await page.getByRole('button', { name: 'Open photo 1 of 2 from Dana R.' }).click();
  const viewer = page.getByRole('dialog', { name: 'Photo from Dana R.' });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('1 of 2');
  expect(await viewer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  const photo = viewer.getByRole('img', { name: 'Photo from Dana R.' });
  const stage = photo.locator('..');
  await expect(photo).toHaveAttribute('data-scale', '1.00');
  await pinch(stage, 80);
  await expect(photo).not.toHaveAttribute('data-scale', '1.00');
  expect(Number(await photo.getAttribute('data-scale'))).toBeGreaterThan(1.5);
  await expectNoSideways(page);
  // Zoomed in, a drag looks around instead of moving on.
  await swipe(stage, -120);
  await expect(viewer).toContainText('1 of 2');
  // A double tap zooms back out, and in again where it lands.
  const box = (await stage.boundingBox())!;
  const doubleTap = async () => {
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  await doubleTap();
  await expect(photo).toHaveAttribute('data-scale', '1.00');
  await doubleTap();
  await expect(photo).toHaveAttribute('data-scale', '2.50');
  await doubleTap();
  await expect(photo).toHaveAttribute('data-scale', '1.00');
  await swipe(stage, -120);
  await expect(viewer).toContainText('2 of 2');
  await page.screenshot({ path: test.info().outputPath('viewer.png') });
  await expect(viewer.getByText('Pinch or double-tap to zoom.')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close photo' }).click();
  await expect(viewer).toBeHidden();

  // The prepared photo comes at once. The next is taken for what was asked.
  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('Can you send a closer photo by the door?');
  await reply.press('Enter');
  await expect(page.getByText(/right outside the sliding door/)).toBeVisible();
  await reply.fill('Any more pictures of the whole thing?');
  await reply.press('Enter');
  await expect(page.getByText("Here's the whole patio from the back steps.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Taking a photo…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open photo/ })).toHaveCount(4);
  await page.getByRole('button', { name: 'Open photo 1 of 1 from Dana R.' }).last().click();
  await expect(viewer).toContainText('4 of 4');
  await viewer.press('ArrowRight');
  await expect(viewer).toContainText('1 of 4');
  await viewer.press('Escape');
  await expect(viewer).toBeHidden();
  await expectNoSideways(page);

  await page.getByRole('button', { name: 'Send quote' }).click();
  const builder = page.getByRole('dialog', { name: /^Quote for / });
  await builder.getByRole('textbox', { name: 'Item 1', exact: true }).fill('Patio wash, 800 sq ft');
  await builder.getByRole('textbox', { name: 'Price for item 1' }).fill('360');
  await builder.getByRole('button', { name: 'Send quote' }).click();
  await expect(
    page.getByRole('heading', { name: /Here.s what your Charm picked up/ }),
  ).toBeVisible();
  await expectNoSideways(page);
});

test('on a phone, the chat gets the screen', async ({ page }) => {
  // What Safari leaves of an 844 pt phone with its bars showing.
  await page.setViewportSize({ width: 390, height: 664 });
  await practiceDraft(page);
  const header = (await page.getByRole('meter').boundingBox())!;
  const buttons = (await page.getByRole('button', { name: 'Send quote' }).boundingBox())!;
  const headerBottom = header.y + header.height;
  // Over 55% of the whole phone is chat, and it starts right under the header.
  expect(buttons.y - headerBottom).toBeGreaterThan(844 * 0.55);
  const photo = (await page.getByRole('button', { name: /^Open photo 1 of 2/ }).boundingBox())!;
  expect(photo.y - headerBottom).toBeLessThan(160);
  await expectNoSideways(page);

  // The way out is behind the menu.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Finish later' }).click();
  await expect(page.getByRole('dialog', { name: 'Save your Charm' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // The keyboard needs the room, so the buttons step aside while typing. Once it's sent they're
  // back, with the keyboard still up, so quoting never means closing it first.
  const reply = page.getByLabel('Reply to Dana');
  await reply.fill('How big is it?');
  await expect(page.getByRole('button', { name: 'Send quote' })).toBeHidden();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send quote' })).toBeVisible();
});

test('on a phone, a customer on the way says so above the reply box', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await practiceDraft(page);
  const runId = (await (await page.request.get('/api/v1/onboarding/practice')).json()).data.runs[0]
    .id as string;
  // As if this customer were still being written.
  await database((db) =>
    db.query(
      "UPDATE practice_runs SET status='preparing',prepare_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND) WHERE id=?",
      [runId],
    ),
  );
  await page.reload();
  const note = page.getByRole('status').filter({ hasText: 'Your customer is on the way' });
  await expect(note).toBeVisible({ timeout: 10_000 });
  const line = (await note.boundingBox())!;
  const reply = (await page.getByRole('textbox').boundingBox())!;
  expect(line.y + line.height).toBeLessThanOrEqual(reply.y);
  expect(line.y + line.height).toBeLessThanOrEqual(664);

  await database((db) =>
    db.query("UPDATE practice_runs SET status='ready',prepare_until=NULL WHERE id=?", [runId]),
  );
  await expect(page.getByRole('button', { name: /^Open photo 1 of 2/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect(note).toHaveCount(0);
});

test('the chat never waits on the photos being read', async ({ page }) => {
  await practiceDraft(page);
  const runId = (await (await page.request.get('/api/v1/onboarding/practice')).json()).data.runs[0]
    .id as string;
  // As if a reading were still running: it holds the photos, partway through counting.
  await database((db) =>
    db.query(
      'UPDATE practice_runs SET photo_reading_json=NULL,photo_read_token=?,photo_read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),photo_progress_json=? WHERE id=?',
      [
        randomUUID(),
        JSON.stringify({ step: 'counting', counting: ['planters'], seen: 'A patio by a door.' }),
        runId,
      ],
    ),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dana R.' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Your Charm is looking at the photos')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send quote' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Turn down' })).toBeEnabled();
  await page.getByLabel('Reply to Dana').fill('How big is it?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Maybe 550 sq ft in total/)).toBeVisible();
});
