import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { devTokensAllowed } from './config.js';
import { hashPassword, hashToken, loginFailureKeys, newToken, owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { mailProvider, queueEmail } from './integrations/email.js';
import { recordOwnerMilestone } from './metrics.js';

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

/** Whether a bucket is already full, without counting this attempt. */
export async function authRateLimitReached(
  key: string,
  maximum: number,
  windowMs: number,
): Promise<boolean> {
  const [row] = await rows(
    'SELECT attempts,window_started_at FROM auth_rate_limits WHERE bucket_key=?',
    [hashToken(key)],
  );
  return (
    !!row &&
    new Date(row.window_started_at).getTime() + windowMs > Date.now() &&
    Number(row.attempts) >= maximum
  );
}

export async function clearAuthRateLimits(keys: string[], connection?: Sql): Promise<void> {
  if (!keys.length) return;
  await mutate(
    `DELETE FROM auth_rate_limits WHERE bucket_key IN (${keys.map(() => '?').join(',')})`,
    keys.map(hashToken),
    connection,
  );
}

/** Wrong codes allowed before a code stops working and the owner needs a new one. */
const CODE_ATTEMPTS = 5;
const codeHash = (tokenId: string, code: string) => hashToken(`${tokenId}:${code}`);

/**
 * A single-use link, emailed. Confirming an email also gets a 6-digit code in the same email, for
 * the page the owner signed up on: no switching to a mail app's browser where they aren't signed in.
 */
export async function createOwnerToken(
  input: {
    userId: string;
    businessId: string;
    email: string;
    purpose: 'verify_email' | 'reset_password';
  },
  connection?: Sql,
): Promise<{ token: string; code: string | null }> {
  const token = newToken();
  const tokenId = randomUUID();
  const code =
    input.purpose === 'verify_email' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
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
      'INSERT INTO identity_tokens(id,business_id,user_id,purpose,token_hash,code_hash,expires_at) VALUES (?,?,?,?,?,?,?)',
      [
        tokenId,
        input.businessId,
        input.userId,
        input.purpose,
        hashToken(token),
        code ? codeHash(tokenId, code) : null,
        new Date(Date.now() + (input.purpose === 'reset_password' ? 30 : 1440) * 60_000),
      ],
      sql,
    );
    const route = input.purpose === 'reset_password' ? '/reset-password' : '/verify-email';
    const link = `${applicationOrigin()}${route}#token=${encodeURIComponent(token)}`;
    await queueEmail(
      {
        businessId: input.businessId,
        dedupeKey: `${input.purpose}:${hashToken(token)}`,
        to: input.email,
        subject: code ? `${code} is your PriceCharm code` : 'Reset your PriceCharm password',
        text: code
          ? `Your PriceCharm code is ${code}. Enter it on the page where you signed up to confirm your email.\n\nOr confirm with this link:\n${link}\n\nIf you did not sign up for PriceCharm, you can ignore this email.`
          : `Reset your password using this single-use link:\n${link}\n\nIf you did not request this, you can ignore this email.`,
      },
      sql,
    );
  };
  if (connection) await save(connection);
  else await transaction(save);
  return { token, code };
}

export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
  await consumeAuthRateLimit(`forgot:${email}:${req.ip}`, 5, 3600_000);
  const [user] = await rows('SELECT id,business_id,email FROM users WHERE email=?', [email]);
  const token = user
    ? (
        await createOwnerToken({
          userId: user.id,
          businessId: user.business_id,
          email,
          purpose: 'reset_password',
        })
      ).token
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
  const { token, code } = await createOwnerToken({
    userId: context.userId,
    businessId: context.businessId,
    email: context.email,
    purpose: 'verify_email',
  });
  res.json(
    ok({
      ok: true,
      delivery: mailProvider() === 'local' ? 'local' : 'email',
      ...(mailProvider() === 'local' && devTokensAllowed(req)
        ? { devToken: token, devCode: code }
        : {}),
    }),
  );
};

/** The owner types the code from the confirmation email, on the page they signed up on. */
export const verifyOwnerCode: RequestHandler = async (req, res) => {
  const context = owner(req);
  const { code } = z
    .object({
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, 'Enter the 6-digit code from the email.'),
    })
    .strict()
    .parse(req.body);
  await consumeAuthRateLimit(`verify-code:${context.userId}`, 20, 3600_000);
  const verified = await transaction(async (connection) => {
    const [user] = await rows(
      'SELECT email_verified_at FROM users WHERE id=? AND business_id=? FOR UPDATE',
      [context.userId, context.businessId],
      connection,
    );
    if (user?.email_verified_at) return true;
    // Only the latest code works: asking for a new one retires the old.
    const [item] = await rows(
      "SELECT * FROM identity_tokens WHERE user_id=? AND purpose='verify_email' AND used_at IS NULL AND code_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [context.userId],
      connection,
    );
    if (
      !item ||
      Number(item.code_attempts) >= CODE_ATTEMPTS ||
      new Date(item.expires_at).getTime() <= Date.now()
    )
      return false;
    await mutate(
      'UPDATE identity_tokens SET code_attempts=code_attempts+1 WHERE id=?',
      [item.id],
      connection,
    );
    const expected = Buffer.from(String(item.code_hash), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(codeHash(String(item.id), code), 'hex')))
      return false;
    await mutate(
      'UPDATE users SET email_verified_at=UTC_TIMESTAMP(3) WHERE id=?',
      [context.userId],
      connection,
    );
    await recordOwnerMilestone(connection, context.userId, 'email_verified');
    await mutate(
      "UPDATE identity_tokens SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND purpose='verify_email' AND used_at IS NULL",
      [context.userId],
      connection,
    );
    return true;
  });
  if (!verified)
    throw new ApiError(
      400,
      'CODE_INVALID',
      'That code didn’t work. Check it, or send yourself a new one.',
    );
  res.json(ok({ ok: true }));
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
    await recordOwnerMilestone(connection, userId, 'email_verified');
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
    // A new password ends any lock that wrong guesses put on the account.
    const [user] = await rows('SELECT email FROM users WHERE id=?', [userId], connection);
    if (user) await clearAuthRateLimits(loginFailureKeys(user.email), connection);
  });
  res.json(ok({ ok: true }));
};
