import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok } from './http.js';
import { isDisposableEmail } from './email-domains.js';
import { businessById, type Row } from './models.js';
import { authRateLimitReached, consumeAuthRateLimit, createOwnerToken } from './verification.js';
import { hashingSecret } from './config.js';

const scryptAsync = promisify(scrypt);
const COOKIE_NAME = 'quotient_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE = 'quotient_known_device';
const DEVICE_MS = 180 * 24 * 60 * 60 * 1000;
export interface AuthContext {
  userId: string;
  businessId: string;
  name: string;
  email: string;
  emailVerified: boolean;
}
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
export function newToken() {
  return randomBytes(32).toString('base64url');
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hash] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    !/^[0-9a-f]{32}$/.test(salt || '') ||
    !/^[0-9a-f]{128}$/.test(hash || '')
  )
    return false;
  const actual = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
/**
 * Wrong passwords for one account, from any address. Past these the account takes no more guesses
 * until the window ends or the owner resets their password. Signing in doesn't reset the count, so
 * an owner signing in mid-attack doesn't hand the attacker fresh guesses.
 */
const LOGIN_FAILURE_LIMITS = [
  { prefix: 'login-failures', maximum: 10, windowMs: 15 * 60_000 },
  { prefix: 'login-failures-day', maximum: 50, windowMs: 24 * 60 * 60_000 },
];
export function loginFailureKeys(email: string): string[] {
  return LOGIN_FAILURE_LIMITS.map(({ prefix }) => `${prefix}:${email.toLowerCase()}`);
}

/**
 * A browser that has signed in to this account before keeps a cookie that skips the account lock,
 * so someone guessing passwords can't lock the owner out. It's tied to the password, so a reset
 * retires every old one.
 */
