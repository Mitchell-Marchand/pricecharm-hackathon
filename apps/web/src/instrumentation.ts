import * as Sentry from '@sentry/nextjs';
import { reportingOptions } from '@/lib/error-reporting';

export function register() {
  if (!reportingOptions.dsn || process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Only these integrations run, so nothing records requests, prompts or outgoing calls.
  Sentry.init({
    ...reportingOptions,
    includeServerName: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
  });
}

export const onRequestError = Sentry.captureRequestError;
