import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublicSession, Quote } from '../../src/lib/types';

const slug = 'fictional-request-return';
const oldId = '92000000-0000-4000-8000-000000000001';
const newId = '92000000-0000-4000-8000-000000000002';
const serviceId = '92000000-0000-4000-8000-000000000003';
const token = 'r'.repeat(43);
const nextToken = 's'.repeat(43);
const accessKey = `quotient:${slug}`;
const draftKey = `${accessKey}:draft:${oldId}`;
const at = '2026-10-28T12:00:00.000Z';
const project = 'Repaint the two bedroom walls in Austin. The business will confirm the size.';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function harness(
  page: Page,
  options: {
    status?: NonNullable<PublicSession['status']>;
    quote?: boolean;
    verified?: boolean;
    storageBlocked?: boolean;
    privatePreview?: boolean;
    quoteFailure?: 'failed' | 'lost';
  } = {},
) {
  const status = options.status || 'submitted';
  const service = {
    id: serviceId,
    businessId: '92000000-0000-4000-8000-000000000004',
    name: 'Interior painting',
    description: 'Interior wall painting.',
    unitLabel: 'room',
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    maxAutoQuoteCents: 0,
    requiredInputs: ['rooms'],
    pricingRules: [],
    exclusions: [],
    mode: 'review',
    version: 2,
    publishedAt: at,
  };
  const business = {
    id: service.businessId,
    name: 'Fictional Return Painting',
    slug,
    description: service.description,
    serviceArea: 'Austin',
    currency: 'USD',
    industry: 'Painting',
    onboardingComplete: true,
    autoQuoteEnabled: false,
    createdAt: at,
  };
  function makeQuote(id: string, state: Quote['status']): Quote {
    const priced = state !== 'review';
    return {
      id:
        id === oldId
          ? '92000000-0000-4000-8000-000000000005'
          : '92000000-0000-4000-8000-000000000006',
      serviceId,
      customerName: 'Fictional Customer',
      customerEmail: 'fictional-customer@example.test',
      status: state,
      description: project,
      quantity: 1,
      totalCents: priced ? 25000 : 0,
      currency: 'USD',
      assumptions: priced ? ['Scope is limited to the supplied project details.'] : [],
      lineItems: priced
        ? [{ description: 'Project price', quantity: 1, unitPriceCents: 25000, totalCents: 25000 }]
        : [],
      manualPriceRequired: !priced,
      issuedBy: priced ? 'owner' : undefined,
      createdAt: at,
    };
  }
  function makeSession(id: string, state: NonNullable<PublicSession['status']>): PublicSession {
    return {
      id,
      serviceId,
      serviceVersion: service.version,
      source: options.privatePreview ? 'playground' : 'live',
      quoteMode: 'review',
      pricingQuantityRequired: false,
      requiredInputs: ['location', 'rooms'],
      status: state,
      expiresAt: '2099-01-01T00:00:00.000Z',
      humanHandoff: state !== 'active',
      contact: options.verified
        ? { verified: true, email: 'fictional-customer@example.test' }
        : { verified: false },
      collectedInputs: { location: 'Austin', rooms: 'Two bedrooms' },
      missingInputs: [],
      messages: [
        { id: `${id}-customer`, role: 'user', content: project, createdAt: at },
        {
          id: `${id}-assistant`,
          role: 'assistant',
          content:
            state === 'active'
              ? 'You can send the request when ready.'
              : 'Your request is with the business.',
          createdAt: at,
        },
      ],
    };
  }
  const old = makeSession(oldId, status);
  if (options.quote !== false && status !== 'active')
    old.quote = makeQuote(oldId, status === 'submitted' ? 'review' : status);
  const sessions = new Map([[oldId, old]]);
  const requests = {
    posts: [] as string[],
    gets: [] as string[],
    unexpected: [] as string[],
    markerBeforePost: false,
    decisions: 0,
  };
  const gates = new Map<string, ReturnType<typeof gate>>();
  function hold(operation: 'reply' | 'upload' | 'decision' | 'decision-refresh') {
    const pending = gate();
    gates.set(operation, pending);
    return pending.release;
  }
  async function pause(operation: string) {
    const pending = gates.get(operation);
    if (pending) {
      await pending.promise;
      gates.delete(operation);
    }
  }
  const photo = await readFile(path.resolve('tests/e2e/fixtures/project-photo.png'));
  const user = {
    id: 'fictional-return-owner',
    name: business.name,
    email: 'fictional-owner@example.test',
    emailVerified: true,
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (request.method() === 'POST') requests.posts.push(pathname);
    if (request.method() === 'GET') requests.gets.push(pathname);
    let data: unknown;
    if (pathname === '/api/v1/auth/me') data = { user, business };
    else if (pathname === '/api/v1/settings') data = { aiMode: 'live' };
    else if (pathname === '/api/v1/dashboard')
      data = {
        business,
        services: [service],
        examples: [],
        jobNotes: [],
        trainingSessions: [],
        recentQuotes: [],
        stats: { totalQuotes: 0, reviewQuotes: 0, issuedQuotes: 0, quotedValueCents: 0 },
        usage: { billableQuotes: 0, aiCalls: 0 },
      };
    else if (request.method() === 'GET' && pathname === `/api/v1/public/${slug}`)
      data = {
        business,
        services: [
          {
            id: serviceId,
            name: service.name,
            description: service.description,
            unitLabel: service.unitLabel,
            requiredInputs: ['location', 'rooms'],
            exclusions: [],
            mode: 'review',
            pricingQuantityRequired: false,
          },
        ],
      };
    else if (request.method() === 'POST' && pathname === `/api/v1/public/${slug}/sessions`) {
      const next = makeSession(newId, 'active');
      next.collectedInputs = {};
      next.messages = [
        {
          id: `${newId}-intro`,
          role: 'assistant',
          content: 'Tell us about the work.',
          createdAt: at,
        },
      ];
      sessions.set(newId, next);
      data = { token: nextToken, session: next };
    } else {
      const match = new RegExp(`^/api/v1/public/${slug}/sessions/([^/]+)(?:/(.+))?$`).exec(
        pathname,
      );
      const session = match ? sessions.get(match[1]) : undefined;
      if (match && session) {
        expect(request.headers().authorization).toBe(
          `Bearer ${session.id === oldId ? token : nextToken}`,
        );
        const operation = match[2];
        if (request.method() === 'GET' && !operation) {
          if (requests.decisions) await pause('decision-refresh');
          data = session;
        } else if (request.method() === 'GET' && operation === 'uploads') data = [];
        else if (request.method() === 'POST' && operation === 'messages') {
          await pause('reply');
          const content = request.postDataJSON().content;
          session.messages.push({
            id: `reply-${requests.posts.length}`,
            role: 'user',
            content,
            createdAt: at,
          });
          data = { session };
        } else if (request.method() === 'POST' && operation === 'uploads') {
          await pause('upload');
          data = {
            id: 'fictional-photo',
            filename: 'project-photo.png',
            previewDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
          };
        } else if (request.method() === 'POST' && operation === 'quote') {
          requests.markerBeforePost = await page.evaluate((key) => {
            try {
              return JSON.parse(sessionStorage.getItem(key) || 'null')?.quoteAttempted === true;
            } catch {
              return false;
            }
          }, `${accessKey}:draft:${session.id}`);
          if (session.id === oldId && options.quoteFailure) {
            if (options.quoteFailure === 'lost') return route.abort('failed');
            return route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'REQUEST_FAILED',
                  message: 'The request result could not be confirmed.',
                },
              },
            });
          }
          session.quote = makeQuote(session.id, 'review');
          session.quote.description = request.postDataJSON().description;
          session.quote.customerName = request.postDataJSON().customerName;
          session.quote.customerEmail = request.postDataJSON().customerEmail;
          session.status = 'submitted';
          data = session.quote;
        } else if (request.method() === 'POST' && operation === 'decision') {
          requests.decisions++;
          await pause('decision');
          const decision = request.postDataJSON().decision;
          session.status = decision;
          session.quote = { ...session.quote!, status: decision };
          data = session.quote;
        }
      }
    }
    if (data !== undefined) return route.fulfill({ json: { data } });
    requests.unexpected.push(`${request.method()} ${pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: 'Unexpected mocked request.' } },
    });
  });
  if (options.storageBlocked)
    await page.addInitScript(() => {
      for (const key of ['localStorage', 'sessionStorage'])
        Object.defineProperty(window, key, {
          get() {
            throw new DOMException('Storage blocked', 'SecurityError');
          },
        });
    });
  else
    await page.addInitScript(
      ({ key, id, token, serviceId }) => {
        if (!sessionStorage.getItem('fictional-return-seeded')) {
          localStorage.setItem(key, JSON.stringify({ id, token, serviceId }));
          sessionStorage.setItem('fictional-return-seeded', '1');
        }
      },
      {
        key: options.privatePreview
          ? `quotient:playground:${slug}:${serviceId}@${service.version}`
          : accessKey,
        id: oldId,
        token,
        serviceId,
      },
    );
  const returnPath = `/q/${slug}#${new URLSearchParams({ session: oldId, token })}`;
  await page.goto(
    options.privatePreview
      ? `/dashboard?service=${serviceId}&step=try`
      : options.storageBlocked
        ? returnPath
        : `/q/${slug}`,
  );
  await expect(
    page.getByRole('button', {
      name:
        status === 'active' || options.privatePreview
          ? 'Start a new request'
          : 'Start another request',
      exact: true,
    }),
  ).toBeVisible();
  return { requests, old, hold, returnPath };
}

const restartDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Start another request?', exact: true });
async function openGuard(page: Page) {
  await page.getByRole('button', { name: 'Start another request', exact: true }).click();
  const dialog = restartDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
function checkLink(value: string, origin: string) {
  const url = new URL(value);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe(`/q/${slug}`);
  expect(url.search).toBe('');
  expect(new URLSearchParams(url.hash.slice(1)).get('session')).toBe(oldId);
  expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(token);
}
async function submitForm(page: Page) {
  const form = page.locator('.public-request-form');
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: 'Your name', exact: true }).fill('Fictional Customer');
  await form
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('fictional-customer@example.test');
  await form.getByLabel(/I agree to share/).check();
  await form.getByRole('button', { name: 'Send request', exact: true }).click();
}

test('an unverified submitted request keeps exact access on open, Keep, Escape and reload, then its link reopens after an explicit new request', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await harness(page);
  const reply = page.getByLabel('Tell us about your project', { exact: true });
  const unsentReply = 'Does the wall painting include covering the furniture?';
  await reply.fill(unsentReply);
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || 'null')?.content, draftKey),
    )
    .toBe(unsentReply);
  const initialReads = app.requests.gets.filter((item) => item.endsWith(oldId)).length;
  for (const fragment of [
    'project-notes',
    `session=${oldId}`,
    `token=${token}`,
    'session=&token=',
    `session=${encodeURIComponent('   ')}&token=${token}`,
    `session=${oldId}&token=${encodeURIComponent(' \t ')}`,
  ]) {
    await page.evaluate(
      (value) =>
        new Promise<void>((resolve) => {
          window.addEventListener('hashchange', () => resolve(), { once: true });
          window.location.hash = value;
        }),
      fragment,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(reply).toHaveValue(unsentReply);
    await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
    expect(app.requests.gets.filter((item) => item.endsWith(oldId))).toHaveLength(initialReads);
    expect(
      await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) || 'null')?.content,
        draftKey,
      ),
    ).toBe(unsentReply);
  }
  // These were same-document navigation probes, not an incoming credential link.
  await page.evaluate(() => history.replaceState(null, '', window.location.pathname));
  const original = await page.evaluate((key) => localStorage.getItem(key), accessKey);
  let dialog = await openGuard(page);
  const link = await dialog.getByLabel('Your private request link', { exact: true }).inputValue();
  checkLink(link, new URL(page.url()).origin);
  await expect(dialog).toContainText('Your current request stays with the business.');
  await dialog.getByRole('button', { name: 'Keep this request', exact: true }).click();
  await expect(restartDialog(page)).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), accessKey)).toBe(original);
  await openGuard(page);
  await page.keyboard.press('Escape');
  await expect(restartDialog(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  await page.reload();
  dialog = await openGuard(page);
  await expect(dialog.getByLabel('Your private request link')).toHaveValue(link);
  await dialog.getByRole('button', { name: 'Start another request', exact: true }).click();
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toHaveCount(0);
  expect(app.requests.posts).toEqual([]);
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(app.requests.posts).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

for (const status of ['submitted', 'issued', 'accepted', 'declined'] as const)
  test(`verified ${status} access is guarded even when its quote DTO is absent`, async ({
    page,
  }) => {
    const app = await harness(page, { status, quote: false, verified: true });
    const dialog = await openGuard(page);
    checkLink(
      await dialog.getByLabel('Your private request link').inputValue(),
      new URL(page.url()).origin,
    );
    await expect(dialog).toContainText('Your current request stays with the business.');
    await dialog.getByRole('button', { name: 'Keep this request', exact: true }).click();
    expect(app.requests.posts).toEqual([]);
    expect(app.requests.unexpected).toEqual([]);
  });

test('blocked storage and clipboard rejection leave a selectable manual return link without a saved claim', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new DOMException('Clipboard blocked', 'NotAllowedError');
        },
      },
    }),
  );
  const app = await harness(page, { storageBlocked: true });
  const dialog = await openGuard(page);
  const input = dialog.getByLabel('Your private request link', { exact: true });
  const link = await input.inputValue();
  await dialog.getByRole('button', { name: 'Copy request link', exact: true }).click();
  await expect(input).toHaveValue(link);
  await expect(input).toBeEditable({ editable: false });
  await input.focus();
  expect(
    await input.evaluate(
      (node: HTMLInputElement) =>
        node.selectionStart === 0 && node.selectionEnd === node.value.length,
    ),
  ).toBe(true);
  await expect(dialog.getByText('Request link copied', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Keep this request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  expect(app.requests.posts).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('an old clipboard completion cannot label a new request copied or expose its previous return URL', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            (window as unknown as { resolveFictionalCopy: () => void }).resolveFictionalCopy =
              resolve;
          }),
      },
    }),
  );
  const app = await harness(page);
  const dialog = await openGuard(page);
  await dialog.getByRole('button', { name: 'Copy request link', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start another request', exact: true }).click();
  await page
    .getByLabel('Tell us about your project', { exact: true })
    .fill('Paint the kitchen walls in Austin.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await submitForm(page);
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { resolveFictionalCopy: () => void }).resolveFictionalCopy(),
  );
  await expect(page.getByRole('button', { name: 'Copy request link', exact: true })).toBeVisible();
  await expect(page.getByText('Request link copied', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your private request link', { exact: true })).toHaveCount(0);
  expect(app.requests.posts.filter((item) => item.endsWith('/sessions'))).toHaveLength(1);
  expect(app.requests.unexpected).toEqual([]);
});

for (const operation of ['reply', 'upload', 'decision'] as const)
  test(`a busy submitted ${operation} cannot lose access through the guarded restart`, async ({
    page,
  }) => {
    const app = await harness(page, { status: operation === 'decision' ? 'issued' : 'submitted' });
    const release = app.hold(operation);
    const releaseRefresh = operation === 'decision' ? app.hold('decision-refresh') : undefined;
    if (operation === 'reply') {
      await page
        .getByLabel('Tell us about your project', { exact: true })
        .fill('The hallway also needs painting.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    } else if (operation === 'upload')
      await page
        .locator('input[type=file]')
        .setInputFiles(path.resolve('tests/e2e/fixtures/project-photo.png'));
    else await page.getByRole('button', { name: 'Accept quote', exact: true }).click();
    await expect.poll(() => app.requests.posts.length).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Start another request', exact: true }),
    ).toBeDisabled();
    await expect(restartDialog(page)).toHaveCount(0);
    expect(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null')?.id, accessKey),
    ).toBe(oldId);
    release();
    if (operation === 'decision') {
      await expect
        .poll(() => app.requests.gets.filter((item) => item.endsWith(oldId)).length)
        .toBeGreaterThan(1);
      await expect(
        page.getByRole('button', { name: 'Start another request', exact: true }),
      ).toBeDisabled();
      releaseRefresh!();
    }
    await expect(
      page.getByRole('button', { name: 'Start another request', exact: true }),
    ).toBeEnabled();
    await openGuard(page);
    expect(app.requests.unexpected).toEqual([]);
  });

for (const failure of ['failed', 'lost'] as const)
  test(`${failure} submission persists uncertainty before POST and active reloads do not claim receipt or clear the guard`, async ({
    page,
  }) => {
    const app = await harness(page, { status: 'active', quoteFailure: failure });
    await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
    if (failure === 'failed')
      await page.evaluate((key) => sessionStorage.setItem(key, '{broken'), draftKey);
    await submitForm(page);
    await expect.poll(() => app.requests.markerBeforePost).toBe(true);
    await expect(page.locator('.public-request-form .notice')).toBeVisible();
    const dialog = await openGuard(page);
    await expect(dialog).toContainText('Keep this private link to return to this conversation.');
    await expect(dialog).not.toContainText('stays with the business');
    await dialog.getByRole('button', { name: 'Keep this request', exact: true }).click();
    await page.reload();
    await openGuard(page);
    expect(
      await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) || 'null')?.quoteAttempted,
        draftKey,
      ),
    ).toBe(true);
    await expect(restartDialog(page)).not.toContainText('stays with the business');
    expect(app.requests.posts).toHaveLength(1);
    expect(app.requests.unexpected).toEqual([]);
  });

test('a known unsent live chat still resets instantly without creating a new inquiry', async ({
  page,
}) => {
  const app = await harness(page, { status: 'active' });
  await page.getByRole('button', { name: 'Start a new request', exact: true }).click();
  await expect(restartDialog(page)).toHaveCount(0);
  await expect(page.getByLabel('Tell us about your project', { exact: true })).toHaveValue('');
  expect(await page.evaluate((key) => localStorage.getItem(key), accessKey)).toBe(null);
  expect(app.requests.posts).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});

test('private Try keeps its instant reset even after a private quote result', async ({ page }) => {
  const app = await harness(page, { privatePreview: true, status: 'submitted' });
  await expect(page.getByRole('heading', { name: 'Test result', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start a new request', exact: true }).click();
  await expect(restartDialog(page)).toHaveCount(0);
  await expect(page.getByLabel('Customer’s project', { exact: true })).toHaveValue('');
  expect(app.requests.posts).toEqual([]);
  expect(app.requests.unexpected).toEqual([]);
});
