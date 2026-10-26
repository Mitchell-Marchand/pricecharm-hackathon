import * as Sentry from '@sentry/node';
import { appEnv } from './config.js';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Session tokens, API keys, signed links: any long unbroken run of token characters.
const TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;
const scrub = (value: string) => value.replace(EMAIL, '[email]').replace(TOKEN, '[token]');

/** Drops everything about the request and the person, and masks emails and tokens in messages. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  if (event.message) event.message = scrub(event.message);
  for (const exception of event.exception?.values || [])
    if (exception.value) exception.value = scrub(exception.value);
  return event;
}

/**
 * Sends errors to Sentry when SENTRY_DSN is set. A report carries the error, its stack and tags
 * such as the request ID, and nothing anyone typed: no request, no user, no breadcrumbs. Only the
 * integrations listed here run, so nothing records AI prompts or outgoing requests.
 */
export function startErrorReporting(service: 'api' | 'worker'): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: appEnv(),
    release: process.env.APP_RELEASE,
    includeServerName: false,
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
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.contextLinesIntegration(),
    ],
    initialScope: { tags: { service } },
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  });
}

/** MySQL messages can quote the values in a row, so a database error is reported by its code. */
export function reportable(error: unknown): unknown {
  if (!(error instanceof Error) || !('sqlState' in error)) return error;
  const safe = new Error(`Database error ${(error as { code?: string }).code || 'unknown'}`);
  safe.stack = error.stack?.replace(/^.*$/m, safe.message);
  return safe;
}

export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  Sentry.captureException(reportable(error), { tags });
}

/** Waits briefly for queued reports to send, so a process that's exiting doesn't drop them. */
export async function flushErrorReports(): Promise<void> {
  await Sentry.close(2000);
}
