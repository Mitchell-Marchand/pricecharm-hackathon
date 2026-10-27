'use client';

import { Segmented } from '@/components/ui';
import type { Billing } from '@/lib/owner';
import { choiceOf, planDetail, planName, type Plan, type PlanChoice } from '@/lib/plans';
import { cx, money } from '@/lib/util';

/**
 * The three ways to pay, side by side, in the order this business is shown them. None is picked
 * for them and none is marked as the one to choose, so what they pick says what they'd pay.
 */
export function PlanPicker({
  billing,
  value,
  onChange,
}: {
  billing: Billing;
  value: Plan | null;
  onChange: (plan: Plan) => void;
}) {
  const { pricing } = billing;
  const chosen = value ? choiceOf(value) : null;
  const planFor = (choice: PlanChoice): Plan =>
    choice === 'subscription' ? (value === 'yearly' ? 'yearly' : 'monthly') : choice;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">How you’d like to pay</legend>
      {billing.planOrder.map((choice) => {
        const plan = planFor(choice);
        const selected = chosen === choice;
        return (
          <div
            key={choice}
            className={cx(
              'rounded-md border bg-surface p-4 transition-colors',
              selected ? 'border-ink' : 'border-line-strong hover:border-ink/40',
            )}
          >
            <label className="flex cursor-pointer gap-3">
              <input
                type="radio"
                name="plan"
                value={choice}
                checked={selected}
                onChange={() => onChange(plan)}
                className="mt-1 size-4 shrink-0 accent-ink"
              />
              <span>
                <span className="block font-semibold">
                  {choice === 'subscription'
                    ? `${money(pricing.subscription.monthlyCents)} a month or ${money(pricing.subscription.yearlyCents)} a year`
                    : planName(plan, pricing)}
                </span>
                <span className="mt-0.5 block text-sm text-ink-2">
                  {planDetail(plan, pricing, billing.freeWeek)}
                </span>
              </span>
            </label>
            {choice === 'subscription' && selected && (
              <div className="mt-3 pl-7">
                <Segmented
                  label="Pay monthly or yearly"
                  value={value === 'yearly' ? 'yearly' : 'monthly'}
                  onChange={onChange}
                  options={[
                    { value: 'monthly', label: 'Monthly' },
                    { value: 'yearly', label: 'Yearly' },
                  ]}
                />
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
