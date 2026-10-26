import type { BrowserOptions, ErrorEvent } from '@sentry/nextjs';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Session tokens, API keys, signed links: any long unbroken run of token characters.
const TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;
const scrub = (value: string) => value.replace(EMAIL, '[email]').replace(TOKEN, '[token]');

/** Customer links carry their access token after the #, so a report keeps only the path. */
function pathOnly(url: string): string {
  try {
    return new URL(url, 'https://quotefolk.invalid').pathname;
  } catch {
    return '';
  }
}

export function scrubEvent<T extends ErrorEvent>(event: T): T {
  event.request = event.request?.url ? { url: pathOnly(event.request.url) } : undefined;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  if (event.message) event.message = scrub(event.message);
  for (const exception of event.exception?.values || [])
    if (exception.value) exception.value = scrub(exception.value);
  return event;
}

/**
 * Set at build time. Without a DSN nothing is reported (local runs, CI and previews). A report
 * carries the error, its stack and the page's path, and nothing anyone typed.
 */
export const reportingOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'production',
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  },
  beforeBreadcrumb: () => null,
  beforeSend: scrubEvent,
} satisfies BrowserOptions;
