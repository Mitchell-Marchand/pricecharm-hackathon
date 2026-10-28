import 'dotenv/config';
import { closeDatabase } from './db.js';
import { formatInsights, insightsReport } from './insights.js';
import { formatReport, metricsReport } from './metrics.js';

/** Prints the metrics report and the detail behind it. node dist/metrics-report.js [--days 7] [--json] */
const args = process.argv.slice(2);
const at = args.indexOf('--days');
const days = at >= 0 ? Number(args[at + 1]) : 7;
if (!Number.isInteger(days) || days < 1 || days > 366) {
  console.error('--days must be a whole number from 1 to 366.');
  process.exit(1);
}
Promise.all([metricsReport(days), insightsReport(days)])
  .then(([summary, details]) =>
    console.info(
      args.includes('--json')
        ? JSON.stringify({ summary, details }, null, 2)
        : `${formatReport(summary)}\n\n${formatInsights(details)}`,
    ),
  )
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'The report failed.');
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
