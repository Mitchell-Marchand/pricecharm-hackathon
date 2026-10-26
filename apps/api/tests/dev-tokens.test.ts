import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrationCredentials, devTokensAllowed, isDeployed } from '../src/config.js';

const names = [
  'APP_ENV',
  'APP_ORIGIN',
  'NODE_ENV',
  'EXPOSE_DEV_TOKENS',
  'DB_USER',
  'DB_PASS',
  'MIGRATION_DB_USER',
  'MIGRATION_DB_PASS',
];
function withEnv(env: Record<string, string | undefined>, check: () => void) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) process.env[name] = value;
  try {
    check();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
const from = (remoteAddress: string) => ({ socket: { remoteAddress } });
const local = { APP_ORIGIN: 'http://localhost:3100', NODE_ENV: 'development' };

test('email codes stay out of responses unless explicitly enabled', () => {
  withEnv(local, () => assert.equal(devTokensAllowed(from('127.0.0.1')), false));
});

test('email codes are only returned to requests from this machine', () => {
  withEnv({ ...local, EXPOSE_DEV_TOKENS: '1' }, () => {
    assert.equal(devTokensAllowed(from('127.0.0.1')), true);
    assert.equal(devTokensAllowed(from('::ffff:127.0.0.1')), true);
    assert.equal(devTokensAllowed(from('::1')), true);
    assert.equal(devTokensAllowed(from('203.0.113.9')), false);
    assert.equal(devTokensAllowed({ socket: {} }), false);
  });
});

test('email codes never come back from a deployed server', () => {
  withEnv({ ...local, EXPOSE_DEV_TOKENS: '1', APP_ORIGIN: 'https://app.example.test' }, () => {
    assert.equal(isDeployed(), true);
    assert.equal(devTokensAllowed(from('127.0.0.1')), false);
  });
  withEnv({ ...local, EXPOSE_DEV_TOKENS: '1', APP_ENV: 'staging' }, () => {
    assert.equal(devTokensAllowed(from('127.0.0.1')), false);
  });
});

test('a hostname that only looks like 127.x is not this machine', () => {
  withEnv({ ...local, EXPOSE_DEV_TOKENS: '1', APP_ORIGIN: 'https://127.example.test' }, () => {
    assert.equal(isDeployed(), true);
  });
});

test('migrations switch to their own database user', () => {
  withEnv(
    {
      ...local,
      DB_USER: 'app',
      DB_PASS: 'app-pass',
      MIGRATION_DB_USER: 'migrator',
      MIGRATION_DB_PASS: 'm-pass',
    },
    () => {
      applyMigrationCredentials();
      assert.equal(process.env.DB_USER, 'migrator');
      assert.equal(process.env.DB_PASS, 'm-pass');
    },
  );
});

test('deployed migrations require a separate user', () => {
  withEnv({ APP_ENV: 'production', APP_ORIGIN: 'https://app.example.test', DB_USER: 'app' }, () => {
    assert.throws(() => applyMigrationCredentials(), /MIGRATION_DB_USER/);
  });
  withEnv(
    {
      APP_ENV: 'production',
      APP_ORIGIN: 'https://app.example.test',
      DB_USER: 'app',
      MIGRATION_DB_USER: 'app',
    },
    () => assert.throws(() => applyMigrationCredentials(), /different user/),
  );
});
