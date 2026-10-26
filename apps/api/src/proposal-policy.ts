import type { Service } from './domain.js';

type AppliedPolicy = Pick<
  Service,
  | 'unitLabel'
  | 'unitPriceCents'
  | 'basePriceCents'
  | 'minimumChargeCents'
  | 'requiredInputs'
  | 'exclusions'
  | 'pricingRules'
>;

/** Compare exactly the fields Apply persists, preserving visible question and rule order. */
export function sameAppliedPolicy(current: AppliedPolicy, next: AppliedPolicy): boolean {
  const snapshot = (policy: AppliedPolicy) => ({
    unitLabel: policy.unitLabel,
    unitPriceCents: policy.unitPriceCents,
    basePriceCents: policy.basePriceCents,
    minimumChargeCents: policy.minimumChargeCents,
    requiredInputs: policy.requiredInputs,
    exclusions: policy.exclusions,
    pricingRules: (policy.pricingRules || []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      kind: rule.kind,
      amount: rule.amount,
    })),
  });
  return JSON.stringify(snapshot(current)) === JSON.stringify(snapshot(next));
}
