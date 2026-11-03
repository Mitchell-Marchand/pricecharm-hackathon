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

/**
 * Setup for an owner with no past jobs, where practice is all the Charm has to go on. Each
 * customer covers one more part of how they price: their rate on a usual job, their minimum, how
 * the price grows with size and what the trade's usual extra costs, each other service, two done
 * together, condition and access, then timing. The photos carry the job's size and condition, as
 * real customers' do.
 */
export function newOwnerSituations(services: string[]): string[] {
  const [main = 'main', ...others] = services;
  return [
    `A usual job for their "${main}" service, sized like the ones a business like theirs does most. Clear, easy to reach, no extras. The photos show how big it is.`,
    `A small "${main}" job, at the low end of what a business like theirs takes on. Nothing unusual.`,
    `A big "${main}" job, well above a usual one, plus the extra that businesses in their trade most often price separately, like screens with windows or sealing after a wash. Nothing else unusual.`,
    ...others
      .slice(0, 3)
      .map(
        (service) =>
          `A usual job for their "${service}" service, sized like the ones a business like theirs does most. Nothing unusual.`,
      ),
    ...(others.length
      ? [
          `A job that combines their "${main}" and "${others[0]}" services, where the customer asks whether doing both together saves anything.`,
        ]
      : []),
    `A usual-sized "${main}" job in rough shape, like heavy buildup or stains, that's also harder to reach than most, like a second story, if that matters for this work. The photos show both.`,
    `A usual "${main}" job where timing matters: if businesses in their trade do regular visits, the customer wants it on a regular schedule; otherwise they need it done this week.`,
  ];
}

export type PlanInput = {
  position: number;
  /** Customers in setup, which always follow SITUATIONS. */
  setupCount: number;
  /**
   * Past jobs the owner added before practice. With none, setup follows newOwnerSituations,
   * however long that runs for their services, instead of SITUATIONS.
   */
  pastJobs?: number;
  services: string[];
  /** How many examples each service has, by lowercase name. */
  examples: Record<string, number>;
  /** What earlier practice customers were planned to be. */
  asked: string[];
  /** Draws what each everyday customer asks for; Math.random unless a test sets it. */
  random?: () => number;
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
 * The next practice customer. Setup keeps its fixed mix so every owner starts with the same range,
 * then a service they've never priced, then everyday customers, drawn the way the benchmark's usual
 * customers are: the main service most of the time, any size they usually do, and now and then an
 * extra or two, bad shape, a hard-to-reach job, a second service or a regular schedule. On the
 * benchmark with five past jobs (blind seed 22, 2026-11-01), six of these after setup took the
 * owner's price within 10% from 65% to 78% of new jobs. Six aimed at what the owner hadn't shown,
 * sizes twice or half any priced and extras the trade usually charges for, reached only 74%: odd
 * jobs teach less than the ones that come in (aimedJob in src/bench/owners.ts).
 */
export function planSituation(input: PlanInput): string {
  if (input.pastJobs === 0) {
    const plan = newOwnerSituations(input.services);
    if (input.position < plan.length) return plan[input.position];
  } else if (input.position < input.setupCount)
    return SITUATIONS[input.position % SITUATIONS.length];

  for (const service of input.services) {
    if (input.examples[service.toLowerCase()]) continue;
    const plan = `A typical, clear job for their "${service}" service, sized like a usual job for it. They haven't priced this service here yet.`;
    if (!input.asked.includes(plan)) return plan;
  }

  const random = input.random ?? Math.random;
  const chance = (share: number) => random() < share;
  const [main, ...others] = input.services;
  const service =
    others.length && chance(0.3) ? others[Math.floor(random() * others.length)] : main;
  const extras = chance(0.4) ? (chance(0.5) ? 1 : 2) : 0;
  return [
    `An everyday customer for their "${service}" service, like the ones they get all the time, with a job ${['on the smaller side', 'in the middle', 'on the bigger side'][Math.floor(random() * 3)]} of their usual jobs for it.`,
    chance(0.35) ? 'It’s in rough shape, like heavy buildup or stains.' : 'It’s in normal shape.',
    chance(0.45)
      ? 'It’s harder to reach than most, like a second story, if that matters for this work.'
      : '',
    extras
      ? `They want ${extras === 1 ? 'one extra' : 'two extras'} their customers often add.`
      : 'No extras.',
    service === main && others.length && chance(0.25)
      ? 'They also want another of their services done in the same visit.'
      : '',
    chance(0.5)
      ? 'If businesses in their trade do regular visits, they want it on a regular schedule.'
      : '',
    'If the work comes in versions, like materials or grades, they pick the one that suits them.',
  ]
    .filter(Boolean)
    .join(' ');
}
