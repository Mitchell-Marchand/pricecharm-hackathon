export type RequestFilter = 'all' | 'review' | 'issued';
export type OwnerRequestIntent = { quoteId?: string; filter: RequestFilter; cursor?: string };

export function requestFilter(value: string | null): RequestFilter {
  return value === 'review' || value === 'issued' ? value : 'all';
}

export function validRequestCursor(value: string) {
  return value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function ownerRequestIntent(
  params: Pick<URLSearchParams, 'get'>,
): OwnerRequestIntent | null {
  const id = params.get('quote');
  const quoteId =
    id && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.toLowerCase() : undefined;
  if (!quoteId && params.get('inbox') !== '1') return null;
  const rawCursor = params.get('cursor');
  return {
    quoteId,
    filter: requestFilter(params.get('filter')),
    // Preserve an invalid-page recovery across login without passing unbounded input.
    cursor: rawCursor ? (validRequestCursor(rawCursor) ? rawCursor : 'invalid') : undefined,
  };
}

export function ownerRequestUrl(quoteId?: string, filter: RequestFilter = 'all', cursor?: string) {
  const params = new URLSearchParams();
  if (quoteId) params.set('quote', quoteId);
  if (filter !== 'all') params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  return `/dashboard/quotes${params.size ? `?${params}` : ''}`;
}

export function ownerRequestAuthUrl(path: '/login' | '/signup', intent: OwnerRequestIntent) {
  const params = new URLSearchParams();
  if (intent.quoteId) params.set('quote', intent.quoteId);
  else params.set('inbox', '1');
  if (intent.filter !== 'all') params.set('filter', intent.filter);
  if (intent.cursor) params.set('cursor', intent.cursor);
  return `${path}?${params}`;
}

export function currentDashboardLoginUrl() {
  const { pathname, search } = window.location;
  if (pathname !== '/dashboard' && !pathname.startsWith('/dashboard/')) return null;
  if (pathname !== '/dashboard/quotes') return '/login';
  const params = new URLSearchParams(search);
  params.set('inbox', '1');
  return ownerRequestAuthUrl('/login', ownerRequestIntent(params)!);
}
