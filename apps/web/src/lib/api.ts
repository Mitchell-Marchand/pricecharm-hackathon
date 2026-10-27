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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `/api/v1${path}`;
  const request: RequestInit = {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  };
  let response: Response;
  try {
    response = await fetch(url, request);
  } catch (cause) {
    if (request.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError'))
      throw cause;
    throw new NetworkError(request.method || 'GET', cause);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code || 'REQUEST_FAILED',
      body?.error?.code === 'VALIDATION_ERROR'
        ? validationMessage(body.error.details)
        : body?.error?.message || 'The request could not be completed. Please try again.',
      body?.error?.details,
    );
  return body.data as T;
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
