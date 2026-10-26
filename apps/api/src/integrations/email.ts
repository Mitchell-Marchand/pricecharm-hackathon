import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { ApiError } from '../http.js';
import { isDeployed } from '../config.js';

const emailSchema = z.object({
  to: z.email().max(254),
  subject: z.string().min(1).max(180),
  text: z.string().min(1).max(30000),
  requestAccess: z
    .object({
      quoteId: z.string().uuid(),
      sessionId: z.string().uuid(),
      tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.iso.datetime(),
      event: z.enum(['issued', 'owner_message']),
    })
    .strict()
    .optional(),
});
export type TransactionalEmail = z.infer<typeof emailSchema>;
export function mailProvider(): 'local' | 'ses' {
  const value =
    process.env.MAIL_PROVIDER || (process.env.NODE_ENV === 'production' ? 'ses' : 'local');
  if (value !== 'local' && value !== 'ses') throw new Error('MAIL_PROVIDER must be local or ses.');
  if (value === 'local' && process.env.NODE_ENV === 'production')
    throw new Error('Production cannot use local email.');
  return value;
}
function encryptionKey(): Buffer {
  if (process.env.MAIL_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.MAIL_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32)
      throw new Error('MAIL_ENCRYPTION_KEY must be 32 bytes encoded as base64.');
    return key;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('Production requires MAIL_ENCRYPTION_KEY.');
  return createHash('sha256').update('quotient-local-email-provider-never-production').digest();
}
export function validateEmailConfiguration(): void {
  encryptionKey();
  if (mailProvider() === 'ses' && (!process.env.SES_EMAIL_FROM || !process.env.AWS_REGION)) {
    throw new Error('SES requires SES_EMAIL_FROM and AWS_REGION.');
  }
}
export function encryptEmail(payload: TransactionalEmail): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(emailSchema.parse(payload)), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decryptEmail(payload: string): TransactionalEmail {
  const bytes = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return emailSchema.parse(
    JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    ),
  );
}
export async function queueEmail(
  input: TransactionalEmail & { businessId?: string; dedupeKey: string },
  connection?: Sql,
): Promise<string> {
  validateEmailConfiguration();
  const id = randomUUID();
  const write = async (sql: Sql) => {
    await mutate(
      `INSERT IGNORE INTO email_outbox(id,business_id,dedupe_key,payload_encrypted) VALUES (?,?,?,?)`,
      [id, input.businessId ?? null, input.dedupeKey, encryptEmail(input)],
      sql,
    );
    const [saved] = await rows(
      'SELECT id FROM email_outbox WHERE dedupe_key=?',
      [input.dedupeKey],
      sql,
    );
    await mutate(
      `INSERT IGNORE INTO jobs(id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'send_email',?,?)`,
      [
        randomUUID(),
        input.businessId ?? null,
        JSON.stringify({ emailId: saved.id }),
        `mail:${saved.id}`,
      ],
      sql,
    );
    return String(saved.id);
  };
  return connection ? write(connection) : transaction(write);
}

async function requestEmailSkipReason(
  item: { business_id: string | null; dedupe_key: string },
  payload: TransactionalEmail,
  connection: Sql,
) {
  const access = payload.requestAccess;
  if (!access)
    return /^quote:[a-f0-9-]{36}:(?:issued|owner-message:[a-f0-9-]{36})$/i.test(item.dedupe_key)
      ? 'Legacy request notification has no verifiable access grant.'
      : null;
  if (!item.business_id) return 'Request is unavailable for customer email.';
  const [request] = await rows(
    `SELECT s.email_token_hash,s.email_token_expires_at,s.status AS session_status,s.source AS session_source,
      s.verified_email,s.contact_verified_at,s.contact_consent_at,q.customer_email,q.status AS quote_status,q.source AS quote_source,b.deletion_requested_at
      FROM public_sessions s JOIN quotes q ON q.public_session_id=s.id AND q.business_id=s.business_id
      JOIN businesses b ON b.id=s.business_id WHERE s.id=? AND q.id=? AND s.business_id=?`,
    [access.sessionId, access.quoteId, item.business_id],
    connection,
  );
  if (
    !request ||
    request.deletion_requested_at ||
    request.quote_source !== 'live' ||
    request.session_source !== 'live' ||
    !['review', 'issued'].includes(request.quote_status) ||
    !['submitted', 'issued'].includes(request.session_status) ||
    (access.event === 'issued' && request.quote_status !== 'issued')
  )
    return 'Request is unavailable for customer email.';
  if (
    !request.contact_verified_at ||
    !request.contact_consent_at ||
    String(request.verified_email).toLowerCase() !== payload.to.toLowerCase() ||
    String(request.customer_email).toLowerCase() !== payload.to.toLowerCase()
  )
    return 'Recipient is no longer the verified inquiry contact.';
  if (request.email_token_hash !== access.tokenHash)
    return 'Request link was replaced before email delivery.';
  if (
    new Date(access.expiresAt).getTime() <= Date.now() ||
    !request.email_token_expires_at ||
    new Date(request.email_token_expires_at).getTime() <= Date.now() ||
    new Date(request.email_token_expires_at).getTime() !== new Date(access.expiresAt).getTime()
  )
    return 'Request link expired before email delivery.';
  return null;
}

