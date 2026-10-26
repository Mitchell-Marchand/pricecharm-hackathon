import { NextResponse, type NextRequest } from 'next/server';
import { publicBusiness } from '@/lib/server-api';

const cache = new Map<string, { ancestors: string; until: number }>();
// Short, so a website the owner just saved works within moments.
const CACHE_MS = 15_000;

/** Only this site (for the owner's own previews) and the business's own website may show it. */
async function ancestorsFor(slug: string): Promise<string> {
  const cached = cache.get(slug);
  if (cached && cached.until > Date.now()) return cached.ancestors;
  const business = await publicBusiness(slug, { fresh: true });
  // If the API can't answer, keep the last answer rather than breaking every widget.
  if (business === undefined && cached) return cached.ancestors;
  const domain = business?.websiteDomain;
  const ancestors = domain ? `'self' https://${domain} https://www.${domain}` : "'self'";
  if (cache.size > 5000) cache.clear();
  cache.set(slug, { ancestors, until: Date.now() + CACHE_MS });
  return ancestors;
}

/** The widget's frame: it may only load inside the business's own website. */
export async function proxy(request: NextRequest) {
  const slug = request.nextUrl.pathname.split('/')[2] ?? '';
  const response = NextResponse.next();
  response.headers.set(
    'Content-Security-Policy',
    `frame-ancestors ${await ancestorsFor(slug)}; object-src 'none'; base-uri 'self'`,
  );
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export const config = { matcher: '/embed/:slug' };
