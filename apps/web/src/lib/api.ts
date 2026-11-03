import { screenPath, sessionId, track, trackingAllowed } from './track';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class NetworkError extends Error {
  constructor(method: string, cause: unknown) {
    super(
      ['GET', 'HEAD'].includes(method.toUpperCase())
        ? 'We couldn’t get a response. Please try again.'
        : 'We couldn’t confirm the result. Check before trying again.',
      { cause },
    );
    this.name = 'NetworkError';
  }
}

/**
 * Sends an upload again while the server says it's busy reading others, 3 seconds apart as it
 * asks, so a photo the owner picked is never quietly dropped.
 */
export async function whileBusy<T>(send: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'UPLOAD_BUSY') || attempt >= tries)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `/api/v1${path}`;
  const tracked = trackingAllowed();
  const request: RequestInit = {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      // Lets the server file what this request did under the same browser tab.
      ...(tracked ? { 'X-PC-Session': sessionId() } : {}),
      ...options.headers,
    },
  };
  const method = (request.method || 'GET').toUpperCase();
  const endpoint = screenPath(path.split('?')[0]);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (cause) {
    if (request.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError'))
      throw cause;
    track('network_error', { endpoint, method });
    throw new NetworkError(request.method || 'GET', cause);
  }
  const body = await response.json().catch(() => null);
  const ms = Date.now() - started;
  if (ms > 4000) track('api_slow', { endpoint, method, ms, status: response.status });
  if (!response.ok) throw failure(response.status, body, endpoint, method);
  return body.data as T;
}

/**
 * Sends a form with a big file, saying how much has gone as it goes: a walk-around video can take
 * a while on a phone. fetch can't report an upload's progress, so this uses XMLHttpRequest.
 */
export function upload<T>(
  path: string,
  body: FormData,
  headers: Record<string, string>,
  onProgress: (sent: number, total: number) => void,
): Promise<T> {
  const endpoint = screenPath(path.split('?')[0]);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/v1${path}`);
    request.withCredentials = true;
    if (trackingAllowed()) request.setRequestHeader('X-PC-Session', sessionId());
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onerror = () => {
      track('network_error', { endpoint, method: 'POST' });
      reject(new NetworkError('POST', null));
    };
    request.onload = () => {
      let parsed: {
        data?: T;
        error?: { code?: string; message?: string; details?: unknown };
      } | null = null;
      try {
        parsed = JSON.parse(request.responseText);
      } catch {
        // Not JSON, like a proxy's error page: it's reported by its status below.
      }
      if (request.status >= 200 && request.status < 300 && parsed) resolve(parsed.data as T);
      else reject(failure(request.status, parsed, endpoint, 'POST'));
    };
    request.send(body);
  });
}

/** What the API turned down, as an error the page can show, noted for the record. */
function failure(
  status: number,
  body: { error?: { code?: string; message?: string; details?: unknown } } | null,
  endpoint: string,
  method: string,
) {
  const code = body?.error?.code || 'REQUEST_FAILED';
  track('api_error', { endpoint, method, status, code });
  return new ApiError(
    status,
    code,
    code === 'VALIDATION_ERROR'
      ? validationMessage(body?.error?.details)
      : body?.error?.message || 'The request could not be completed. Please try again.',
    body?.error?.details,
  );
}

type Rejection = { field: string; message: string };
const rejections = (details: unknown): Rejection[] =>
  Array.isArray(details)
    ? details.filter(
        (item): item is Rejection =>
          typeof item?.field === 'string' && typeof item?.message === 'string',
      )
    : [];

/** The API's own messages are sentences. Zod's defaults ("Too big: expected…") aren't. */
const written = (message: string) => /[.!?]$/.test(message.trim());

/**
 * The API says "Check the highlighted fields" whether or not the page marks any, so the message
 * comes from what it turned down. A form that marks its fields with fieldErrors says so itself.
 * A request with no field to blame is usually a page from a different release than the API.
 */
function validationMessage(details: unknown): string {
  const found = rejections(details);
  const sentence = found.find((item) => item.field && written(item.message));
  if (sentence) return sentence.message;
  if (!found.length || found.some((item) => !item.field))
    return 'We couldn’t save this. Refresh the page and try again.';
  return 'Some of this wasn’t accepted. Check what you entered and try again.';
}

/** What the API turned down, by the field's path in the request ("discount.value"). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return {};
  const found: Record<string, string> = {};
  for (const { field, message } of rejections(error.details)) {
    if (!field || found[field]) continue;
    const limit = /<=\s*(\d+) characters/.exec(message)?.[1];
    found[field] = written(message)
      ? message
      : limit
        ? `Keep this to ${limit} characters or fewer.`
        : 'This doesn’t look right.';
  }
  return found;
}

export const json = (value: unknown): Pick<RequestInit, 'body'> => ({
  body: JSON.stringify(value),
});
export const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const shortDate = (value: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value));
export const cents = (value: string) => Math.round(Number(value || 0) * 100);
export const dollars = (value: number) => (value / 100).toFixed(2);
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
