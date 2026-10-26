import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPricingRules, type PricingRule } from '../src/rules.js';

test('clear yes/no answers apply boolean-priced extras consistently without interpreting numeric or descriptive answers', () => {
  const screens: PricingRule = {
    id: 'screens',
    name: 'Clean window screens',
    field: 'screens present',
    operator: 'equals',
    value: 'true',
    kind: 'per_unit',
    amount: 300,
  };
  for (const answer of ['yes', 'YES', 'true'])
    assert.equal(
      applyPricingRules([screens], { 'screens present': answer }, 10, 9000).adjustmentCents,
      3000,
    );
  for (const answer of ['no', 'false', '0', '1', 'no screens', 'unknown'])
    assert.equal(
      applyPricingRules([screens], { 'screens present': answer }, 10, 9000).adjustmentCents,
      0,
    );
  const review: PricingRule = {
    ...screens,
    id: 'no-access',
    field: 'access confirmed',
    value: 'false',
    kind: 'review',
    amount: 0,
  };
  assert.equal(
    applyPricingRules([review], { 'access confirmed': 'no' }, 1, 9000).needsReview,
    true,
  );
  assert.equal(
    applyPricingRules([review], { 'access confirmed': 'yes' }, 1, 9000).needsReview,
    false,
  );
  const contains: PricingRule = { ...screens, operator: 'contains', value: 'yes' };
  assert.equal(
    applyPricingRules([contains], { 'screens present': 'true' }, 10, 9000).adjustmentCents,
    0,
    'Text containment stays literal',
  );
});
