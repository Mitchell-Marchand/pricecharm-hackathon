import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const base: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'production',
  APP_ENV: 'staging',
  TRUST_PROXY: '1',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'test-openai-config-only-never-send',
  OPENAI_MODEL: 'gpt-4.1-mini',
  ANTHROPIC_API_KEY: 'test-anthropic-config-only-never-send',
  ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  APP_ORIGIN: 'https://app.example.test',
  MAIL_PROVIDER: 'ses',
  MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SES_EMAIL_FROM: 'sender@example.test',
  AWS_REGION: 'us-east-1',
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_config_only_never_charge',
  STRIPE_WEBHOOK_SECRET: 'whsec_config_only',
  STRIPE_PRICE_PER_QUOTE: 'price_config_per_quote',
  STRIPE_PRICE_PER_ACCEPTED: 'price_config_per_accepted',
  STRIPE_PRICE_EXTRA_QUOTES: 'price_config_extra_quotes',
  STRIPE_PRICE_MONTHLY: 'price_config_monthly',
  STRIPE_PRICE_YEARLY: 'price_config_yearly',
  STRIPE_METER_EVENT_NAME: 'pricecharm_quotes',
  SUPPORT_EMAIL: 'support@example.test',
  OPERATOR_NAME: 'Configuration test operator',
  OPERATOR_ADDRESS: '1 Example Street, Austin, TX 78701',
  GOVERNING_LAW: 'Texas',
  // Cloudflare's published always-pass test secret, which staging may use.
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  DB_NAME: 'quotient_config_no_connection',
  DB_USER: 'config_no_connection',
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
};
const bootstrap = `
import http from 'node:http';
import https from 'node:https';
const blocked = () => { throw new Error('Unexpected network request during configuration validation.'); };
http.request = blocked;
https.request = blocked;
globalThis.fetch = blocked;
try {
  const {createApp} = await import('./src/app.ts');
  if (typeof createApp() !== 'function') throw new Error('Application did not initialize.');
  process.stdout.write('CONFIG_OK');
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 1;
}
`;
function inspect(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap], {
    cwd,
    env: { ...base, ...overrides },
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 64 * 1024,
  });
}

// Built at runtime so no live-looking key appears in the source.
const liveStripeKey = ['sk', 'live', 'config_only_never_charge'].join('_');
const production: NodeJS.ProcessEnv = {
  APP_ENV: 'production',
  STRIPE_SECRET_KEY: liveStripeKey,
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAconfigOnlySecret',
  SENTRY_DSN: 'https://config-only@errors.example.test/1',
};

for (const provider of ['openai', 'anthropic']) {
  test(`fully configured staging initializes with ${provider} without any network action`, () => {
    const result = inspect({ AI_PROVIDER: provider });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'CONFIG_OK');
  });
}
test('fully configured production initializes with a live Stripe key', () => {
  const result = inspect(production);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CONFIG_OK');
});
const rejected: { name: string; env: NodeJS.ProcessEnv; message: RegExp }[] = [
  {
    name: 'a test Stripe key in production',
    env: { APP_ENV: 'production' },
    message: /live Stripe key/,
  },
  {
    name: 'a live Stripe key in staging',
    env: { STRIPE_SECRET_KEY: liveStripeKey },
    message: /Stripe test key/,
  },
  {
    name: 'a public origin without APP_ENV',
    env: { APP_ENV: '', NODE_ENV: 'development' },
    message: /set APP_ENV to staging or production/,
  },
  { name: 'development mode', env: { NODE_ENV: 'development' }, message: /NODE_ENV=production/ },
  { name: 'dev tokens', env: { EXPOSE_DEV_TOKENS: '1' }, message: /EXPOSE_DEV_TOKENS/ },
  {
    name: 'an implicit mail provider',
    env: { MAIL_PROVIDER: '' },
    message: /Set MAIL_PROVIDER explicitly/,
  },
  {
    name: 'an implicit proxy setting',
    env: { TRUST_PROXY: '' },
    message: /Set TRUST_PROXY explicitly/,
  },
  {
    name: 'an unknown proxy setting',
    env: { TRUST_PROXY: 'true' },
    message: /TRUST_PROXY must be 0/,
  },
  {
    name: 'an unencrypted remote database',
    env: { DB_HOST: 'db.internal.example.test' },
    message: /DB_SSL=1/,
  },
  { name: 'an unknown APP_ENV', env: { APP_ENV: 'prod' }, message: /APP_ENV must be/ },
  { name: 'demo AI', env: { AI_PROVIDER: 'demo' }, message: /demo AI/ },
  { name: 'local mail', env: { MAIL_PROVIDER: 'local' }, message: /local email/ },
  { name: 'local payments', env: { BILLING_PROVIDER: 'local' }, message: /local payments/ },
  {
    name: 'missing encryption key',
    env: { MAIL_ENCRYPTION_KEY: '' },
    message: /MAIL_ENCRYPTION_KEY/,
  },
  { name: 'invalid encryption key', env: { MAIL_ENCRYPTION_KEY: 'short' }, message: /32 bytes/ },
  { name: 'missing SES sender', env: { SES_EMAIL_FROM: '' }, message: /SES requires/ },
  { name: 'missing SES region', env: { AWS_REGION: '' }, message: /SES requires/ },
  {
    name: 'missing Stripe credentials',
    env: { STRIPE_SECRET_KEY: '' },
    message: /Production requires the Stripe secret/,
  },
  {
    name: 'missing Stripe meter',
    env: { STRIPE_METER_EVENT_NAME: '' },
    message: /Production requires the Stripe secret/,
  },
  {
    name: 'missing a plan price in Stripe',
    env: { STRIPE_PRICE_PER_ACCEPTED: '' },
    message: /STRIPE_PRICE_PER_ACCEPTED/,
  },
  {
    name: 'missing OpenAI credentials',
    env: { OPENAI_API_KEY: '' },
    message: /selected production AI provider/,
  },
  {
    name: 'missing Anthropic model',
    env: { AI_PROVIDER: 'anthropic', ANTHROPIC_MODEL: '' },
    message: /selected production AI provider/,
  },
  {
    name: 'insecure application origin',
    env: { APP_ORIGIN: 'http://app.example.test' },
    message: /explicit HTTPS/,
  },
  {
    name: 'a missing Turnstile secret',
    env: { TURNSTILE_SECRET_KEY: '' },
    message: /Set TURNSTILE_SECRET_KEY explicitly/,
  },
  {
    name: 'a Cloudflare test Turnstile secret in production',
    env: { ...production, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    message: /real Turnstile secret/,
  },
  {
    name: 'production without error reporting',
    env: { ...production, SENTRY_DSN: '' },
    message: /SENTRY_DSN/,
  },
  {
    name: 'missing support identity',
    env: { SUPPORT_EMAIL: '', OPERATOR_NAME: '' },
    message: /SUPPORT_EMAIL, OPERATOR_NAME/,
  },
  {
    name: 'missing legal details',
    env: { OPERATOR_ADDRESS: '', GOVERNING_LAW: '' },
    message: /OPERATOR_ADDRESS and GOVERNING_LAW/,
  },
];
for (const scenario of rejected) {
  test(`deployed server rejects ${scenario.name}`, () => {
    const result = inspect(scenario.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.message);
    assert.ok(!result.stderr.includes('Unexpected network request'));
  });
}
