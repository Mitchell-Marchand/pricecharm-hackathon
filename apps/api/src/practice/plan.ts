import { median, SOLID_POINTS, type PricePoint } from '../pricing/rates.js';
import { formatQuantity, roundSize } from '../pricing/units.js';

/**
 * Setup's customers each change one thing from a plain job, so nothing hides anything else: an
 * extra, the other service, bad shape, a hard-to-reach job, the low end where a minimum shows,
 * then two services together. Jobs that show one extra or condition are big enough that a
 * minimum can't hide what it costs. On the simulated-owner benchmark (src/bench.ts) this plan,
 * with ten past jobs, gave back the owner's price within 10% on 92% of new jobs.
 */
export const SITUATIONS = [
  'A clear job for their main service, on the bigger side of their usual past jobs, plus one extra that businesses in their trade usually price separately, like screens with windows or sealing after a wash. Nothing else unusual.',
  'A job for a different one of their services than the main one, on the bigger side of a usual job for it, plus a different extra that’s usually priced separately. Nothing else unusual.',
  'A main-service job on the bigger side of their usual jobs that the photos and messages show is in bad shape, like heavy buildup or stains. Easy to reach, no extras. The customer is getting a few quotes and hopes for a price from the photos.',
  'A usual-sized job that’s harder to reach, like a second story, and otherwise clear: no buildup, no extras.',
  'A small job at the low end of what they do, from a customer in a hurry.',
  'A bigger job that combines two of their services and adds the first extra again, where the customer asks whether doing both together saves anything.',
];

/** How the AI's private guess did on one finished practice customer. */
export type PracticeMiss = {
  service: string;
  situation: string;
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

/** The unit a service is most often priced by, and the sizes priced in it. */
function pricedSizes(service: string, points: PricePoint[]) {
  const sizes = points.filter((point) => point.service.toLowerCase() === service.toLowerCase());
  if (!sizes.length) return null;
  const units = new Map<string, number>();
  for (const point of sizes) units.set(point.unit, (units.get(point.unit) ?? 0) + 1);
  const [unit] = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    unit,
    quantities: sizes.filter((point) => point.unit === unit).map((point) => point.quantity),
  };
}

/**
 * A practice customer for one service the owner picked, aimed at what it still needs before its
 * quotes can go out on their own: a first price, then sizes it hasn't seen, then usual jobs that
 * check its guesses against the owner's.
 */
export function focusSituation(service: string, points: PricePoint[]): string {
  const priced = pricedSizes(service, points);
  if (!priced)
    return `A typical, clear job for their "${service}" service, sized like a usual job for it. Nothing unusual.`;
  const { unit, quantities } = priced;
  if (quantities.length === 1)
    return `A "${service}" job a bit bigger than the one they've priced, around ${formatQuantity(roundSize(quantities[0] * 1.5), unit)}. Nothing else unusual.`;
  if (quantities.length < SOLID_POINTS)
    return `A smaller "${service}" job than they've priced so far, around ${formatQuantity(roundSize(Math.min(...quantities) * 0.6), unit)}. Nothing else unusual.`;
  return `A usual "${service}" job, around ${formatQuantity(roundSize(median(quantities)), unit)}. Nothing unusual.`;
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
    const priced = pricedSizes(service, input.points);
    if (!priced) continue;
    const { unit, quantities } = priced;
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

  return SITUATIONS[input.position % SITUATIONS.length];
}
