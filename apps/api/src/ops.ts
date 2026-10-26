import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { closeDatabase, rows } from './db.js';

/** Read-only deployment/operations checks. Never logs customer content or secret values. */
export async function checkOperations(checkHttp = false) {
  createApp(); // Fail early on invalid production AI, origin, mail and payment configuration.
  await rows('SELECT 1 AS connected');
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const expected = (await fs.readdir(migrations)).filter((name) => /^\d+.*\.sql$/.test(name));
  const applied = new Set(
    (await rows('SELECT name FROM schema_migrations')).map((item) => String(item.name)),
  );
  const pending = expected.filter((name) => !applied.has(name));
  if (pending.length) throw new Error(`Pending migrations: ${pending.join(', ')}`);
  const jobs = await rows('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status');
  const [backlog] = await rows(
    "SELECT COUNT(*) AS count FROM jobs WHERE status='pending' AND available_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)",
  );
  const [failed] = await rows(
    "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('failed','blocked')",
  );
  const [uncertainMail] = await rows(
    "SELECT COUNT(*) AS count FROM email_outbox WHERE status IN ('uncertain','sending') AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)",
  );
  const [billingLag] = await rows(
    'SELECT COUNT(*) AS count FROM quote_usage WHERE fee_cents>0 AND stripe_reported_at IS NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 HOUR)',
  );
  const issues = {
    lateJobs: Number(backlog.count),
    failedJobs: Number(failed.count),
    uncertainEmail: Number(uncertainMail.count),
    unreportedUsage: Number(billingLag.count),
  };
  if (checkHttp) {
    const api = await fetch('http://127.0.0.1:4100/ready', { signal: AbortSignal.timeout(5000) });
    const web = await fetch('http://127.0.0.1:3100/', {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!api.ok || !web.ok) throw new Error('API or web HTTP readiness failed.');
  }
  return {
    ok: !Object.values(issues).some(Boolean),
    schema: 'current',
    jobs: jobs.map((item) => ({ status: item.status, count: Number(item.count) })),
    issues,
    httpChecked: checkHttp,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkOperations(process.argv.includes('--http'))
    .then((result) => {
      console.info(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Operations check failed',
        }),
      );
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
