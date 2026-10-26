import { isIP } from 'node:net';

/**
 * Where this process runs. Staging and production get the strict checks below no matter what
 * NODE_ENV says, so a server set up from .env.example can't fall back to local providers or hand
 * out sign-in tokens.
 */
export type AppEnv = 'local' | 'test' | 'staging' | 'production';
const APP_ENVS: readonly AppEnv[] = ['local', 'test', 'staging', 'production'];

function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '::1' ||
    (isIP(value) === 4 && value.startsWith('127.'))
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/i, '');
  return isIP(value) !== 0 && isLoopbackHost(value);
}

export function configuredOrigins(): string[] {
  return (process.env.APP_ORIGIN || 'http://localhost:3100')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function appEnv(): AppEnv {
  const value = process.env.APP_ENV?.trim();
  if (value) {
    if (!APP_ENVS.includes(value as AppEnv)) {
      throw new Error('APP_ENV must be local, test, staging or production.');
    }
    return value as AppEnv;
  }
  if (process.env.NODE_ENV === 'production') return 'production';
  return process.env.NODE_ENV === 'test' ? 'test' : 'local';
}

/** True for staging and production, and for any origin that isn't this machine. */
export function isDeployed(): boolean {
  const env = appEnv();
  return (
    env === 'staging' ||
    env === 'production' ||
    configuredOrigins().some((origin) => !isLocalOrigin(origin))
  );
}

/**
 * Local runs and tests can return email codes and links in API responses, so flows work without
 * an inbox. That needs EXPOSE_DEV_TOKENS=1, a local deployment and a request from this machine.
 */
export function devTokensAllowed(request: { socket: { remoteAddress?: string } }): boolean {
  return (
    process.env.EXPOSE_DEV_TOKENS === '1' &&
    process.env.NODE_ENV !== 'production' &&
    !isDeployed() &&
    isLoopbackAddress(request.socket.remoteAddress)
  );
}

/** Refuses to start a deployed process with settings that are only safe on a laptop. */
export function validateRuntimeConfiguration(): void {
  const env = appEnv();
  const deployed = isDeployed();
  if (!deployed) return;
  const problems: string[] = [];
  if (env !== 'staging' && env !== 'production') {
    problems.push('APP_ORIGIN is not on this machine, so set APP_ENV to staging or production.');
  }
  if (process.env.NODE_ENV !== 'production')
    problems.push('Set NODE_ENV=production on deployed servers.');
  if (process.env.EXPOSE_DEV_TOKENS === '1') {
    problems.push('Remove EXPOSE_DEV_TOKENS. It is only for local development and tests.');
  }
  for (const name of ['AI_PROVIDER', 'MAIL_PROVIDER', 'BILLING_PROVIDER', 'TRUST_PROXY']) {
    if (!process.env[name]?.trim()) problems.push(`Set ${name} explicitly.`);
  }
  if (process.env.TRUST_PROXY && !['0', '1'].includes(process.env.TRUST_PROXY)) {
    problems.push('TRUST_PROXY must be 0 (no proxy) or 1 (exactly one proxy, such as Nginx).');
  }
  if (!isLoopbackHost(process.env.DB_HOST || '127.0.0.1') && process.env.DB_SSL !== '1') {
    problems.push('Set DB_SSL=1. The database is on another host, so connections must use TLS.');
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (env === 'production' && /^(sk|rk)_test_/.test(stripeKey)) {
    problems.push('Production needs a live Stripe key, not a test key.');
  }
  if (env === 'staging' && /^(sk|rk)_live_/.test(stripeKey)) {
    problems.push('Staging must use a Stripe test key so it can never charge a real card.');
  }
  if (problems.length) {
    throw new Error(`The ${env} configuration is not safe to run:\n- ${problems.join('\n- ')}`);
  }
}

/** Migrations run as a separate database user that can change the schema; the app user can't. */
export function applyMigrationCredentials(): void {
  const user = process.env.MIGRATION_DB_USER?.trim();
  if (!user) {
    if (isDeployed()) {
      throw new Error(
        'Set MIGRATION_DB_USER and MIGRATION_DB_PASS. Deployed migrations use their own database user.',
      );
    }
    return;
  }
  if (isDeployed() && user === process.env.DB_USER) {
    throw new Error('MIGRATION_DB_USER must be a different user from DB_USER.');
  }
  process.env.DB_USER = user;
  process.env.DB_PASS = process.env.MIGRATION_DB_PASS ?? '';
}
