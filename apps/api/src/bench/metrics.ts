import { gapPercent } from '../practice/types.js';
import { ONE_TIME, type SimJob, type SimOwner } from './owners.js';
import { seeded } from './random.js';

/**
 * How the benchmark measures prices against the owners'. Every report and comparison uses these,
 * so a number means the same thing everywhere:
 * - within 10% and 15%: the share of jobs whose price, rounded to a whole percent off, is that close;
 * - median, mean and 90th-percentile miss: how far off, in percent of the owner's price;
 * - high: the share priced above the owner, and bias, the average signed miss;
 * - a job with no price counts as a miss of 100%.
 */

export type Priced = { cents: number | null | undefined; ownerCents: number };

const missOf = ({ cents, ownerCents }: Priced) =>
  cents ? (Math.abs(cents - ownerCents) / ownerCents) * 100 : 100;
const withinOf = ({ cents, ownerCents }: Priced, limit: number) =>
  Boolean(cents) && (gapPercent(cents!, ownerCents) ?? Infinity) <= limit;

function quantile(sorted: number[], share: number) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * share;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

export type Closeness = {
  jobs: number;
  within10: number;
  within15: number;
  median: number;
  mean: number;
  p90: number;
  high: number;
  bias: number;
  worst: number;
};

/** Every measure of how close the prices came, for one set of jobs. */
export function closeness(items: Priced[]): Closeness {
  const misses = items.map(missOf).sort((a, b) => a - b);
  const priced = items.filter((item) => item.cents);
  const signed = priced.map((item) => ((item.cents! - item.ownerCents) / item.ownerCents) * 100);
  const jobs = items.length || 1;
  return {
    jobs: items.length,
    within10: items.filter((item) => withinOf(item, 10)).length / jobs,
    within15: items.filter((item) => withinOf(item, 15)).length / jobs,
    median: quantile(misses, 0.5),
    mean: misses.reduce((sum, miss) => sum + miss, 0) / jobs,
    p90: quantile(misses, 0.9),
    high: priced.filter((item) => item.cents! > item.ownerCents).length / (priced.length || 1),
    bias: signed.reduce((sum, miss) => sum + miss, 0) / (signed.length || 1),
    worst: misses.at(-1) ?? 0,
  };
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;
const points = (value: number) => `${Math.round(value * 10) / 10}%`;

/** One line of every measure, the way reports print it. */
export function describeCloseness(label: string, items: Priced[], range?: string) {
  const c = closeness(items);
  return `  ${label} (${c.jobs} jobs): within 10% ${pct(c.within10)}${range ?? ''}, within 15% ${pct(c.within15)}, miss median ${points(c.median)} / mean ${points(c.mean)} / 90th ${points(c.p90)}, ${pct(c.high)} priced high, bias ${c.bias >= 0 ? '+' : ''}${points(c.bias)}, worst ${points(c.worst)}`;
}

/**
 * The range a measure would likely fall in on other owners: owners are drawn again with
 * replacement, many times, keeping each owner's jobs together, since one owner's jobs move together.
 */
export function ownerInterval<T>(
  items: T[],
  ownerOf: (item: T) => string,
  measure: (items: T[]) => number,
  draws = 2000,
  level = 0.95,
) {
  const byOwner = new Map<string, T[]>();
  for (const item of items)
    byOwner.set(ownerOf(item), [...(byOwner.get(ownerOf(item)) ?? []), item]);
  const groups = [...byOwner.values()];
  const random = seeded(groups.length * 7919 + items.length);
  const values: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    const sample: T[] = [];
    for (let n = 0; n < groups.length; n++)
      sample.push(...groups[Math.floor(random() * groups.length)]);
    values.push(measure(sample));
  }
  values.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { low: quantile(values, tail), high: quantile(values, 1 - tail) };
}

/** How the owner prices a service, as reports group it. */
export function pricingShape(owner: SimOwner, service: string) {
  const rule = owner.rules.services.find((item) => item.name === service);
  if (rule?.hourly) return 'By the hour';
  if (rule?.bands) return 'Size bands';
  if (rule?.volume) return 'Cheaper per unit on big jobs';
  if (rule?.extra) return 'Two counts';
  if (rule?.options) return 'By what the customer picks';
  return 'One rate';
}

