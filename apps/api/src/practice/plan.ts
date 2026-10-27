import type { PricePoint } from '../pricing/rates.js';
import { formatQuantity } from '../pricing/units.js';

/** Setup's customers cover a different kind of job each, so the AI sees the range. */
export const SITUATIONS = [
  'A typical, clear job for one of their main services, sized like their usual past jobs. Nothing unusual.',
  'A bigger job that combines two of their services or adds an extra, where the customer also asks about a discount, for example because a neighbor wants the same work.',
  'A trickier job: the photos and messages show something that could change the price a lot, like damage, hard access or unclear scope, so a careful owner might want to see it before pricing.',
  'A small job at the low end of what they do, from a customer in a hurry.',
  'A job near the edge of their service area, for a customer who wants it done soon.',
];

/** How the AI's private guess did on one finished practice customer. */
export type PracticeMiss = {
  service: string;
  situation: string;
  siteVisit: boolean;
  /** Percent between the AI's guess and the owner's quote, when both priced it. */
  gap: number | null;
  confidence: string | null;
};

export type PlanInput = {
  position: number;
  /** Customers in setup, which always follow SITUATIONS. */
  setupCount: number;
  services: string[];
  /** Every size and price the business has taught it. */
  points: PricePoint[];
  /** How many examples each service has, by lowercase name. */
  examples: Record<string, number>;
  /** Finished practice customers, oldest first. */
  finished: PracticeMiss[];
};

/** 2,350 becomes 2,400; 37 becomes 35. Sizes a customer would say. */
function roundSize(value: number) {
  const step = value >= 1000 ? 100 : value >= 100 ? 50 : value >= 10 ? 5 : 1;
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * The next practice customer, aimed where the AI knows least: a service it has never seen priced,
 * a job like one it just got wrong, then sizes outside what the owner has priced. Setup keeps its
 * fixed mix so every owner starts with the same range.
 */
export function planSituation(input: PlanInput): string {
  if (input.position < input.setupCount) return SITUATIONS[input.position % SITUATIONS.length];
  const used = new Set(input.finished.map((run) => run.situation));
  const fresh = (situation: string) => (used.has(situation) ? null : situation);

  for (const service of input.services) {
    if (input.examples[service.toLowerCase()]) continue;
    const plan = fresh(
      `A typical, clear job for their "${service}" service, sized like a usual job for it. They haven't priced this service here yet.`,
    );
    if (plan) return plan;
  }

  const last = input.finished.at(-1);
  if (
    last &&
    !last.situation.startsWith('Another') &&
    ((last.gap !== null && last.gap > 15) || last.confidence === 'low')
  )
    return `Another "${last.service}" job like the last one, but a different size, so the AI can see how they scale it.`;

  for (const service of input.services) {
    const sizes = input.points.filter(
      (point) => point.service.toLowerCase() === service.toLowerCase(),
    );
    if (!sizes.length) continue;
    const units = new Map<string, number>();
    for (const point of sizes) units.set(point.unit, (units.get(point.unit) ?? 0) + 1);
    const [unit] = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
    const quantities = sizes.filter((point) => point.unit === unit).map((point) => point.quantity);
    const largest = Math.max(...quantities),
      smallest = Math.min(...quantities);
    const bigger = fresh(
      `A bigger "${service}" job than they've priced so far, around ${formatQuantity(roundSize(largest * 2), unit)}.`,
    );
    if (bigger && !input.finished.some((run) => run.situation.startsWith(`A bigger "${service}"`)))
      return bigger;
    const smaller = fresh(
      `A small "${service}" job, around ${formatQuantity(roundSize(smallest / 2), unit)}, near the low end of what they'd take on.`,
    );
    if (
      smaller &&
      smallest / 2 >= 1 &&
      !input.finished.some((run) => run.situation.startsWith(`A small "${service}"`))
    )
      return smaller;
  }

  if (!input.finished.some((run) => run.siteVisit)) {
    const tricky = fresh(SITUATIONS[2]);
    if (tricky) return tricky;
  }
  return SITUATIONS[input.position % SITUATIONS.length];
}