export async function deliverEmail(emailId: string): Promise<void> {
  const claimed = await transaction(async (connection) => {
    // Match account deletion and owner updates: business first, then its outbox row.
    const [locator] = await rows(
      'SELECT business_id FROM email_outbox WHERE id=?',
      [emailId],
      connection,
    );
    if (locator?.business_id)
      await rows(
        'SELECT id FROM businesses WHERE id=? FOR UPDATE',
        [locator.business_id],
        connection,
      );
    const [item] = await rows(
      'SELECT * FROM email_outbox WHERE id=? FOR UPDATE',
      [emailId],
      connection,
    );
    if (!item || item.status === 'sent' || item.status === 'skipped') return null;
    if (item.status === 'sending' || item.status === 'uncertain') {
      throw new ApiError(
        409,
        'MAIL_RECONCILIATION_REQUIRED',
        'Email delivery has an uncertain outcome; inspect provider logs before retrying.',
      );
    }
    const payload = decryptEmail(String(item.payload_encrypted)),
      skipReason = await requestEmailSkipReason(
        item as { business_id: string | null; dedupe_key: string },
        payload,
        connection,
      );
    if (skipReason) {
      await mutate(
        "UPDATE email_outbox SET status='skipped',last_error=?,sent_at=NULL,provider_message_id=NULL WHERE id=?",
        [skipReason, emailId],
        connection,
      );
      return null;
    }
    await mutate(
      "UPDATE email_outbox SET status='sending',last_error=NULL WHERE id=?",
      [emailId],
      connection,
    );
    return { item, payload };
  });
  if (!claimed) return;
  const { payload } = claimed;
  if (mailProvider() === 'local') {
    await mutate(
      "UPDATE email_outbox SET status='sent',provider_message_id=?,sent_at=UTC_TIMESTAMP(3) WHERE id=?",
      [`local:${emailId}`, emailId],
    );
    return;
  }
  try {
    const client = new SESv2Client({
      region: process.env.AWS_REGION,
      maxAttempts: 1,
      requestHandler: { requestTimeout: 10000 },
    });
    const result = await client.send(
      new SendEmailCommand({
        FromEmailAddress: process.env.SES_EMAIL_FROM,
        Destination: { ToAddresses: [payload.to] },
        Content: {
          Simple: {
            Subject: { Data: payload.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: payload.text, Charset: 'UTF-8' } },
          },
        },
        EmailTags: [{ Name: 'quotient_email_id', Value: emailId }],
      }),
    );
    await mutate(
      "UPDATE email_outbox SET status='sent',provider_message_id=?,sent_at=UTC_TIMESTAMP(3) WHERE id=?",
      [result.MessageId ?? null, emailId],
    );
  } catch (error) {
    const code = (error as { name?: string }).name;
    const safeToRetry = [
      'TooManyRequestsException',
      'LimitExceededException',
      'MessageRejected',
      'MailFromDomainNotVerifiedException',
      'NotFoundException',
      'BadRequestException',
      'AccessDeniedException',
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'CredentialsProviderError',
    ].includes(code ?? '');
    await mutate('UPDATE email_outbox SET status=?,last_error=? WHERE id=?', [
      safeToRetry ? 'pending' : 'uncertain',
      safeToRetry
        ? 'SES rejected this attempt; correct configuration or retry.'
        : 'Provider outcome is unknown. Check SES logs before any resend.',
      emailId,
    ]);
    throw new Error('Transactional email delivery failed.');
  }
}

export async function localOutbox(businessId: string) {
  if (mailProvider() !== 'local' || process.env.NODE_ENV === 'production' || isDeployed())
    throw new ApiError(404, 'NOT_FOUND', 'Local outbox is unavailable.');
  return (
    await rows(
      'SELECT id,payload_encrypted,status,created_at FROM email_outbox WHERE business_id=? ORDER BY created_at DESC LIMIT 50',
      [businessId],
    )
  ).map((item) => ({
    id: item.id,
    ...decryptEmail(item.payload_encrypted),
    status: item.status,
    createdAt: new Date(item.created_at).toISOString(),
  }));
}
