/** The public address of the site, set at build time. Links in previews and the sitemap use it. */
export const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100').replace(
  /\/+$/,
  '',
);
