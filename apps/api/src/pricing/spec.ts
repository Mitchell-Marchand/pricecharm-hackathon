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
  /**
   * Where the job is: a ZIP or postcode, a town or a neighborhood, as the customer said it. Never
   * a street address, which stays with the chat for the owner (lead_chats.job_address). Older
   * specs don't have it.
   */
  location?: string;
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
  location: phrase(80).default(''),
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
    ...(spec.location ? { location: spec.location } : {}),
  };
}

/**
 * Where a job is, as far as anything shared between businesses keeps it: the town or
 * neighborhood, or a ZIP's first three digits, a postcode's first part. Nothing finer.
 */
export function pooledLocation(location: string | undefined): string {
  const value = (location ?? '').trim();
  if (!value) return '';
  const zip = /\b(\d{3})\d{2}(?:-\d{4})?\b/.exec(value);
  if (zip) return `${zip[1]}xx`;
  const postcode = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i.exec(value);
  if (postcode) return postcode[1].toUpperCase();
  // A street number means more than an area was given: keep nothing.
  return /\d/.test(value) ? '' : value.slice(0, 60);
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

/** The job's fields, then what was measured and seen in the customer's video and photos. */
export function describeJob(spec: JobSpec | null, media: string[] = []): string {
  return [describeSpec(spec), ...media].filter(Boolean).join('. ');
}

/** "600 sq ft; heavy moss; steep driveway; adds: gutter brightening; wants it next week" */
/**
 * What a quote's price is for, as the customer would say it: the size, the condition, getting to
 * it, what they added and when. Shown on the quote, so both sides know what it holds for.
 */
export function jobFacts(spec: JobSpec | null): string[] {
  if (!spec) return [];
  const upper = (text: string) => text.trim().replace(/^./, (first) => first.toUpperCase());
  return [
    spec.quantity && spec.unit ? formatQuantity(spec.quantity, spec.unit) : '',
    spec.condition,
    spec.access,
    ...spec.extras,
    spec.timing,
  ]
    .filter((fact) => fact.trim())
    .map(upper);
}

export function describeSpec(spec: JobSpec | null): string {
  if (!spec) return '';
  return [
    spec.quantity && spec.unit ? formatQuantity(spec.quantity, spec.unit) : '',
    spec.condition,
    spec.access,
    spec.extras.length ? `adds: ${spec.extras.join(', ')}` : '',
    spec.timing ? `wants it ${spec.timing.replace(/^wants it\s+/i, '')}` : '',
    spec.location ? `in ${spec.location.replace(/^in\s+/i, '')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}
