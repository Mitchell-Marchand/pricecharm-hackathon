import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const base: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'production',
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
  STRIPE_PRICE_ID: 'price_config_only',
  STRIPE_METER_EVENT_NAME: 'quotient_fee_cents',
  SUPPORT_EMAIL: 'support@example.test',
  OPERATOR_NAME: 'Configuration test operator',
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

for (const provider of ['openai', 'anthropic']) {
  test(`fully configured production initializes with ${provider} without any network action`, () => {
    const result = inspect({ AI_PROVIDER: provider });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'CONFIG_OK');
  });
}
const rejected: { name: string; env: NodeJS.ProcessEnv; message: RegExp }[] = [
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
    message: /Production requires Stripe/,
  },
  {
    name: 'missing Stripe meter',
    env: { STRIPE_METER_EVENT_NAME: '' },
    message: /Production requires Stripe/,
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
    name: 'missing support identity',
    env: { SUPPORT_EMAIL: '', OPERATOR_NAME: '' },
    message: /SUPPORT_EMAIL and OPERATOR_NAME/,
  },
];
for (const scenario of rejected) {
  test(`production rejects ${scenario.name}`, () => {
    const result = inspect(scenario.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.message);
    assert.ok(!result.stderr.includes('Unexpected network request'));
  });
}
