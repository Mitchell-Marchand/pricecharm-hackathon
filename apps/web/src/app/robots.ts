import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * Search engines get the marketing pages. Owner pages, setup and one-time links stay out. Quote
 * links stay crawlable so link previews work; their pages ask not to be indexed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/app/', '/start/', '/approve/', '/embed/', '/api/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
