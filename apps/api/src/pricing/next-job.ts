import { priceJob, type JobParts, type PriceFormula } from './formula.js';
import { roundSize } from './units.js';

/**
 * Which everyday job would teach the Charm the most. It already prices a job three ways, from three
 * readings of the owner's quotes. Where those agree there's little left to learn, and where they
 * disagree the owner's next quote settles something. So it's a normal job that comes in all the
 * time, picked because the Charm doesn't know its price yet. This is plain math, so looking at many
 * jobs costs nothing. On the benchmark, odd jobs at twice or half any priced size taught less than
 * everyday ones (src/practice/plan.ts), so the jobs looked at are always everyday ones.
 */

/** How far apart the readings are on a job. 1 when one can price it and another can't. */
export function disagreement(readings: PriceFormula[], parts: JobParts) {
  const totals = readings.map((formula) => priceJob(formula, parts)?.totalCents ?? null);
  const priced = totals.filter((total): total is number => total !== null);
  if (!priced.length) return 1;
  if (priced.length < totals.length) return 1;
  const lowest = Math.min(...priced);
  return lowest ? (Math.max(...priced) - lowest) / lowest : 0;
}

/**
 * The `count` jobs most worth asking about, most unsure first. Jobs with the same mix of work count
 * once until every mix has had a turn, so a run of customers doesn't ask the same thing again.
 */
export function mostUnsure<Job>(
  jobs: { job: Job; score: number; kind: string }[],
  count: number,
): Job[] {
  const ranked = [...jobs].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const first = ranked.filter((item) => !seen.has(item.kind) && seen.add(item.kind));
  const rest = ranked.filter((item) => !first.includes(item));
  return [...first, ...rest].slice(0, count).map((item) => item.job);
}

/** How many everyday jobs are looked at. It's only math, so plenty. */
const LOOK_AT = 60;
/** Readings this close have nothing left to settle: the job is an ordinary one, drawn at random. */
const SETTLED = 0.03;

export type TradeExtra = { label: string; services?: string[] };

export type PickedJob = {
  parts: JobParts;
  /** What the trade usually charges for that none of the owner's quotes shows, if that's why. */
  newThing: string;
  /** What's in it, so a run of customers doesn't ask the same thing again. */
  kind: string;
};

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 4)
    .map((word) => word.slice(0, 4));

/** Whether the formula already prices something by about this name. */
function priced(formula: PriceFormula, label: string) {
  const wanted = wordsOf(label);
  const names = [
    ...formula.surcharges.flatMap((item) => [item.name, item.when]),
    ...formula.addOns.map((item) => item.name),
  ].flatMap(wordsOf);
  return wanted.some((word) => names.includes(word));
}

/** The sizes this owner has priced a service at, from the formula and their quotes. */
function sizesOf(formula: PriceFormula, examples: (JobParts | null)[], service: string) {
  const same = (name: string) => name.toLowerCase() === service.toLowerCase();
  return [
    ...(formula.services.find((item) => same(item.name))?.points ?? []).map((point) => point.size),
    ...examples.flatMap((example) => [
      ...(example && same(example.service) && example.size ? [example.size] : []),
      ...(example?.otherServices ?? []).flatMap((other) =>
        same(other.name) && other.size ? [other.size] : [],
      ),
    ]),
  ];
}

/**
 * The job the next practice customer should bring, or null if there's nothing left to settle. It's
 * drawn the way everyday customers are: mostly the main service, at sizes this owner really does,
 * now and then with an extra, a condition or a second service. So it reads like any other
 * customer, and it's the one that teaches the most. On the benchmark (blind seed 25, 12 chats, no
 * past jobs) six of these in place of six everyday customers took the owner's price within 10%
 * from 78.8% to 84.4% of new jobs, and firm quotes from 68% to 78%, fixing 16 jobs and breaking 7.
 */
export function pickJob(input: {
  /** The owner's formula, read each of the ways the Charm reads their quotes. */
  readings: PriceFormula[];
  examples: (JobParts | null)[];
  /** What this trade usually charges extra for, leaving out what the owner was already asked. */
  extras: TradeExtra[];
  /** Kinds of job earlier customers already asked about. */
  used: string[];
  random?: () => number;
}): PickedJob | null {
  const [formula] = input.readings;
  const random = input.random ?? Math.random;
  const chance = (share: number) => random() < share;
  const pickFrom = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  /** Up to `count` of these, each one once. */
  const some = <T>(items: T[], count: number) => {
    const left = [...items];
    return Array.from(
      { length: Math.min(count, left.length) },
      () => left.splice(Math.floor(random() * left.length), 1)[0],
    );
  };
  const sizes = (service: string) => sizesOf(formula, input.examples, service);
  const services = formula.services.filter((service) => sizes(service.name).length);
  if (!services.length) return null;
  const sizeFor = (service: string) => {
    const known = sizes(service);
    const [low, high] = [Math.min(...known), Math.max(...known)];
    return roundSize(low + random() * (high - low));
  };
  const unpriced = input.extras.filter((extra) => !priced(formula, extra.label));
  const jobs = Array.from({ length: LOOK_AT }, () => {
    const [main, ...others] = services;
    const service = others.length && chance(0.3) ? pickFrom(others) : main;
    const also = others.length && chance(0.15) ? pickFrom(services) : null;
    const open = unpriced.filter(
      (extra) =>
        !extra.services ||
        extra.services.some((name) => name.toLowerCase() === service.name.toLowerCase()),
    );
    const newThing = open.length && chance(0.3) ? pickFrom(open).label : '';
    const parts: JobParts = {
      service: service.name,
      size: sizeFor(service.name),
      surcharges: some(
        formula.surcharges.map((item) => item.name),
        chance(0.35) ? 1 : 0,
      ),
      // One or two extras now and then, as real customers ask for, never the whole list.
      addOns: some(
        formula.addOns.filter((item) => !item.always),
        chance(0.4) ? (chance(0.5) ? 1 : 2) : 0,
      ).map((item) => ({
        name: item.name,
        count: item.per === 'item' ? 1 + Math.floor(random() * 3) : null,
      })),
      otherServices:
        also && also.name !== service.name && !newThing
          ? [{ name: also.name, size: sizeFor(also.name) }]
          : [],
    };
    const kind = [
      parts.service,
      ...parts.surcharges,
      ...parts.addOns.map((item) => item.name),
      ...parts.otherServices.map((item) => item.name),
      newThing,
    ]
      .filter(Boolean)
      .sort()
      .join('+');
    return { parts, newThing, kind, score: newThing ? 2 : disagreement(input.readings, parts) };
  });
  // Turn about between what its readings disagree on and what no quote has shown, so a list of
  // the trade's extras never crowds out the everyday jobs the benchmark found teach the most.
  const turn = input.used.length % 2 === 1;
  const fresh = jobs.filter((job) => !input.used.includes(job.kind) && (!turn || !job.newThing));
  const [best] = mostUnsure(
    fresh.map((job) => ({ job, score: job.score, kind: job.kind })),
    1,
  );
  if (!best || best.score < SETTLED) return null;
  return { parts: best.parts, newThing: best.newThing, kind: best.kind };
}
