import { expect, test } from '@playwright/test';
import { api, ApiError, errorMessage, json, NetworkError } from '../../src/lib/api';

async function withFetch(stub: typeof fetch, check: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await check();
  } finally {
    globalThis.fetch = original;
  }
}

test('transport: read failures keep their original cause without inventing an HTTP rejection or retry', async () => {
  for (const method of [undefined, 'GET', 'HEAD', 'head']) {
    const cause = new TypeError('Fictional native transport detail');
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        throw cause;
      },
      async () => {
        const error = await api('/fictional', { method }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(ApiError);
        expect((error as NetworkError).cause).toBe(cause);
        expect(errorMessage(error)).toBe('We couldn’t get a response. Please try again.');
        expect(Object.hasOwn(error as object, 'status')).toBe(false);
        expect(Object.hasOwn(error as object, 'code')).toBe(false);
        expect(calls).toBe(1);
      },
    );
  }
});

test('transport: interrupted mutations remain unknown outcomes with no saved, unsaved or automatic retry claim', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const cause = new TypeError('Failed to fetch');
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        throw cause;
      },
      async () => {
        const error = await api('/fictional', { method, ...json({ example: 'value' }) }).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(NetworkError);
        expect(error).not.toBeInstanceOf(ApiError);
        expect((error as NetworkError).cause).toBe(cause);
        expect(errorMessage(error)).toBe(
          'We couldn’t confirm the result. Check before trying again.',
        );
        expect(calls).toBe(1);
      },
    );
  }
});

test('transport: native and named aborts and already-cancelled signal rejections preserve their exact identity', async () => {
  const namedAbort = new Error('Fictional intentional cancellation');
  namedAbort.name = 'AbortError';
  for (const cause of [new DOMException('Fictional cancellation', 'AbortError'), namedAbort]) {
    await withFetch(
      async () => {
        throw cause;
      },
      async () => {
        const error = await api('/fictional').catch((error: unknown) => error);
        expect(error).toBe(cause);
        expect(error).not.toBeInstanceOf(NetworkError);
      },
    );
  }
  const controller = new AbortController();
  const reason = { cancelled: 'Fictional caller signal' };
  controller.abort(reason);
  await withFetch(
    async (_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      throw reason;
    },
    async () => {
      const error = await api('/fictional', { signal: controller.signal }).catch(
        (error: unknown) => error,
      );
      expect(error).toBe(reason);
    },
  );
});

test('transport: parsed API errors, caller errors, successful data and response parsing stay outside the network boundary', async () => {
  const details = { field: 'serviceArea', correction: 'Specify your coverage.' };
  await withFetch(
    async () =>
      Response.json(
        {
          error: { code: 'INVALID_COVERAGE', message: 'Keep this exact server message.', details },
        },
        { status: 422 },
      ),
    async () => {
      const error = await api('/fictional', { method: 'PATCH' }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(NetworkError);
      expect(error).toMatchObject({ status: 422, code: 'INVALID_COVERAGE', details });
      expect(errorMessage(error)).toBe('Keep this exact server message.');
    },
  );
  await withFetch(
    async (url, options) => {
      expect(url).toBe('/api/v1/fictional');
      expect(options).toMatchObject({
        method: 'POST',
        credentials: 'include',
        body: '{"example":"value"}',
        headers: { 'Content-Type': 'application/json', 'X-Fixture': 'value' },
      });
      return Response.json({ data: { savedId: 'fictional-id' } });
    },
    async () => {
      expect(
        await api('/fictional', {
          method: 'POST',
          credentials: 'omit',
          ...json({ example: 'value' }),
          headers: { 'X-Fixture': 'value' },
        }),
      ).toEqual({ savedId: 'fictional-id' });
    },
  );
  const callerError = new Error('Add a quantity or choose unknown.');
  expect(errorMessage(callerError)).toBe(callerError.message);
  expect(errorMessage(null)).toBe('Something went wrong. Please try again.');
  await withFetch(
    async () => {
      throw new Error('Fetch must not run for caller construction errors');
    },
    async () => {
      const options: RequestInit = {
        get headers(): HeadersInit {
          throw callerError;
        },
      };
      expect(await api('/fictional', options).catch((error: unknown) => error)).toBe(callerError);
    },
  );
  await withFetch(
    async () => new Response('not-json', { status: 200 }),
    async () => {
      const error = await api('/fictional').catch((error: unknown) => error);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(NetworkError);
    },
  );
});
