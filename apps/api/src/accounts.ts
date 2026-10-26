import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { owner, verifyPassword } from './auth.js';
import { billingProvider, dispatchMeterEvent, stripeClient } from './billing.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { localOutbox } from './integrations/email.js';
import { deletePhoto } from './storage.js';

export const accountRouter = Router();
async function tenantTables(connection?: Sql): Promise<string[]> {
  return (
    await rows(
      "SELECT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='business_id'",
      [],
      connection,
    )
  )
    .map((item) => String(item.name))
    .filter((name) => /^[a-z][a-z0-9_]*$/.test(name));
}
accountRouter.get('/account/export', async (req, res) => {
  const businessId = owner(req).businessId;
  const result = await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT * FROM businesses WHERE id=? FOR UPDATE',
      [businessId],
      connection,
    );
    const excluded = new Set([
      'jobs',
      'identity_tokens',
      'contact_verifications',
      'email_outbox',
      'account_deletion_audits',
    ]);
    const records: Record<string, unknown[]> = {};
    for (const table of await tenantTables(connection)) {
      if (excluded.has(table)) continue;
      records[table] = (
        await rows(`SELECT * FROM \`${table}\` WHERE business_id=?`, [businessId], connection)
      ).map((record) =>
        Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => !key.endsWith('_hash') && key !== 'payload_encrypted',
          ),
        ),
      );
    }
    return { exportedAt: new Date().toISOString(), business, records };
  });
  res.setHeader('Content-Disposition', 'attachment; filename="quotient-account-export.json"');
  res.json(ok(result));
});
accountRouter.get('/account/local-outbox', async (req, res) => {
  res.json(ok(await localOutbox(owner(req).businessId)));
});
accountRouter.delete('/account', async (req, res) => {
  const input = z
    .object({ password: z.string().min(1).max(128), confirmation: z.string().min(1).max(160) })
    .strict()
    .parse(req.body);
  const context = owner(req);
  const [user] = await rows('SELECT password_hash FROM users WHERE id=? AND business_id=?', [
    context.userId,
    context.businessId,
  ]);
  if (!user || !(await verifyPassword(input.password, user.password_hash)))
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'The password is incorrect.');
  await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT name,deletion_requested_at FROM businesses WHERE id=? FOR UPDATE',
      [context.businessId],
      connection,
    );
    if (!business || business.name !== input.confirmation)
      throw new ApiError(
        422,
        'CONFIRMATION_REQUIRED',
        'Enter the exact business name to confirm deletion.',
      );
    if (business.deletion_requested_at) return;
    const deletionId = randomUUID();
    await mutate(
      'INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,?)',
      [deletionId, context.businessId, 'scheduled'],
      connection,
    );
    await mutate(
      'UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3),auto_send=FALSE WHERE id=?',
      [context.businessId],
      connection,
    );
    await mutate(
      'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
      [context.businessId],
      connection,
    );
    await mutate(
      `INSERT INTO jobs(id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'account_delete',?,?)`,
      [
        randomUUID(),
        context.businessId,
        JSON.stringify({ businessId: context.businessId, deletionId }),
        `delete-account:${context.businessId}`,
      ],
      connection,
    );
  });
  res.clearCookie('quotient_session', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1',
  });
  res.json(ok({ ok: true, status: 'deletion_scheduled' }));
});

export async function deleteBusinessAccount(businessId: string, deletionId: string): Promise<void> {
  z.string().uuid().parse(businessId);
  z.string().uuid().parse(deletionId);
  const [audit] = await rows(
    'SELECT status FROM account_deletion_audits WHERE id=? AND business_id=?',
    [deletionId, businessId],
  );
  if (!audit || audit.status === 'completed') return;
  const [business] = await rows('SELECT deletion_requested_at FROM businesses WHERE id=?', [
    businessId,
  ]);
  if (!business?.deletion_requested_at)
    throw new Error('Deletion was not requested for this tenant.');
  const [billing] = await rows('SELECT * FROM billing_accounts WHERE business_id=?', [businessId]);
  // Flush qualified usage before terminating the subscription, retaining an inspectable job on uncertainty.
  for (const item of await rows(
    'SELECT id FROM quote_usage WHERE business_id=? AND fee_cents>0 AND stripe_reported_at IS NULL',
    [businessId],
  ))
    await dispatchMeterEvent(String(item.id));
  if (billingProvider() === 'stripe' && billing?.stripe_subscription_id) {
    const stripe = stripeClient(),
      subscription = await stripe.subscriptions.retrieve(String(billing.stripe_subscription_id));
    if (subscription.status !== 'canceled')
      await stripe.subscriptions.cancel(subscription.id, { invoice_now: true, prorate: false });
  }
  // Keys are opaque UUIDs, and storage enforces a strict key pattern before a file can be deleted.
  for (const photo of await rows('SELECT storage_key FROM attachments WHERE business_id=?', [
    businessId,
  ]))
    await deletePhoto(String(photo.storage_key));
  await transaction(async (connection) => {
    await rows(
      'SELECT id FROM businesses WHERE id=? AND deletion_requested_at IS NOT NULL FOR UPDATE',
      [businessId],
      connection,
    );
    await mutate(
      'DELETE FROM owner_sessions WHERE user_id IN (SELECT id FROM users WHERE business_id=?)',
      [businessId],
      connection,
    );
    if (billing?.stripe_customer_id)
      await mutate(
        'DELETE FROM stripe_events WHERE customer_id=?',
        [billing.stripe_customer_id],
        connection,
      );
    const tables = (await tenantTables(connection)).filter(
      (table) => table !== 'account_deletion_audits',
    );
    const constraints = await rows(
      `SELECT TABLE_NAME AS child,REFERENCED_TABLE_NAME AS parent FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [],
      connection,
    );
    const remaining = new Set(tables);
    while (remaining.size) {
      const candidates = [...remaining].filter(
        (table) =>
          !constraints.some(
            (key) =>
              key.parent === table && key.child !== table && remaining.has(String(key.child)),
          ),
      );
      if (!candidates.length)
        throw new Error('Account cleanup encountered a schema dependency cycle.');
      for (const table of candidates) {
        await mutate(`DELETE FROM \`${table}\` WHERE business_id=?`, [businessId], connection);
        remaining.delete(table);
      }
    }
    await mutate(
      'DELETE FROM businesses WHERE id=? AND deletion_requested_at IS NOT NULL',
      [businessId],
      connection,
    );
    await mutate(
      "UPDATE account_deletion_audits SET status='completed',completed_at=UTC_TIMESTAMP(3) WHERE id=? AND business_id=?",
      [deletionId, businessId],
      connection,
    );
  });
}
