import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { devTokensAllowed } from './config.js';
import { hashPassword, hashToken, newToken, owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok, rateLimit } from './http.js';
import { mailProvider, queueEmail } from './integrations/email.js';

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
function applicationOrigin(): string {
  const value = (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
  const url = new URL(value);
  if (url.origin !== value || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:'))
    throw new Error('APP_ORIGIN must contain valid application origins.');
  return value;
}
export async function consumeAuthRateLimit(
  key: string,
  maximum: number,
  windowMs: number,
  connection?: Sql,
): Promise<void> {
  const consume = async (connection: Sql) => {
    const bucket = hashToken(key);
    await mutate(
      'INSERT INTO auth_rate_limits(bucket_key,window_started_at) VALUES (?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bucket_key=VALUES(bucket_key)',
      [bucket],
      connection,
    );
    const [row] = await rows(
      'SELECT * FROM auth_rate_limits WHERE bucket_key=? FOR UPDATE',
      [bucket],
      connection,
    );
    const expired = new Date(row.window_started_at).getTime() + windowMs <= Date.now();
    if (!expired && Number(row.attempts) >= maximum) return false;
    await mutate(
      'UPDATE auth_rate_limits SET attempts=?,window_started_at=?,updated_at=UTC_TIMESTAMP(3) WHERE bucket_key=?',
      [
        expired ? 1 : Number(row.attempts) + 1,
        expired ? new Date() : new Date(row.window_started_at),
        bucket,
      ],
      connection,
    );
    return true;
  };
  const allowed = connection ? await consume(connection) : await transaction(consume);
  if (!allowed)
    throw new ApiError(
      429,
      'IDENTITY_RATE_LIMIT',
      'Too many attempts. Please wait before trying again.',
    );
}

export async function createOwnerToken(
  input: {
    userId: string;
    businessId: string;
    email: string;
    purpose: 'verify_email' | 'reset_password';
  },
  connection?: Sql,
): Promise<string> {
  const token = newToken();
  const save = async (sql: Sql) => {
    const [business] = await rows(
      'SELECT id FROM businesses WHERE id=? AND deletion_requested_at IS NULL FOR UPDATE',
      [input.businessId],
      sql,
    );
    if (!business) throw new ApiError(409, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
    await rows(
      'SELECT id FROM users WHERE id=? AND business_id=? FOR UPDATE',
      [input.userId, input.businessId],
      sql,
    );
    await mutate(
      'UPDATE identity_tokens SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND purpose=? AND used_at IS NULL',
      [input.userId, input.purpose],
      sql,
    );
    await mutate(
      'INSERT INTO identity_tokens(id,business_id,user_id,purpose,token_hash,expires_at) VALUES (?,?,?,?,?,?)',
      [
        randomUUID(),
        input.businessId,
        input.userId,
        input.purpose,
        hashToken(token),
        new Date(Date.now() + (input.purpose === 'reset_password' ? 30 : 1440) * 60_000),
      ],
      sql,
    );
    const route = input.purpose === 'reset_password' ? '/reset-password' : '/verify-email';
    await queueEmail(
      {
        businessId: input.businessId,
        dedupeKey: `${input.purpose}:${hashToken(token)}`,
        to: input.email,
        subject:
          input.purpose === 'reset_password'
            ? 'Reset your Quotefolk password'
            : 'Verify your Quotefolk email',
        text: `${input.purpose === 'reset_password' ? 'Reset your password' : 'Verify your email address'} using this single-use link:\n${applicationOrigin()}${route}#token=${encodeURIComponent(token)}\n\nIf you did not request this, you can ignore this email.`,
      },
      sql,
    );
  };
  if (connection) await save(connection);
  else await transaction(save);
  return token;
}

export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
  await consumeAuthRateLimit(`forgot:${email}:${req.ip}`, 5, 3600_000);
  const [user] = await rows('SELECT id,business_id,email FROM users WHERE email=?', [email]);
  const token = user
    ? await createOwnerToken({
        userId: user.id,
        businessId: user.business_id,
        email,
        purpose: 'reset_password',
      })
    : undefined;
  res.json(
    ok({
      ok: true,
      ...(mailProvider() === 'local' && token && devTokensAllowed(req) ? { devToken: token } : {}),
    }),
  );
};
export const requestOwnerVerification: RequestHandler = async (req, res) => {
  const context = owner(req);
  await consumeAuthRateLimit(`verify-owner:${context.userId}`, 5, 3600_000);
  const [user] = await rows('SELECT email_verified_at FROM users WHERE id=? AND business_id=?', [
    context.userId,
    context.businessId,
  ]);
  if (user?.email_verified_at) {
    res.json(ok({ ok: true, delivery: mailProvider() === 'local' ? 'local' : 'email' }));
    return;
  }
  const token = await createOwnerToken({
    userId: context.userId,
    businessId: context.businessId,
    email: context.email,
    purpose: 'verify_email',
  });
  res.json(
    ok({
      ok: true,
      delivery: mailProvider() === 'local' ? 'local' : 'email',
      ...(mailProvider() === 'local' && devTokensAllowed(req) ? { devToken: token } : {}),
    }),
  );
};
async function consumeOwnerToken(
  token: string,
  purpose: string,
  update: (userId: string, sql: Sql) => Promise<void>,
): Promise<void> {
  await transaction(async (connection) => {
    const [lookup] = await rows(
      'SELECT business_id,user_id FROM identity_tokens WHERE token_hash=? AND purpose=?',
      [hashToken(token), purpose],
      connection,
    );
    if (!lookup)
      throw new ApiError(
        400,
        'TOKEN_INVALID',
        'This link has expired or was already used. Request a new one.',
      );
    const [business] = await rows(
      'SELECT deletion_requested_at FROM businesses WHERE id=? FOR UPDATE',
      [lookup.business_id],
      connection,
    );
    if (!business || business.deletion_requested_at)
      throw new ApiError(400, 'TOKEN_INVALID', 'This account is unavailable.');
    await rows(
      'SELECT id FROM users WHERE id=? AND business_id=? FOR UPDATE',
      [lookup.user_id, lookup.business_id],
      connection,
    );
    const [item] = await rows(
      'SELECT * FROM identity_tokens WHERE token_hash=? AND purpose=? FOR UPDATE',
      [hashToken(token), purpose],
      connection,
    );
    if (!item || item.used_at || new Date(item.expires_at).getTime() <= Date.now())
      throw new ApiError(
        400,
        'TOKEN_INVALID',
        'This link has expired or was already used. Request a new one.',
      );
    await update(String(item.user_id), connection);
    await mutate(
      'UPDATE identity_tokens SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND purpose=? AND used_at IS NULL',
      [item.user_id, purpose],
      connection,
    );
  });
}
export const verifyOwnerEmail: RequestHandler = async (req, res) => {
  const { token } = z
    .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .strict()
    .parse(req.body);
  await consumeAuthRateLimit(`consume-token:${req.ip}`, 30, 3600_000);
  await consumeOwnerToken(token, 'verify_email', async (userId, connection) => {
    await mutate(
      'UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE id=?',
      [userId],
      connection,
    );
  });
  res.json(ok({ ok: true }));
};
export const resetPassword: RequestHandler = async (req, res) => {
  const { token, password } = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      password: z.string().min(10).max(128),
    })
    .strict()
    .parse(req.body);
  await consumeAuthRateLimit(`reset-token:${req.ip}`, 20, 3600_000);
  const passwordHash = await hashPassword(password);
  await consumeOwnerToken(token, 'reset_password', async (userId, connection) => {
    await mutate('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, userId], connection);
    await mutate('DELETE FROM owner_sessions WHERE user_id=?', [userId], connection);
  });
  res.json(ok({ ok: true }));
};

export async function requestContactVerification(input: {
  businessId: string;
  sessionId: string;
  email: string;
  ip?: string;
  /** Only for local runs: return the code so the flow works without an inbox. */
  exposeCode?: boolean;
}): Promise<{ verificationId: string; delivery: 'email' | 'local'; devCode?: string }> {
  const email = emailSchema.parse(input.email),
    verificationId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  if (input.ip) await consumeAuthRateLimit(`contact-ip:${input.ip}`, 20, 3600_000);
  await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT id FROM businesses WHERE id=? AND deletion_requested_at IS NULL FOR UPDATE',
      [input.businessId],
      connection,
    );
    if (!business) throw new ApiError(404, 'SESSION_NOT_FOUND', 'This inquiry is unavailable.');
    const [session] = await rows(
      "SELECT id FROM public_sessions WHERE id=? AND business_id=? AND (expires_at>UTC_TIMESTAMP(3) OR (email_token_hash IS NOT NULL AND email_token_expires_at>UTC_TIMESTAMP(3))) AND status IN ('active','submitted') FOR UPDATE",
      [input.sessionId, input.businessId],
      connection,
    );
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'This inquiry is unavailable.');
    const recent = await rows(
      'SELECT created_at FROM contact_verifications WHERE business_id=? AND session_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE) ORDER BY created_at DESC',
      [input.businessId, input.sessionId],
      connection,
    );
    if (
      recent.length >= 3 ||
      (recent[0] && new Date(recent[0].created_at).getTime() > Date.now() - 60_000)
    )
      throw new ApiError(
        429,
        'VERIFICATION_RATE_LIMIT',
        'Please wait before requesting another code.',
      );
    await mutate(
      'UPDATE contact_verifications SET used_at=UTC_TIMESTAMP(3) WHERE business_id=? AND session_id=? AND used_at IS NULL',
      [input.businessId, input.sessionId],
      connection,
    );
    await mutate(
      'INSERT INTO contact_verifications(id,business_id,session_id,email,code_hash,expires_at) VALUES (?,?,?,?,?,?)',
      [
        verificationId,
        input.businessId,
        input.sessionId,
        email,
        hashContactCode(
          `${verificationId}:${input.businessId}:${input.sessionId}:${email}:${code}`,
        ),
        new Date(Date.now() + 10 * 60_000),
      ],
      connection,
    );
    await queueEmail(
      {
        businessId: input.businessId,
        dedupeKey: `contact:${verificationId}`,
        to: email,
        subject: 'Your quote verification code',
        text: `Your Quotefolk verification code is ${code}. It expires in 10 minutes and can only verify this quote request. If you did not request this, ignore this message.`,
      },
      connection,
    );
  });
  return {
    verificationId,
    delivery: mailProvider() === 'local' ? 'local' : 'email',
    ...(mailProvider() === 'local' && input.exposeCode ? { devCode: code } : {}),
  };
}
export async function verifyContactVerification(input: {
  businessId: string;
  sessionId: string;
  verificationId: string;
  code: string;
}): Promise<{ email: string; verifiedAt: string }> {
  z.string().uuid().parse(input.verificationId);
  const result = await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT id FROM businesses WHERE id=? AND deletion_requested_at IS NULL FOR UPDATE',
      [input.businessId],
      connection,
    );
    if (!business) return { error: true as const };
    const [session] = await rows(
      "SELECT id FROM public_sessions WHERE id=? AND business_id=? AND (expires_at>UTC_TIMESTAMP(3) OR (email_token_hash IS NOT NULL AND email_token_expires_at>UTC_TIMESTAMP(3))) AND status IN ('active','submitted') FOR UPDATE",
      [input.sessionId, input.businessId],
      connection,
    );
    const [item] = await rows(
      'SELECT * FROM contact_verifications WHERE id=? AND business_id=? AND session_id=? FOR UPDATE',
      [input.verificationId, input.businessId, input.sessionId],
      connection,
    );
    if (
      !session ||
      !item ||
      item.used_at ||
      Number(item.attempts) >= 5 ||
      new Date(item.expires_at).getTime() <= Date.now()
    )
      return { error: true as const };
    await mutate(
      'UPDATE contact_verifications SET attempts=attempts+1 WHERE id=?',
      [item.id],
      connection,
    );
    const expected = Buffer.from(item.code_hash, 'hex');
    const actual = Buffer.from(
      hashContactCode(
        `${input.verificationId}:${input.businessId}:${input.sessionId}:${item.email}:${input.code}`,
      ),
      'hex',
    );
    if (!/^\d{6}$/.test(input.code) || !timingSafeEqual(expected, actual))
      return { error: true as const };
    await mutate(
      'UPDATE contact_verifications SET used_at=UTC_TIMESTAMP(3) WHERE id=?',
      [item.id],
      connection,
    );
    const verifiedAt = new Date();
    await mutate(
      'UPDATE public_sessions SET verified_email=?,contact_verified_at=? WHERE business_id=? AND id=?',
      [item.email, verifiedAt, input.businessId, input.sessionId],
      connection,
    );
    return { email: String(item.email), verifiedAt: verifiedAt.toISOString() };
  });
  if ('error' in result)
    throw new ApiError(
      400,
      'CODE_INVALID',
      'This code is incorrect, expired, or already used. Request a new code if needed.',
    );
  return result;
}
function hashContactCode(value: string): string {
  const key = process.env.MAIL_ENCRYPTION_KEY || 'quotient-local-contact-code-pepper';
  if (process.env.NODE_ENV === 'production' && !process.env.MAIL_ENCRYPTION_KEY)
    throw new Error('Contact verification requires a production identity secret.');
  const contextKey = createHmac('sha256', key).update('quotient-contact-verification-v1').digest();
  return createHmac('sha256', contextKey).update(value).digest('hex');
}
export async function isContactVerified(
  businessId: string,
  sessionId: string,
  email: string,
  connection?: Sql,
): Promise<boolean> {
  const normalized = emailSchema.safeParse(email);
  if (!normalized.success) return false;
  const [session] = await rows(
    "SELECT id FROM public_sessions WHERE business_id=? AND id=? AND verified_email=? AND contact_verified_at IS NOT NULL AND status<>'expired' AND (expires_at>UTC_TIMESTAMP(3) OR (email_token_hash IS NOT NULL AND email_token_expires_at>UTC_TIMESTAMP(3)))",
    [businessId, sessionId, normalized.data],
    connection,
  );
  return Boolean(session);
}
