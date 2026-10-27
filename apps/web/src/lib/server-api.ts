import { DEFAULT_PRICING, type Pricing } from './plans';
import type { BusinessProfile } from './chat';

/** Where the web server reaches the API directly, the same address its /api/v1 rewrite uses. */
export const apiOrigin = () => process.env.PRICECHARM_API_BASE || 'http://127.0.0.1:4100';

const SLUG = /^[a-z0-9-]{1,120}$/;

/**
 * A business's public profile, read on the server for page titles and link previews.
 * Null means there's no such business; undefined means the API couldn't say, and the page
 * loads it in the browser instead.
 */
export async function publicBusiness(
  slug: string,
  { fresh = false } = {},
): Promise<BusinessProfile | null | undefined> {
  if (!SLUG.test(slug)) return null;
  try {
    const response = await fetch(`${apiOrigin()}/api/v1/chat/${slug}`, {
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 60 } }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    return ((await response.json()) as { data: BusinessProfile }).data;
  } catch {
    return undefined;
  }
}

/** The current prices, read on the server so marketing pages match what billing charges. */
export async function publicPricing(): Promise<Pricing> {
  try {
    const response = await fetch(`${apiOrigin()}/api/v1/pricing`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return DEFAULT_PRICING;
    return { ...DEFAULT_PRICING, ...((await response.json()) as { data: Pricing }).data };
  } catch {
    return DEFAULT_PRICING;
  }
}
