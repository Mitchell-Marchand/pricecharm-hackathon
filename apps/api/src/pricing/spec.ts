import { z } from 'zod';
import type { PracticeScenario } from '../practice/types.js';
import { canonicalUnit, formatQuantity, parseQuantity } from './units.js';

/** What a job is, as fields: the size, and what else changes its price. Unknowns are empty. */
export type JobSpec = {
  quantity: number | null;
  unit: string;
  condition: string;
  access: string;
  extras: string[];
  timing: string;
};

export const emptySpec = (): JobSpec => ({
  quantity: null,
  unit: '',
  condition: '',
  access: '',
  extras: [],
  timing: '',
});

/** Lenient on purpose: a long phrase or an odd number shouldn't fail the customer's chat. */
const phrase = (max: number) => z.string().transform((value) => value.trim().slice(0, max));
export const specSchema = z.object({
  quantity: z.number().nullable(),
  unit: phrase(30),
  condition: phrase(200),
  access: phrase(200),
  extras: z.array(phrase(80)).transform((items) => items.filter(Boolean).slice(0, 8)),
  timing: phrase(80),
});

/** The intake model's spec, with its unit spelled the one way, and no unit without a size. */
export function cleanSpec(spec: z.infer<typeof specSchema>): JobSpec {
  const quantity =
    spec.quantity && spec.quantity > 0 && spec.quantity < 10_000_000 ? spec.quantity : null;
  return {
    quantity,
    unit: quantity ? (canonicalUnit(spec.unit) ?? spec.unit.toLowerCase().slice(0, 20)) : '',
    condition: spec.condition,
    access: spec.access,
    extras: spec.extras.map((item) => item.trim()).filter(Boolean),
    timing: spec.timing,
  };
}

/** Just the size, read from what someone wrote. */
export function specFromText(text: string): JobSpec {
  const size = parseQuantity(text);
  return { ...emptySpec(), quantity: size?.quantity ?? null, unit: size?.unit ?? '' };
}

/** A practice fact that holds the job's size, by its key: "size", "quantity", "area"... */
export const SIZE_FACT = /size|area|quantity|count|length|square|how_many/;

/** A practice customer's size: what the scenario says, or what their answer about size says. */
export function specFromScenario(scenario: PracticeScenario): JobSpec {
  if (scenario.quantity && scenario.unit) {
    const unit = canonicalUnit(scenario.unit) ?? scenario.unit;
    return { ...emptySpec(), quantity: scenario.quantity, unit };
  }
  const facts = scenario.facts ?? [];
  const sizeFirst = [...facts.filter((fact) => SIZE_FACT.test(fact.key)), ...facts];
  for (const fact of sizeFirst) {
    const size = parseQuantity(fact.answer);
    if (size) return { ...emptySpec(), quantity: size.quantity, unit: size.unit };
  }
  return emptySpec();
}

/** "600 sq ft; heavy moss; steep driveway; adds: gutter brightening; wants it next week" */
export function describeSpec(spec: JobSpec | null): string {
  if (!spec) return '';
  return [
    spec.quantity && spec.unit ? formatQuantity(spec.quantity, spec.unit) : '',
    spec.condition,
    spec.access,
    spec.extras.length ? `adds: ${spec.extras.join(', ')}` : '',
    spec.timing ? `wants it ${spec.timing.replace(/^wants it\s+/i, '')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}
