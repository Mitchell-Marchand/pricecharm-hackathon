import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message, TrainingSession } from '../../src/lib/types';

type Photo = {
  id: string;
  url: string;
  alt: string;
  label: string;
  kind: 'sample_photo';
  width: number;
  height: number;
};
type PhotoMessage = Message & {
  photos?: {
    requestId: string;
    status: 'pending' | 'ready' | 'failed';
    error?: string;
    attachments: Photo[];
  };
};
type Practice = Omit<TrainingSession, 'messages'> & { messages: PhotoMessage[] };

const ids = {
  business: '10000000-0000-4000-8000-000000000001',
  service: '10000000-0000-4000-8000-000000000002',
  practice: '10000000-0000-4000-8000-000000000003',
  other: '10000000-0000-4000-8000-000000000004',
  request: '10000000-0000-4000-8000-000000000005',
};

async function photoHarness(page: Page, failed = false) {
  const createdAt = '2026-10-27T12:00:00.000Z';
  const business = {
    id: ids.business,
    name: 'Fictional Painting Photo Test',
    slug: 'fictional-painting-photo-test',
    description: 'Interior painting for homes.',
    industry: 'Painting',
    serviceArea: 'Austin',
    currency: 'USD',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt,
  };
  const service = {
    id: ids.service,
    businessId: ids.business,
    name: 'Interior painting',
    description: 'Painting a living room, kitchen, and bedroom.',
    unitLabel: 'room',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: [],
    exclusions: [],
    mode: 'review',
    publishedAt: null,
    version: 1,
  };
  const initial: PhotoMessage[] = [
    {
      id: '20000000-0000-4000-8000-000000000001',
      role: 'assistant',
      content: 'I need my living room, kitchen, and bedroom painted. Can you quote the work?',
      createdAt,
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      role: 'user',
      content: 'Can you send me photos?',
      createdAt,
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      role: 'assistant',
      content: 'I’ll send them later.',
      createdAt,
    },
  ];
  const scenario = {
    title: 'Three rooms to repaint',
    customerName: 'Fictional Sam',
    description: initial[0].content,
    details: {
      quantity: '3 rooms',
      rooms: 'Living room, kitchen, bedroom',
      location: 'Austin',
      condition: 'Old paint and several patched wall areas',
    },
  };
  const current: Practice = {
    id: ids.practice,
    serviceId: ids.service,
    unitLabel: 'room',
    status: 'active',
    scenario,
    messages: [...initial],
    createdAt,
  };
  const other: Practice = {
    ...current,
    id: ids.other,
    scenario: { ...scenario, title: 'A different painting request' },
    messages: [{ ...initial[0], content: 'A different painting request with no photos.' }],
  };
  const photos: Photo[] = ['Living room', 'Kitchen', 'Bedroom'].map((label, index) => {
    const id = `30000000-0000-4000-8000-00000000000${index + 1}`;
    return {
      id,
      url: `/api/v1/training/${ids.practice}/photos/${id}`,
      label,
      alt: `Generated practice view of the ${label.toLowerCase()}`,
      kind: 'sample_photo',
      width: 16,
      height: 16,
    };
  });
  const delivery: PhotoMessage = {
    id: '20000000-0000-4000-8000-000000000004',
    role: 'assistant',
    content: 'Here are the requested practice views.',
    createdAt,
    photos: {
      requestId: ids.request,
      status: failed ? 'failed' : 'pending',
      ...(failed ? { error: 'Photo generation was unavailable.' } : {}),
      attachments: failed ? photos.slice(0, 1) : [],
    },
  };
  if (failed) current.messages.push(delivery);
  const imageBytes = await readFile(path.resolve('tests/e2e/fixtures/project-photo.png'));
  const requests = { messages: [] as string[], retries: 0, images: new Map<string, number>() };
  let ready = false;
  let failFirstImage = !failed;
  const unexpected: string[] = [];
  function snapshot(session = current) {
    if (session === current && ready && current.messages.includes(delivery)) {
      delivery.photos = {
        requestId: ids.request,
        status: 'ready',
        attachments: photos,
      };
    }
    return session;
  }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === 'GET' &&
      pathname.startsWith(`/api/v1/training/${ids.practice}/photos/`)
    ) {
      const count = (requests.images.get(pathname) || 0) + 1;
      requests.images.set(pathname, count);
      if (failFirstImage && pathname.endsWith(photos[0].id)) {
        failFirstImage = false;
        return route.fulfill({ status: 503, body: 'Temporary image failure' });
      }
      return route.fulfill({ contentType: 'image/png', body: imageBytes });
    }
    if (request.method() === 'POST' && pathname === `/api/v1/training/${ids.practice}/messages`) {
      const { content } = request.postDataJSON();
      requests.messages.push(content);
      current.messages.push(
        { ...initial[1], id: '20000000-0000-4000-8000-000000000006', content },
        delivery,
      );
      return route.fulfill({ json: { data: snapshot() } });
    }
    if (
      request.method() === 'POST' &&
      pathname === `/api/v1/training/${ids.practice}/photos/${ids.request}/retry`
    ) {
      requests.retries++;
      delivery.photos = {
        requestId: ids.request,
        status: 'pending',
        attachments: delivery.photos?.attachments || [],
      };
      return route.fulfill({ json: { data: snapshot() } });
    }
    if (request.method() === 'GET') {
      if (pathname === '/api/v1/auth/me')
        return route.fulfill({
          json: {
            data: {
              user: {
                id: '40000000-0000-4000-8000-000000000001',
                name: 'Fictional Owner',
                email: 'fictional-photos@example.test',
                emailVerified: true,
              },
              business,
            },
          },
        });
      if (pathname === '/api/v1/dashboard')
        return route.fulfill({
          json: {
            data: {
              business,
              services: [service],
              examples: [],
              trainingSessions: [snapshot(), other],
              recentQuotes: [],
              stats: {
                totalQuotes: 0,
                issuedQuotes: 0,
                reviewQuotes: 0,
                trainingCompleted: 0,
                examplesCount: 0,
                quotedValueCents: 0,
              },
              usage: { billableQuotes: 0, aiCalls: 0 },
            },
          },
        });
      if (pathname === '/api/v1/settings')
        return route.fulfill({
          json: {
            data: {
              providers: { openai: false, anthropic: false },
              aiMode: 'demo',
              billingConfigured: false,
            },
          },
        });
      if (pathname === '/api/v1/training')
        return route.fulfill({ json: { data: [snapshot(), other] } });
      if (pathname === `/api/v1/training/${ids.practice}`)
        return route.fulfill({ json: { data: snapshot() } });
      if (pathname === `/api/v1/training/${ids.other}`)
        return route.fulfill({ json: { data: other } });
      if (pathname === `/api/v1/services/${ids.service}/proposals`)
        return route.fulfill({ json: { data: { proposals: [] } } });
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({
      status: 501,
      json: {
        error: { code: 'UNEXPECTED_TEST_REQUEST', message: 'Unexpected browser fixture request.' },
      },
    });
  });
  return {
    current,
    photos,
    requests,
    unexpected,
    makeReady: () => {
      ready = true;
    },
  };
}

