import { formatNumber, formatQuantity } from './units.js';

/** One price the owner charged for a known size of one service. */
export type PricePoint = {
  service: string;
  quantity: number;
  unit: string;
  /** For quotes, the main work line. For past jobs, what the job came to before any discount. */
  cents: number;
  source: 'job' | 'practice' | 'quote';
};

/** How this owner prices one service by size, worked out from their own points. */
export type Rate = {
  service: string;
  unit: string;
  centsPerUnit: number;
  /** The lowest price they've charged for this service. Small jobs don't go under it. */
  floorCents: number;
  points: number;
  smallest: number;
  largest: number;
  /** Every price they've charged for it is their minimum, so there's no rate for it yet. */
  minimumOnly: boolean;
};

export type Estimate = {
  cents: number;
  quantity: number;
  unit: string;
  rate: Rate;
  /** Enough jobs, and a size close to ones they've done, to hold the AI to it. */
  solid: boolean;
};

/** Points to trust a rate, and how far outside the sizes they've done it still holds. */
export const SOLID_POINTS = 3;
const STRETCH = { below: 0.5, above: 1.5 };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A rate for each service and unit with at least one point. The least they charge for anything,
 * when two or more services were each charged it as their lowest, is their minimum: a job charged
 * it says nothing about a rate, so it's left out of the rate.
 */
export function fitRates(points: PricePoint[]): Rate[] {
  const groups = new Map<string, PricePoint[]>();
  for (const point of points) {
    if (!(point.quantity > 0) || !(point.cents > 0) || !point.service.trim()) continue;
    const key = `${point.service.trim().toLowerCase()}|${point.unit}`;
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  const all = [...groups.values()].flat();
  const lowest = all.length ? Math.min(...all.map((point) => point.cents)) : 0;
  const atLowest = new Set(
    all
      .filter((point) => point.cents === lowest)
      .map((point) => point.service.trim().toLowerCase()),
  );
  const minimum = atLowest.size >= 2 ? lowest : null;
  return [...groups.values()].map((group) => {
    const priced = group.filter((point) => minimum === null || point.cents > minimum);
    return {
      service: group[0].service.trim(),
      unit: group[0].unit,
      centsPerUnit: median(
        (priced.length ? priced : group).map((point) => point.cents / point.quantity),
      ),
      floorCents: Math.min(...group.map((point) => point.cents)),
      points: group.length,
      smallest: Math.min(...group.map((point) => point.quantity)),
      largest: Math.max(...group.map((point) => point.quantity)),
      minimumOnly: !priced.length,
    };
  });
}

/** The main work at this owner's usual rate, or null when they've never priced it by this unit. */
export function estimateFor(
  rates: Rate[],
  service: string,
  quantity: number | null,
  unit: string,
): Estimate | null {
  if (!quantity || quantity <= 0 || !unit) return null;
  const rate = rates.find((item) => same(item.service, service) && item.unit === unit);
  if (!rate) return null;
  // Charged only the minimum so far: that's the price up to those sizes, and past them it's unknown.
  if (rate.minimumOnly && quantity > rate.largest) return null;
  const cents = rate.minimumOnly
    ? rate.floorCents
    : Math.round(Math.max(rate.floorCents, rate.centsPerUnit * quantity) / 100) * 100;
  const sizes = sizeRange(rate);
  const solid = rate.points >= SOLID_POINTS && quantity >= sizes.from && quantity <= sizes.to;
  return { cents, quantity, unit, rate, solid };
}

/** The sizes a rate holds for: down to half its smallest job, up to half again its largest. */
export function sizeRange(rate: Rate): { from: number; to: number } {
  return { from: rate.smallest * STRETCH.below, to: rate.largest * STRETCH.above };
}

/** Why an estimate can't be held to: too few jobs, or a size far from the ones they've priced. */
export function estimateGap(estimate: Estimate): 'few' | 'bigger' | 'smaller' | null {
  if (estimate.solid) return null;
  if (estimate.rate.points < SOLID_POINTS) return 'few';
  return estimate.quantity > estimate.rate.largest ? 'bigger' : 'smaller';
}

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents < 1000 && cents % 100 ? 2 : 0,
    maximumFractionDigits: cents < 1000 ? 2 : 0,
  }).format(cents / 100);

/** "per window", "per sq ft" */
const perUnit = (unit: string) => `per ${unit.replace(/s$/, '') || unit}`;

/**
 * A rate in words: "about $0.46 per sq ft, lowest $250", for "500 to 1,200 sq ft". `floorCents`
 * is the least a job costs when something other than the rate decides it (the owner's formula),
 * or null when nothing holds small jobs up.
 */
export function rateWords(
  rate: Rate,
  floorCents: number | null = rate.points > 1 ? rate.floorCents : null,
): { price: string; sizes: string } {
  const floor = floorCents ? `, lowest ${dollars(floorCents)}` : '';
  return {
    price: rate.minimumOnly
      ? `only the minimum so far, ${dollars(rate.floorCents)}`
      : `about ${dollars(rate.centsPerUnit)} ${perUnit(rate.unit)}${floor}`,
    sizes:
      rate.smallest === rate.largest
        ? formatQuantity(rate.smallest, rate.unit)
        : `${formatNumber(rate.smallest)} to ${formatQuantity(rate.largest, rate.unit)}`,
  };
}

/** "Driveways: about $0.46 per sq ft, lowest $250 (3 prices, 500 to 1,200 sq ft)" */
export function describeRate(rate: Rate): string {
  const { price, sizes } = rateWords(rate);
  return `${rate.service}: ${price} (${rate.points} ${rate.points === 1 ? 'price' : 'prices'}, ${sizes})`;
}

/** One price as a rate, worked out here rather than by the AI: "Charges about $30 per window". */
export function chargesLine(cents: number, quantity: number, unit: string): string {
  return `Charges about ${dollars(cents / quantity)} ${perUnit(unit)}`;
}

/** Checks the AI's total against the estimate. Add-ons can take it up, not down. */
export function withinEstimate(totalCents: number, estimate: Estimate): boolean {
  return totalCents >= estimate.cents * 0.75 && totalCents <= estimate.cents * 1.75;
}
