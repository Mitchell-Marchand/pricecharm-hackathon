import * as Sentry from '@sentry/nextjs';
import { reportingOptions } from '@/lib/error-reporting';

if (reportingOptions.dsn) Sentry.init(reportingOptions);
