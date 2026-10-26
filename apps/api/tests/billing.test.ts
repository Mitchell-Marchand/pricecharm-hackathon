import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billingReadiness, calculatePlatformFeeCents } from '../src/integrations/billing.js';

test('percentage fee calculation rounds integer cents and enforces a cap without float precision loss', () => {
  assert.equal(calculatePlatformFeeCents(199, 150), 3);
  assert.equal(calculatePlatformFeeCents(100000, 100, 500), 500);
  assert.equal(calculatePlatformFeeCents(Number.MAX_SAFE_INTEGER, 10000), Number.MAX_SAFE_INTEGER);
  assert.equal(calculatePlatformFeeCents(0, 100), 0);
});

test('invalid monetary values and invalid percentage rates are rejected', () => {
  for (const value of [-1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => calculatePlatformFeeCents(value, 100));
  for (const basisPoints of [-1, 10001, 1.5, NaN])
    assert.throws(() => calculatePlatformFeeCents(1000, basisPoints));
  assert.throws(() => calculatePlatformFeeCents(1000, 100, -1));
});

test('local billing readiness never enables real payment collection', () => {
  process.env.BILLING_PROVIDER = 'local';
  assert.equal(billingReadiness().collectionEnabled, false);
  assert.equal(billingReadiness().mode, 'local');
});
