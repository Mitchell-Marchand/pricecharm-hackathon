'use client';
import { Plus, Trash2 } from 'lucide-react';
import type { PricingRule } from '@/lib/types';
import { Button, Field, Select } from './ui';

export function PricingRulesEditor({
  rules,
  onChange,
}: {
  rules: PricingRule[];
  onChange: (rules: PricingRule[]) => void;
}) {
  const update = (index: number, changes: Partial<PricingRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)));
  return (
    <section className="rules-editor">
      <div className="rules-heading">
        <div>
          <h3>The details that change the price.</h3>
          <p>Add extras, discounts, or a mandatory inspection when a customer detail matches.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([
              ...rules,
              {
                id: crypto.randomUUID(),
                name: '',
                field: '',
                operator: 'equals',
                value: '',
                kind: 'fixed',
                amount: 0,
              },
            ])
          }
        >
          <Plus size={14} /> Add rule
        </Button>
      </div>
      {rules.map((rule, index) => (
        <article className="rule-editor-row" key={rule.id}>
          <div className="rule-row-heading">
            <span>CONDITION {index + 1}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove pricing rule ${index + 1}`}
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <Field
            label="Adjustment name"
            required
            value={rule.name}
            onChange={(event) => update(index, { name: event.target.value })}
            placeholder="Heavy staining treatment"
          />
          <div className="form-grid">
            <Field
              label="Customer detail / field"
              required
              value={rule.field}
              onChange={(event) => update(index, { field: event.target.value })}
              placeholder="condition"
            />
            <Select
              label="When it"
              value={rule.operator}
              onChange={(event) =>
                update(index, { operator: event.target.value as PricingRule['operator'] })
              }
            >
              <option value="equals">equals</option>
              <option value="not_equals">does not equal</option>
              <option value="contains">contains</option>
              <option value="gt">is greater than</option>
              <option value="gte">is at least</option>
              <option value="lt">is less than</option>
              <option value="lte">is at most</option>
            </Select>
          </div>
          <Field
            label="Comparison value"
            required
            value={rule.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder="heavy staining"
          />
          <div className="form-grid">
            <Select
              label="Then apply"
              value={rule.kind}
              onChange={(event) =>
                update(index, { kind: event.target.value as PricingRule['kind'], amount: 0 })
              }
            >
              <option value="fixed">Fixed amount ($)</option>
              <option value="per_unit">Extra per unit ($)</option>
              <option value="percent">Percentage adjustment (%)</option>
              <option value="review">Require owner review</option>
            </Select>
            {rule.kind !== 'review' && (
              <Field
                label={rule.kind === 'percent' ? 'Percentage (+ / −)' : 'Amount in dollars (+ / −)'}
                type="number"
                step="0.01"
                value={rule.amount / 100}
                onChange={(event) =>
                  update(index, { amount: Math.round(Number(event.target.value) * 100) })
                }
                required
                hint="Use a negative amount for a discount."
              />
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
