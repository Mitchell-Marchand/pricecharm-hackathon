import 'dotenv/config';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { validateRuntimeConfiguration } from './config.js';
import { closeDatabase, mutate, rows, transaction } from './db.js';
import { deleteBusinessAccount } from './accounts.js';
import {
  applyDuePlanChanges,
  billingProvider,
  dispatchMeterEvent,
  reconcileStripeCustomer,
  validateBillingConfiguration,
} from './billing.js';
import { deliverEmail, validateEmailConfiguration } from './integrations/email.js';
import { json } from './models.js';
import { flushErrorReports, reportError, startErrorReporting } from './error-reporting.js';
import { scheduleExpiredDraftDeletion } from './workspace.js';
import { cleanupStaleJobImports } from './job-imports.js';
import { cleanupUnattachedJobPhotos } from './past-jobs.js';
import { followUpQuotes } from './live/followup.js';

type Job = RowDataPacket & {
  id: string;
  business_id: string | null;
  type: string;
  payload_json: unknown;
  attempts: number;
  max_attempts: number;
};
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`.slice(0, 160);
let stopping = false,
  wake: (() => void) | undefined;
export async function scheduleMaintenance(): Promise<void> {
  await mutate(
    `INSERT IGNORE INTO jobs(id,type,payload_json,dedupe_key) VALUES (?,'maintenance','{}',?)`,
    [randomUUID(), `maintenance:${Math.floor(Date.now() / 1800000)}`],
  );
}
async function claimJob(jobId?: string): Promise<Job | undefined> {
  return transaction(async (connection) => {
    await mutate(
      `UPDATE jobs SET status=IF(attempts>=max_attempts,'failed','pending'),locked_at=NULL,locked_by=NULL,last_error='Worker lease expired; idempotent retry required'
      WHERE status='processing' AND locked_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE)`,
      [],
      connection,
    );
    const [job] = await rows<Job>(
      `SELECT * FROM jobs WHERE status='pending' AND available_at<=UTC_TIMESTAMP(3) AND attempts<max_attempts ${jobId ? 'AND id=?' : ''} ORDER BY available_at,created_at LIMIT 1 FOR UPDATE`,
      jobId ? [jobId] : [],
      connection,
    );
    if (!job) return undefined;
    await mutate(
      "UPDATE jobs SET status='processing',attempts=attempts+1,locked_at=UTC_TIMESTAMP(3),locked_by=? WHERE id=?",
      [workerId, job.id],
      connection,
    );
    return { ...job, attempts: job.attempts + 1 };
  });
}
async function maintenance(): Promise<void> {
  await transaction(async (connection) => {
    await scheduleExpiredDraftDeletion(connection);
    await mutate('DELETE FROM owner_sessions WHERE expires_at<UTC_TIMESTAMP(3)', [], connection);
    await mutate(
      'DELETE FROM identity_tokens WHERE expires_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY)',
      [],
      connection,
    );
    await mutate(
      'DELETE FROM contact_verifications WHERE expires_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY)',
      [],
      connection,
    );
    await mutate(
      'DELETE FROM auth_rate_limits WHERE updated_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY)',
      [],
      connection,
    );
    await mutate(
      "DELETE FROM email_outbox WHERE status='sent' AND sent_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 30 DAY)",
      [],
      connection,
    );
    if (billingProvider() === 'stripe')
      for (const account of await rows(
        'SELECT business_id,stripe_customer_id FROM billing_accounts WHERE stripe_customer_id IS NOT NULL',
        [],
        connection,
      )) {
        await mutate(
          `INSERT IGNORE INTO jobs(id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'stripe_reconcile',?,?)`,
          [
            randomUUID(),
            account.business_id,
            JSON.stringify({ customerId: account.stripe_customer_id }),
            `reconcile:${account.business_id}:${Math.floor(Date.now() / 3600000)}`,
          ],
          connection,
        );
      }
    for (const usage of await rows(
      'SELECT id,business_id FROM quote_usage WHERE fee_cents>0 AND stripe_reported_at IS NULL',
      [],
      connection,
    )) {
      await mutate(
        `INSERT IGNORE INTO jobs(id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'billing_dispatch',?,?)`,
        [
          randomUUID(),
          usage.business_id,
          JSON.stringify({ usageId: usage.id }),
          `meter:${usage.id}`,
        ],
        connection,
      );
    }
  });
  await cleanupUnattachedJobPhotos();
  await applyDuePlanChanges();
  await cleanupStaleJobImports();
  await followUpQuotes();
}
async function processJob(job: Job): Promise<void> {
  const payload = z.record(z.string(), z.unknown()).parse(json(job.payload_json, {}));
  switch (job.type) {
    case 'send_email':
      await deliverEmail(z.string().uuid().parse(payload.emailId));
      break;
    case 'billing_dispatch':
      await dispatchMeterEvent(z.string().uuid().parse(payload.usageId));
      break;
    case 'stripe_reconcile': {
      if (payload.customerId)
        await reconcileStripeCustomer(z.string().max(255).parse(payload.customerId));
      if (payload.eventId)
        await mutate(
          "UPDATE stripe_events SET status='processed',processed_at=UTC_TIMESTAMP(3) WHERE id=?",
          [z.string().max(255).parse(payload.eventId)],
        );
      break;
    }
    case 'billing_meter_error':
      await mutate("UPDATE stripe_events SET status='needs_review' WHERE id=?", [
        z.string().max(255).parse(payload.eventId),
      ]);
      throw new Error(
        'Stripe rejected asynchronous meter data. Reconcile the internal ledger before invoicing.',
      );
    case 'account_delete':
      await deleteBusinessAccount(
        z.string().uuid().parse(payload.businessId),
        z.string().uuid().parse(payload.deletionId),
      );
      break;
    case 'session_cleanup':
    case 'maintenance':
      await maintenance();
      break;
    default:
      throw new Error('No handler is registered for this job type.');
  }
}
export async function runOneJob(jobId?: string): Promise<boolean> {
  if (jobId) z.string().uuid().parse(jobId);
  const job = await claimJob(jobId);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void mutate('UPDATE jobs SET locked_at=UTC_TIMESTAMP(3) WHERE id=? AND locked_by=?', [
      job.id,
      workerId,
    ]).catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    await processJob(job);
    await mutate(
      "UPDATE jobs SET status='completed',locked_at=NULL,locked_by=NULL,last_error=NULL WHERE id=? AND locked_by=?",
      [job.id, workerId],
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker_job_failed',
        jobId: job.id,
        type: job.type,
        code: (error as { code?: string }).code || 'PROCESSING_FAILED',
      }),
    );
    reportError(error, { jobType: String(job.type), jobId: String(job.id) });
    const delay = Math.min(300, 10 * 2 ** (job.attempts - 1));
    await mutate(
      `UPDATE jobs SET status=IF(attempts>=max_attempts,'failed','pending'),available_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),locked_at=NULL,locked_by=NULL,
      last_error='Processing failed. Inspect provider delivery/reconciliation status before retrying failed work.' WHERE id=? AND locked_by=?`,
      [delay, job.id, workerId],
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
async function pause(milliseconds: number): Promise<void> {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    }
    wake = done;
  });
}
export async function startWorker(): Promise<void> {
  validateRuntimeConfiguration();
  validateEmailConfiguration();
  validateBillingConfiguration();
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.info(JSON.stringify({ event: 'worker_started', workerId }));
  let unavailable = false;
  while (!stopping) {
    try {
      await scheduleMaintenance();
      if (!(await runOneJob())) await pause(2000);
      unavailable = false;
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_database_unavailable' }));
      // Once per outage, not every two seconds while it lasts.
      if (!unavailable) reportError(error, { event: 'worker_database_unavailable' });
      unavailable = true;
      await pause(2000);
    }
  }
  await closeDatabase();
  await flushErrorReports();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startErrorReporting('worker');
  startWorker().catch(async (error: unknown) => {
    console.error(
      'Worker startup failed. Check configuration and database availability.',
      error instanceof Error ? error.message : '',
    );
    reportError(error, { event: 'worker_startup_failed' });
    await closeDatabase();
    await flushErrorReports();
    process.exitCode = 1;
  });
}