function deviceProof(user: Row): string | null {
  const key = hashingSecret();
  if (!key) return null;
  return createHmac('sha256', key)
    .update(`known-device-v1:${user.id}:${user.password_hash}`)
    .digest('base64url');
}
function isKnownDevice(req: Request, user: Row): boolean {
  const expected = deviceProof(user),
    actual = cookies(req)[DEVICE_COOKIE];
  return (
    !!expected &&
    !!actual &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

export function cookies(req: Request): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      result[part.slice(0, separator).trim()] = decodeURIComponent(
        part.slice(separator + 1).trim(),
      );
    } catch {
      /* Malformed cookie cannot authenticate. */
    }
  }
  return result;
}
function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1',
    maxAge: SESSION_MS,
  });
}
async function createSession(userId: string, res: Response, connection?: Sql) {
  const token = newToken();
  await mutate(
    'INSERT INTO owner_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [randomUUID(), userId, hashToken(token), new Date(Date.now() + SESSION_MS)],
    connection,
  );
  setSessionCookie(res, token);
}
export const requireOwner: RequestHandler = async (req, _res, next) => {
  const token = cookies(req)[COOKIE_NAME];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const [user] = await rows(
    'SELECT u.id, u.business_id, u.name, u.email, u.email_verified_at FROM owner_sessions s JOIN users u ON u.id = s.user_id JOIN businesses b ON b.id=u.business_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND b.deletion_requested_at IS NULL LIMIT 1',
    [hashToken(token)],
  );
  if (!user) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.');
  req.auth = {
    userId: user.id,
    businessId: user.business_id,
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
  };
  next();
};
export function owner(req: Request): AuthContext {
  if (!req.auth) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return req.auth;
}
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = (process.env.APP_ORIGIN || 'http://localhost:3100')
    .split(',')
    .map((value) => value.trim());
  if (!req.headers.origin || !expected.includes(req.headers.origin))
    throw new ApiError(403, 'ORIGIN_REJECTED', 'This request must come from the Quotefolk app.');
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new ApiError(403, 'CSRF_REJECTED', 'Cross-site account requests are blocked.');
  next();
};
export const register: RequestHandler = async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(160),
      businessName: z.string().trim().min(2).max(160),
      email: z
        .email()
        .max(254)
        .transform((value) => value.toLowerCase()),
      password: z.string().min(10).max(128),
    })
    .strict()
    .parse(req.body);
  if (isDisposableEmail(input.email))
    throw new ApiError(
      422,
      'DISPOSABLE_EMAIL',
      'Please use an email address you’ll keep. Temporary inboxes can’t be used for an account.',
    );
  const passwordHash = await hashPassword(input.password);
  const businessId = randomUUID(),
    userId = randomUUID();
  const baseSlug =
    input.businessName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || 'business';
  const slug = `${baseSlug}-${businessId.slice(0, 8)}`;
  try {
    await transaction(async (connection) => {
      await mutate(
        'INSERT INTO businesses (id, name, slug, description) VALUES (?, ?, ?, ?)',
        [businessId, input.businessName, slug, ''],
        connection,
      );
      await mutate(
        'INSERT INTO users (id, business_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)',
        [userId, businessId, input.name, input.email, passwordHash],
        connection,
      );
      await createSession(userId, res, connection);
      await createOwnerToken(
        { userId, businessId, email: input.email, purpose: 'verify_email' },
        connection,
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
      throw new ApiError(
        409,
        'ACCOUNT_EXISTS',
        'An account with this email already exists. Sign in instead.',
      );
    throw error;
  }
  res.status(201).json(
    ok({
      user: { id: userId, name: input.name, email: input.email, emailVerified: false },
      business: await businessById(businessId),
    }),
  );
};
export const login: RequestHandler = async (req, res) => {
  const input = z
    .object({
      email: z
        .email()
        .max(254)
        .transform((value) => value.toLowerCase()),
      password: z.string().min(1).max(128),
    })
    .strict()
    .parse(req.body);
  await consumeAuthRateLimit(`login:${input.email}:${req.ip}`, 20, 15 * 60_000);
  const [user] = await rows(
    'SELECT u.* FROM users u JOIN businesses b ON b.id=u.business_id WHERE u.email=? AND b.deletion_requested_at IS NULL LIMIT 1',
    [input.email],
  );
  const failureKeys = loginFailureKeys(input.email);
  // Locks apply to any email, so a lock never reveals whether an account exists.
  if (!(user && isKnownDevice(req, user))) {
    for (const [index, { maximum, windowMs }] of LOGIN_FAILURE_LIMITS.entries())
      if (await authRateLimitReached(failureKeys[index], maximum, windowMs))
        throw new ApiError(
          429,
          'ACCOUNT_LOCKED',
          'Too many wrong passwords for this account. Try again later, or reset your password.',
        );
  }
  const valid = await verifyPassword(
    input.password,
    user?.password_hash || `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`,
  );
  if (!user || !valid) {
    for (const [index, { maximum, windowMs }] of LOGIN_FAILURE_LIMITS.entries())
      await consumeAuthRateLimit(failureKeys[index], maximum, windowMs).catch((error) => {
        if (!(error instanceof ApiError && error.code === 'IDENTITY_RATE_LIMIT')) throw error;
      });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  const proof = deviceProof(user);
  if (proof)
    res.cookie(DEVICE_COOKIE, proof, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: DEVICE_MS,
    });
  // Rotate this browser's prior session instead of accumulating valid tokens on repeated sign-in.
  const prior = cookies(req)[COOKIE_NAME];
  if (prior) await mutate('DELETE FROM owner_sessions WHERE token_hash = ?', [hashToken(prior)]);
  await createSession(user.id, res);
  res.json(
    ok({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: Boolean(user.email_verified_at),
      },
      business: await businessById(user.business_id),
    }),
  );
};
export const logout: RequestHandler = async (req, res) => {
  const token = cookies(req)[COOKIE_NAME];
  if (token) await mutate('DELETE FROM owner_sessions WHERE token_hash = ?', [hashToken(token)]);
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1',
  });
  res.json(ok({ ok: true }));
};
export const me: RequestHandler = async (req, res) => {
  const context = owner(req);
  res.json(
    ok({
      user: {
        id: context.userId,
        name: context.name,
        email: context.email,
        emailVerified: context.emailVerified,
      },
      business: await businessById(context.businessId),
    }),
  );
};
