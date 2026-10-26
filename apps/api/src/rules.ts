import { z } from 'zod';

const safeField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()),
    'Choose a different field name.',
  );
export const pricingRuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(160),
    field: safeField,
    operator: z.enum(['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte']),
    value: z.string().trim().min(1).max(300),
    kind: z.enum(['fixed', 'per_unit', 'percent', 'review']),
    amount: z.number().int().min(-100_000_000).max(100_000_000),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.kind === 'percent' && (rule.amount < -10000 || rule.amount > 100000))
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message:
          'Percentage adjustment must be between -100% and 1000%, expressed as basis points.',
      });
    if (rule.kind === 'review' && rule.amount !== 0)
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Review conditions have no price adjustment.',
      });
    if (['gt', 'gte', 'lt', 'lte'].includes(rule.operator) && !Number.isFinite(Number(rule.value)))
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Numeric comparisons need a numeric value.',
      });
  });
export const pricingRulesSchema = z
  .array(pricingRuleSchema)
  .max(30)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    'Rule identifiers must be unique.',
  );
export type PricingRule = z.infer<typeof pricingRuleSchema>;
export const pricingInputsSchema = z
  .record(safeField, z.string().trim().max(2000))
  .refine(
    (value) => Object.keys(value).length <= 40,
    'Provide no more than forty project details.',
  );
function normalized(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
function booleanAnswer(value: string) {
  const answer = normalized(value);
  return answer === 'yes' ? 'true' : answer === 'no' ? 'false' : answer;
}
function divideRounded(value: bigint, divisor: bigint) {
  const sign = value < 0n ? -1n : 1n;
  return sign * ((value * sign + divisor / 2n) / divisor);
}
export function applyPricingRules(
  rules: PricingRule[] | undefined,
  inputs: Record<string, string>,
  quantity: number,
  subtotalCents: number,
) {
  const parsed = pricingRulesSchema.parse(rules ?? []);
  const facts = new Map(
    Object.entries(pricingInputsSchema.parse(inputs)).map(([key, value]) => [
      normalized(key),
      value,
    ]),
  );
  const lineItems: {
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }[] = [];
  const reasons: string[] = [],
    missingInputs: string[] = [],
    matchedRules: string[] = [];
  for (const rule of parsed) {
    const supplied = facts.get(normalized(rule.field));
    if (!supplied?.trim()) {
      missingInputs.push(rule.field);
      reasons.push(`Confirm ${rule.field} before applying ${rule.name}.`);
      continue;
    }
    let matches = false;
    if (['gt', 'gte', 'lt', 'lte'].includes(rule.operator)) {
      const actual = Number(supplied),
        expected = Number(rule.value);
      if (!Number.isFinite(actual)) {
        missingInputs.push(rule.field);
        reasons.push(`${rule.field} must be numeric to evaluate ${rule.name}.`);
        continue;
      }
      matches =
        rule.operator === 'gt'
          ? actual > expected
          : rule.operator === 'gte'
            ? actual >= expected
            : rule.operator === 'lt'
              ? actual < expected
              : actual <= expected;
    } else {
      const booleanComparison =
        rule.operator !== 'contains' &&
        ['true', 'false', 'yes', 'no'].includes(normalized(rule.value));
      const actual = booleanComparison ? booleanAnswer(supplied) : normalized(supplied),
        expected = booleanComparison ? booleanAnswer(rule.value) : normalized(rule.value);
      matches =
        rule.operator === 'equals'
          ? actual === expected
          : rule.operator === 'not_equals'
            ? actual !== expected
            : actual.includes(expected);
    }
    if (!matches) continue;
    matchedRules.push(rule.id);
    if (rule.kind === 'review') {
      reasons.push(rule.name);
      continue;
    }
    const amount =
      rule.kind === 'percent'
        ? Number(divideRounded(BigInt(subtotalCents) * BigInt(rule.amount), 10000n))
        : rule.kind === 'per_unit'
          ? Number(divideRounded(BigInt(Math.round(quantity * 1000)) * BigInt(rule.amount), 1000n))
          : rule.amount;
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > 100_000_000)
      throw new RangeError('This adjustment needs a custom owner quote.');
    lineItems.push({
      description: rule.name,
      quantity: rule.kind === 'per_unit' ? quantity : 1,
      unitPriceCents: rule.kind === 'per_unit' ? rule.amount : amount,
      totalCents: amount,
    });
  }
  const adjustmentCents = lineItems.reduce((total, item) => total + item.totalCents, 0);
  if (!Number.isSafeInteger(adjustmentCents) || Math.abs(adjustmentCents) > 100_000_000)
    throw new RangeError('Combined adjustments exceed supported pricing.');
  return {
    lineItems,
    adjustmentCents,
    needsReview: reasons.length > 0,
    reasons,
    missingInputs: [...new Set(missingInputs)],
    matchedRules,
  };
}
