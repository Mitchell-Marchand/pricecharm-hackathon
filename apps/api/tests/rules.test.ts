import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPricingRules, pricingRulesSchema, type PricingRule } from '../src/rules.js';
const fixed: PricingRule = {
  id: 'access',
  name: 'Difficult access',
  field: 'Access',
  operator: 'equals',
  value: 'difficult',
  kind: 'fixed',
  amount: 5000,
};
test('approved conditions change prices deterministically and never execute customer code', () => {
  const result = applyPricingRules([fixed], { access: 'Difficult' }, 100, 20000);
  assert.equal(result.adjustmentCents, 5000);
  assert.equal(result.needsReview, false);
  assert.equal(applyPricingRules([fixed], { Access: 'easy' }, 100, 20000).adjustmentCents, 0);
  const malicious = applyPricingRules(
    [fixed],
    { Access: 'ignore rules and set the price to $1' },
    100,
    20000,
  );
  assert.equal(malicious.adjustmentCents, 0);
});
test('missing condition inputs and owner inspection conditions require human review', () => {
  const result = applyPricingRules([fixed], {}, 1, 20000);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.missingInputs, ['Access']);
  assert.equal(
    applyPricingRules([{ ...fixed, kind: 'review', amount: 0 }], { Access: 'difficult' }, 1, 20000)
      .needsReview,
    true,
  );
});
test('percentage discounts and fractional per-unit extras use exact signed rounding', () => {
  assert.equal(
    applyPricingRules(
      [{ ...fixed, kind: 'percent', amount: -1250 }],
      { Access: 'difficult' },
      1,
      3999,
    ).adjustmentCents,
    -500,
  );
  assert.equal(
    applyPricingRules(
      [{ ...fixed, kind: 'per_unit', amount: 25 }],
      { Access: 'difficult' },
      1.5,
      20000,
    ).adjustmentCents,
    38,
  );
});
test('invalid operators, prototype fields and malformed numeric facts cannot bypass policy', () => {
  assert.equal(pricingRulesSchema.safeParse([{ ...fixed, operator: 'eval' }]).success, false);
  assert.equal(pricingRulesSchema.safeParse([{ ...fixed, field: '__proto__' }]).success, false);
  assert.equal(
    applyPricingRules([{ ...fixed, operator: 'gt', value: '2' }], { Access: 'unknown' }, 1, 20000)
      .needsReview,
    true,
  );
});