test('all-room follow-up recovers an old photo promise with viewable, persistent photos', async ({
  page,
}) => {
  const fixture = await photoHarness(page);
  await page.goto(`/dashboard?service=${ids.service}&practice=${ids.practice}`);
  await page
    .getByLabel('Your reply to the practice customer', { exact: true })
    .fill('All rooms, please.');
  await page.getByRole('button', { name: 'Send practice reply', exact: true }).click();
  await expect(page.getByText('Creating practice photos…', { exact: true })).toBeVisible();
  fixture.makeReady();
  await expect(page.getByText('This photo didn’t load.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry image', exact: true }).click();
  for (const photo of fixture.photos) {
    const open = page.getByRole('button', {
      name: `Open sample photo: ${photo.label}`,
      exact: true,
    });
    await expect(open).toBeVisible();
    await expect
      .poll(() => open.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(16);
  }
  expect(
    fixture.requests.images.get(new URL(fixture.photos[0].url, 'http://localhost').pathname),
  ).toBeGreaterThanOrEqual(2);
  const open = page.getByRole('button', { name: 'Open sample photo: Living room', exact: true });
  await open.click();
  const viewer = page.getByRole('dialog', { name: 'Living room', exact: true });
  await expect(viewer).toContainText('AI-generated for this practice job.');
  await expect
    .poll(() => viewer.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(16);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.reload();
  await expect(page.getByRole('button', { name: /^Open sample photo:/ })).toHaveCount(3);
  await page.getByText('Your saved jobs', { exact: true }).click();
  await page
    .locator('.practice-history-list button')
    .filter({ hasText: 'A different painting request' })
    .click();
  await expect(page.getByRole('button', { name: /^Open sample photo:/ })).toHaveCount(0);
  await page
    .locator('.practice-history-list button')
    .filter({ hasText: 'Three rooms to repaint' })
    .click();
  await expect(page.getByRole('button', { name: /^Open sample photo:/ })).toHaveCount(3);
  expect(fixture.requests.messages).toEqual(['All rooms, please.']);
  expect(fixture.requests.retries).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobilePhotos = page.getByRole('button', { name: /^Open sample photo:/ });
  await expect(mobilePhotos).toHaveCount(3);
  for (const photo of await mobilePhotos.all()) {
    await expect(photo).toBeEnabled();
    await expect(photo).toBeInViewport();
  }
  expect(fixture.requests.messages).toEqual(['All rooms, please.']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await page.screenshot({
    path: 'test-results/practice-photos-multiroom-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('a failed practice-photo request can be retried without asking the owner to repeat the conversation', async ({
  page,
}) => {
  const fixture = await photoHarness(page, true);
  await page.goto(`/dashboard?service=${ids.service}&practice=${ids.practice}`);
  const retry = page.getByRole('button', { name: 'Try photos again', exact: true });
  await expect(retry).toBeVisible();
  const firstPhoto = page.getByRole('button', {
    name: 'Open sample photo: Living room',
    exact: true,
  });
  await expect(firstPhoto).toBeVisible();
  await retry.click();
  await expect(page.getByText('Creating practice photos…', { exact: true })).toBeVisible();
  await expect(firstPhoto).toBeVisible();
  fixture.makeReady();
  const open = page.getByRole('button', { name: 'Open sample photo: Living room', exact: true });
  await expect(open).toBeVisible();
  await expect
    .poll(() => open.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(16);
  expect(fixture.requests.retries).toBe(1);
  expect(fixture.requests.messages).toHaveLength(0);
  await expect(page.getByRole('button', { name: /^Open sample photo:/ })).toHaveCount(3);
  expect(fixture.current.messages.at(-1)?.photos?.requestId).toBe(ids.request);
  expect(fixture.current.messages.at(-1)?.photos?.status).toBe('ready');
  expect(fixture.unexpected).toEqual([]);
});
