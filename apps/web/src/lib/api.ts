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
      body?.error?.message || 'The request could not be completed. Please try again.',
      body?.error?.details,
    );
  return body.data as T;
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