/**
 * What a job's price depends on that the owner's own examples never showed, judged from the
 * owner's hidden rules. Empty when everything it needed was there to learn, so a miss on it is the
 * pricing's own; otherwise the reasons, so a miss on it is one no pricing could be sure of without
 * asking. Only the benchmark can know this; it's how its reports separate the two.
 */
export function informationGaps(owner: SimOwner, examples: SimJob[], job: SimJob): string[] {
  const rules = owner.rules;
  const rule = rules.services.find((item) => item.name === job.service)!;
  const gaps: string[] = [];
  const sizesOf = (service: string) =>
    examples.flatMap((example) => [
      ...(example.service === service ? [example.quantity] : []),
      ...(example.second?.service === service ? [example.second.quantity] : []),
    ]);
  const bandOf = (bands: { upTo: number }[], size: number) => {
    const at = bands.findIndex((band) => size <= band.upTo);
    return at === -1 ? bands.length - 1 : at;
  };
  const sizeGaps = (service: string, size: number, prefix: string) => {
    const other = rules.services.find((item) => item.name === service)!;
    const sizes = sizesOf(service);
    if (!sizes.length) return [`${prefix}never priced`];
    const found: string[] = [];
    if (size < Math.min(...sizes)) found.push(`${prefix}smaller than any priced`);
    if (size > Math.max(...sizes)) found.push(`${prefix}bigger than any priced`);
    if (sizes.length <= 2) found.push(`${prefix}priced only once or twice`);
    if (other.bands) {
      const band = bandOf(other.bands, size);
      const priced = sizes.map((item) => bandOf(other.bands!, item));
      if (!priced.includes(band)) found.push(`${prefix}size band never priced`);
      // Between the nearest sizes priced on either side, in different bands: where the price
      // steps up can't be told from what was priced.
      const below = sizes.filter((item) => item < size).sort((a, b) => b - a)[0];
      const above = sizes.filter((item) => item > size).sort((a, b) => a - b)[0];
      if (
        below !== undefined &&
        above !== undefined &&
        bandOf(other.bands, below) !== bandOf(other.bands, above) &&
        !sizes.includes(size)
      )
        found.push(`${prefix}between sizes priced across a price step`);
    }
    return found;
  };
  gaps.push(...sizeGaps(job.service, job.quantity, ''));
  if (job.second)
    gaps.push(...sizeGaps(job.second.service, job.second.quantity, 'second service '));
  if (job.frequency && rules.recurring) {
    const share = rules.recurring.find((item) => item.label === job.frequency)?.share ?? 0;
    const usual = job.frequency === (rules.usually ?? ONE_TIME);
    if (share !== 0 && !usual && !examples.some((example) => example.frequency === job.frequency))
      gaps.push('visit frequency never quoted');
  }
  if (job.option && rule.options) {
    const share = rule.options.find((item) => item.label === job.option)?.share ?? 1;
    if (share !== 1 && !examples.some((example) => example.option === job.option))
      gaps.push('customer’s choice never quoted');
  }
  if (
    job.heavy &&
    (rules.heavy > 0 || rules.heavyFlat) &&
    !examples.some((example) => example.heavy)
  )
    gaps.push('condition never quoted');
  const reach = (example: SimJob) =>
    example.twoStory && rules.services.find((item) => item.name === example.service)?.height;
  if (
    job.twoStory &&
    rule.height &&
    (rules.height > 0 || rules.heightFlat) &&
    !examples.some(reach)
  )
    gaps.push('harder access never quoted');
  for (const addOn of job.addOns)
    if (!examples.some((example) => example.addOns.some((item) => item.label === addOn.label)))
      gaps.push('add-on never quoted');
  if (job.extra && rule.extra) {
    const counts = examples.flatMap((example) =>
      example.service === job.service && example.extra ? [example.extra] : [],
    );
    if (!counts.length || job.extra < Math.min(...counts) || job.extra > Math.max(...counts))
      gaps.push('second count outside the counts quoted');
  }
  return gaps;
}

/** Whether a measure moved past what chance alone would do, from a paired owner-resampled range. */
export function pairedInterval<T>(
  items: T[],
  ownerOf: (item: T) => string,
  before: (items: T[]) => number,
  after: (items: T[]) => number,
) {
  return ownerInterval(items, ownerOf, (sample) => after(sample) - before(sample));
}

export const asPercent = pct;
export const asPoints = points;
