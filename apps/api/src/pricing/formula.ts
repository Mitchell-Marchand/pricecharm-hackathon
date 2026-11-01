import { quoteTotal, type Discount } from '../practice/types.js';
import { formatQuantity } from './units.js';

/**
 * An owner's prices as a formula: a rate for each service (or the prices they charged at each
 * size, when big jobs don't scale evenly), what they add for things like a second story, their
 * add-ons, minimum, two-service discount and rounding. The AI works it out from the owner's own
 * quotes (src/ai/formula.ts); this file only does the arithmetic, so the same job always gets the
 * same price, and checks the formula against every quote it came from.
 */

export type FormulaService = {
  name: string;
  unit: string;
  /** Cents per unit of the main work. */
  rateCents: number | null;
  /** The main work's price at sizes the owner charged, when it doesn't scale evenly with size. */
  points: { size: number; cents: number }[];
  /**
   * How price follows size between those sizes: a straight line from one to the next, a set
   * price for each size band, or one straight line through all of them, for an owner who prices
   * by eye. Worked out from the points (priceShape); a line when it hasn't been.
   */
  shape?: PriceShape;
  /** No job of this service for less, when the owner has a minimum for it. */
  minimumCents: number | null;
  /**
   * A second count the price follows, like bathrooms next to bedrooms: cents for each one past
   * the ones the main price includes.
   */
  extra?: { unit: string; rateCents: number; included: number } | null;
};

export type PriceShape = 'line' | 'bands' | 'fit';

export type FormulaSurcharge = {
  name: string;
  /** When it applies, in the owner's terms: "heavy moss", "second story". */
  when: string;
  /**
   * Percent of the main work, or a flat amount. Below zero takes off, like a discount for regular
   * visits or a cheaper material.
   */
  percent: number | null;
  flatCents: number | null;
};

export type FormulaAddOn = {
  name: string;
  /** Per unit of the job's size, once per job, or per item counted (like each downspout). */
  per: 'unit' | 'job' | 'item';
  cents: number;
  /** On every job, whether the customer asks or not, like a trip charge. */
  always?: boolean;
  /**
   * For one priced by the size: the unit it was quoted in, and what it came to on the jobs it was
   * quoted on (the middle one), for a job measured some other way.
   */
  unit?: string;
  jobCents?: number;
};

export type PriceFormula = {
  services: FormulaService[];
  surcharges: FormulaSurcharge[];
  addOns: FormulaAddOn[];
  /** Percent off when a customer books two of the services together. */
  bundlePercent: number | null;
  /** Every amount the owner writes is a multiple of this. */
  roundToCents: number;
  /** No job for less, across services. */
  minimumCents: number | null;
  /** Surcharges on their own lines, or folded into the main work. */
  itemizes: boolean;
  /** Surcharges and add-ons whose price the owner's notes give, which their quotes don't change. */
  setByNotes?: string[];
};

/** What a job is in the formula's terms. Names match the formula's own. */
export type JobParts = {
  service: string;
  size: number | null;
  surcharges: string[];
  addOns: { name: string; count: number | null }[];
  otherServices: { name: string; size: number | null }[];
  /** The job's second count, for a service priced by one, like 2 bathrooms. */
  extraSize?: number | null;
};

/** One of the owner's quotes, as the formula is checked against it. */
export type FormulaCheck = {
  parts: JobParts;
  totalCents: number;
  /** The owner's own lines, when the quote has them. Past jobs only have a total. */
  lines?: { label: string; amountCents: number }[] | null;
};

export type FormulaQuote = {
  lines: { label: string; amountCents: number }[];
  discount: Discount | null;
  totalCents: number;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Point = { size: number; cents: number };

const sortedPoints = (points: Point[]) =>
  points.filter((point) => point.size > 0 && point.cents > 0).sort((a, b) => a.size - b.size);

/** The straight line closest to all the points (least squares). */
function straightLine(points: Point[]) {
  const meanSize = points.reduce((sum, point) => sum + point.size, 0) / points.length;
  const meanCents = points.reduce((sum, point) => sum + point.cents, 0) / points.length;
  const spread = points.reduce((sum, point) => sum + (point.size - meanSize) ** 2, 0);
  const slope = spread
    ? points.reduce((sum, point) => sum + (point.size - meanSize) * (point.cents - meanCents), 0) /
      spread
    : 0;
  return { slope, intercept: meanCents - slope * meanSize };
}

/** How far over straight scaling a job smaller than any they've priced can go. */
const SMALL_JOB_LEAN = 1.05;

/**
 * A job smaller than any they've priced, from the price at the smallest size. Small jobs cost more
 * per unit when part of the price is just turning up, so it follows the line through their prices
 * back, never under scaling straight down, and only a little over it: a line through a few prices
 * can't say much about sizes past them.
 */
function smaller(cents: number, from: number, slope: number, size: number) {
  const scaled = (cents * size) / from;
  return slope > 0
    ? Math.max(scaled, Math.min(cents - slope * (from - size), scaled * SMALL_JOB_LEAN))
    : scaled;
}

/**
 * The main work at a size, from the prices the owner charged at the sizes they've priced:
 * - between two of them, on a straight line, or at the nearer one's price when they price by
 *   size bands, or on the one line closest to all of them when they price by eye;
 * - past the biggest, carrying on at their rate across everything they've priced;
 * - below the smallest, scaled down from the smallest, a little over when their prices show a
 *   part every job pays, or the lowest band's price when they price by bands (a minimum still
 *   applies on top).
 * With no prices at sizes, it's the rate.
 */
export function mainWork(service: FormulaService, size: number): number | null {
  const points = sortedPoints(service.points);
  // At a size they've priced, it's their own price there (the average, if they priced it more than
  // once): a line through all their prices can't know this size better than they did. On the
  // benchmark this fixed 19 jobs for every 3 it broke, most of all where prices step, like a crew
  // that grows with the home.
  const exact = points.filter((point) => Math.abs(point.size - size) <= size * 0.01);
  if (exact.length) return exact.reduce((sum, point) => sum + point.cents, 0) / exact.length;
  const first = points[0],
    last = points.at(-1);
  if (first && last && points.length >= 2 && service.shape === 'fit') {
    const { slope, intercept } = straightLine(points);
    const at = (value: number) => intercept + slope * value;
    if (slope > 0 && at(first.size) > 0)
      return size >= first.size ? at(size) : smaller(at(first.size), first.size, slope, size);
  }
  if (first && last && points.length >= 2 && size >= first.size && size <= last.size) {
    const upper = points.findIndex((point) => point.size >= size);
    const high = points[upper],
      low = points[Math.max(0, upper - 1)];
    if (high.size === low.size) return high.cents;
    if (service.shape === 'bands')
      return size - low.size <= high.size - size ? low.cents : high.cents;
    return low.cents + ((high.cents - low.cents) * (size - low.size)) / (high.size - low.size);
  }
  if (first && last && points.length >= 2 && size > last.size) {
    // The rate across everything they've priced, not the last step: two close sizes, each
    // rounded, can make one step look far steeper than the owner's prices really are. Kept
    // near their price per unit at the biggest size, so a few odd points can't run away.
    const perUnit = last.cents / last.size;
    const { slope } = straightLine(points);
    const rate = slope >= perUnit * 0.4 && slope <= perUnit * 1.5 ? slope : perUnit;
    return last.cents + rate * (size - last.size);
  }
  // An owner who prices by bands often charges the lowest band as their minimum, and the AI may
  // have read it that way, so below the sizes priced it's the lower of the two.
  if (first && size < first.size && service.shape === 'bands')
    return Math.min(first.cents, service.minimumCents ?? first.cents);
  if (first && last && points.length >= 2 && size < first.size)
    return smaller(first.cents, first.size, straightLine(points).slope, size);
  if (first && size < first.size) return (first.cents * size) / first.size;
  if (service.rateCents) return service.rateCents * size;
  if (first) return (first.cents * size) / first.size;
  return null;
}

/**
 * How the owner's prices follow size: each reading predicts every price they charged between
 * two others from the rest. One line through all of them is the plain reading; a line from each
 * price to the next (for a bend, like cheaper big jobs) or size bands have to predict clearly
 * better to be chosen, since a few prices that stray, or round to the same amount, can look like
 * either when the owner charges one rate.
 */
export function priceShape(points: Point[]): PriceShape {
  const sorted = sortedPoints(points);
  // Fewer than four prices check each reading once at most: too few to call.
  if (sorted.length < 4) return 'line';
  // Each guess is rounded the way the owner rounds, so an owner who rounds to $25 doesn't look
  // like they price by size bands just because sizes near each other round to the same price.
  const step = ownerRounding(sorted.map((point) => point.cents));
  const [fit, line, bands] = (['fit', 'line', 'bands'] as const).map((shape) =>
    sorted.slice(1, -1).reduce((sum, point, index) => {
      const others = sorted.filter((_, at) => at !== index + 1);
      const service = { name: '', unit: '', rateCents: null, minimumCents: null, shape };
      const predicted = rounded(mainWork({ ...service, points: others }, point.size) ?? 0, step);
      return sum + Math.abs(predicted - point.cents) / point.cents;
    }, 0),
  );
  if (bands < 0.7 * Math.min(fit, line)) return 'bands';
  return line < 0.7 * fit ? 'line' : 'fit';
}

const rounded = (cents: number, to: number) =>
  cents <= 0 ? 0 : to > 0 ? Math.max(to, Math.round(cents / to) * to) : Math.round(cents);

/**
 * The least a job of this service costs, or null when the owner has no minimum. A minimum the
 * owner showed on one service applies to the others unless they set their own, but not the
 * smallest band's price on a service priced by bands: that's just its price.
 */
export function minimumFor(formula: PriceFormula, service: FormulaService): number | null {
  return (
    service.minimumCents ??
    formula.minimumCents ??
    (formula.services
      .filter((item) => item.shape !== 'bands')
      .map((item) => item.minimumCents)
      .filter((cents): cents is number => Boolean(cents))
      .sort((a, b) => a - b)[0] ||
      null)
  );
}

/**
 * The main work at a size within the whole formula: below the sizes a band owner priced, never
 * above the minimum their small jobs were raised to, whichever service it was set on.
 */
function workAt(formula: PriceFormula, service: FormulaService, size: number) {
  return mainWork({ ...service, minimumCents: minimumFor(formula, service) }, size);
}

/**
 * Whether the formula has a price for this service at this size. A job charged the minimum says
 * nothing about the rate, though the AI may divide it by the size anyway, so a service charged
 * only the minimum so far has a price up to the sizes it was charged at, and none past them. A
 * price under the minimum is a real one: that service's line on a bigger job.
 */
function pricedAt(formula: PriceFormula, service: FormulaService, size: number) {
  const minimum = minimumFor(formula, service);
  const points = sortedPoints(service.points);
  return (
    !minimum ||
    !points.length ||
    points.some((point) => Math.abs(point.cents - minimum) > minimum * 0.01) ||
    size <= points.at(-1)!.size
  );
}

/** The quote the formula gives for a job, or null when the formula can't price it. */
export function priceJob(formula: PriceFormula, parts: JobParts): FormulaQuote | null {
  const service = formula.services.find((item) => same(item.name, parts.service));
  if (!service || !parts.size || parts.size <= 0) return null;
  if (!pricedAt(formula, service, parts.size)) return null;
  let main = workAt(formula, service, parts.size);
  if (main === null) return null;
  if (service.extra) {
    if (parts.extraSize === null || parts.extraSize === undefined) return null;
    main += service.extra.rateCents * Math.max(0, parts.extraSize - service.extra.included);
  }
  const extras = parts.surcharges.map((name) => {
    const surcharge = formula.surcharges.find((item) => same(item.name, name));
    if (!surcharge) return null;
    return {
      label: surcharge.name,
      cents:
        surcharge.percent !== null ? (main * surcharge.percent) / 100 : (surcharge.flatCents ?? 0),
    };
  });
  if (extras.some((extra) => extra === null)) return null;
  const size = formatQuantity(parts.size, service.unit);
  // What takes off, like a regular-visit discount, is always in the main work's price.
  const own = extras.filter((extra) => formula.itemizes && extra!.cents > 0);
  const lines: { label: string; amountCents: number }[] = [
    {
      label: `${service.name}, ${size}`,
      amountCents:
        main +
        extras
          .filter((extra) => !own.includes(extra))
          .reduce((sum, extra) => sum + extra!.cents, 0),
    },
    ...own.map((extra) => ({ label: extra!.label, amountCents: extra!.cents })),
  ];
  for (const other of parts.otherServices) {
    const rule = formula.services.find((item) => same(item.name, other.name));
    // "The inside too" with no size of its own is the same windows, or the same gutters.
    const otherSize = other.size ?? (rule && same(rule.unit, service.unit) ? parts.size : null);
    const amount =
      rule && otherSize && pricedAt(formula, rule, otherSize)
        ? workAt(formula, rule, otherSize)
        : null;
    if (!rule || !otherSize || amount === null) return null;
    lines.push({
      label: `${rule.name}, ${formatQuantity(otherSize, rule.unit)}`,
      amountCents: amount,
    });
  }
  const always = formula.addOns
    .filter((item) => item.always && !parts.addOns.some((wanted) => same(wanted.name, item.name)))
    .map((item) => ({ name: item.name, count: null }));
  for (const wanted of [...parts.addOns, ...always]) {
    const addOn = formula.addOns.find((item) => same(item.name, wanted.name));
    if (!addOn) return null;
    // Priced by a size in another unit than this job's, either reading could be wrong: a rate per
    // system multiplied by square feet runs away, while what it came to on a rug can be far more
    // than on a room. It's the more modest of the two, and the quote is doubted (doubtsAbout).
    const elsewhere = addOn.per === 'unit' && addOn.unit && !same(addOn.unit, service.unit);
    const amount =
      addOn.per === 'unit'
        ? elsewhere && addOn.jobCents
          ? Math.min(addOn.cents * parts.size, addOn.jobCents)
          : addOn.cents * parts.size
        : addOn.per === 'item'
          ? addOn.cents * (wanted.count ?? 1)
          : addOn.cents;
    lines.push({
      label: addOn.per === 'item' && wanted.count ? `${addOn.name} (${wanted.count})` : addOn.name,
      amountCents: amount,
    });
  }
  for (const line of lines) line.amountCents = rounded(line.amountCents, formula.roundToCents);
  // Nothing goes on a quote for $0, but the main work always has its line.
  for (let index = lines.length - 1; index > 0; index--)
    if (lines[index].amountCents <= 0) lines.splice(index, 1);
  const minimum = minimumFor(formula, service);
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (minimum && subtotal < minimum) lines[0].amountCents += minimum - subtotal;
  const discount: Discount | null =
    parts.otherServices.length && formula.bundlePercent
      ? {
          kind: 'percent',
          value: Math.min(100, Math.round(formula.bundlePercent)),
          reason: 'Two services together',
        }
      : null;
  return { lines, discount, totalCents: quoteTotal({ lines, discount }) };
}

/**
 * The rounding every amount the owner wrote shares: the largest of $25, $10, $5 and $1 they all
 * divide by, or none. Worked out here rather than trusted to the AI.
 */
export function ownerRounding(amounts: number[]): number {
  const written = amounts.filter((amount) => amount > 0);
  if (!written.length) return 1;
  return [2500, 1000, 500, 100].find((step) => written.every((amount) => amount % step === 0)) ?? 1;
}

/** How the formula does on the quotes it was worked out from: each one's gap, in percent. */
export function fitGaps(formula: PriceFormula, examples: FormulaCheck[]): (number | null)[] {
  return examples.map((example) => {
    const priced = priceJob(formula, example.parts);
    if (!priced || example.totalCents <= 0) return null;
    return Math.round(
      (Math.abs(priced.totalCents - example.totalCents) / example.totalCents) * 100,
    );
  });
}

const words = (label: string) =>
  new Set(
    label
      .toLowerCase()
      .replace(/,.*$/, '')
      .replace(/\(.*?\)/g, '')
      .replace(/[^a-z ]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !['extra', 'for', 'the', 'and', 'a', 'of', 'with'].includes(word)),
  );

/** How much two line names share, from none to all of their words. */
function overlap(a: string, b: string) {
  const mine = words(a),
    theirs = words(b);
  const shared = [...mine].filter((word) => theirs.has(word)).length;
  return shared / Math.max(1, new Set([...mine, ...theirs]).size);
}

type Line = { label: string; amountCents: number };

/**
 * Pairs the formula's lines with the owner's: the main work with theirs, then each other line with
 * the one whose name it shares most with, and the last one left on each side with each other.
 */
function pairLines(mine: Line[], theirs: Line[]) {
  const pairs: [number | null, number | null][] = mine.length && theirs.length ? [[0, 0]] : [];
  const left = mine.map((_, at) => at).slice(1),
    right = theirs.map((_, at) => at).slice(1);
  for (;;) {
    let best: [number, number, number] | null = null;
    for (const i of left)
      for (const j of right) {
        const score = overlap(mine[i].label, theirs[j].label);
        if (score >= 0.34 && (!best || score > best[2])) best = [i, j, score];
      }
    if (!best) break;
    pairs.push([best[0], best[1]]);
    left.splice(left.indexOf(best[0]), 1);
    right.splice(right.indexOf(best[1]), 1);
  }
  if (left.length === 1 && right.length === 1) pairs.push([left.pop()!, right.pop()!]);
  return [
    ...pairs,
    ...left.map((at) => [at, null] as [number, null]),
    ...right.map((at) => [null, at] as [null, number]),
  ];
}

/** Whether the owner's total is their minimum, which says nothing about the job's parts. */
function atMinimum(formula: PriceFormula, example: FormulaCheck) {
  const service = formula.services.find((item) => same(item.name, example.parts.service));
  const minimum = service ? minimumFor(formula, service) : null;
  return Boolean(minimum && Math.abs(example.totalCents - minimum) <= minimum * 0.01);
}

/**
 * How far the formula's lines are from the owner's own, on the quotes that have them, in percent
 * of each quote: a quote says what each part cost, not just what they came to.
 */
function lineMiss(formula: PriceFormula, examples: FormulaCheck[]) {
  let sum = 0;
  for (const example of examples) {
    if (!example.lines?.length || example.totalCents <= 0 || atMinimum(formula, example)) continue;
    const priced = priceJob(formula, example.parts);
    if (!priced) continue;
    const owner = example.lines;
    const off = pairLines(priced.lines, owner).reduce(
      (total, [i, j]) =>
        total +
        Math.abs(
          (i === null ? 0 : priced.lines[i].amountCents) - (j === null ? 0 : owner[j].amountCents),
        ),
      0,
    );
    sum += (off / example.totalCents) * 100;
  }
  return sum;
}

/** The owner's line for this part of the job, on a quote that has lines, or null. */
function ownerLine(formula: PriceFormula, example: FormulaCheck, label: (line: Line) => boolean) {
  if (!example.lines?.length || atMinimum(formula, example)) return null;
  const priced = priceJob(formula, example.parts);
  if (!priced) return null;
  for (const [i, j] of pairLines(priced.lines, example.lines))
    if (i !== null && j !== null && label(priced.lines[i])) return example.lines[j];
  return null;
}

/**
 * Settles what the AI can't always tell from a few rounded prices: how price follows size, what
 * the minimum is, whether a surcharge is a percent of the main work or a flat amount, how big it
 * is, and whether there's one at all, what each add-on costs and how it's charged, and which are
 * on every job. Each reading is tried against the owner's own quotes, line by line where they
 * wrote lines, and the one that gives them back best is kept. On a tie, the simpler reading wins.
 * A price the owner's notes give stays as it is, even where older quotes disagree.
 */
export function refineFormula(formula: PriceFormula, examples: FormulaCheck[]): PriceFormula {
  const miss = (candidate: PriceFormula) =>
    fitGaps(candidate, examples).reduce<number>((sum, gap) => sum + (gap ?? 100), 0) +
    lineMiss(candidate, examples);
  let best: PriceFormula = {
    ...formula,
    services: formula.services.map((service) => ({
      ...service,
      shape: priceShape(service.points),
    })),
  };
  // A service's minimum that another service's job was also charged is the whole business's.
  if (best.minimumCents === null)
    best.minimumCents =
      best.services.find(
        (service) =>
          service.minimumCents &&
          examples.some(
            (example) =>
              !same(example.parts.service, service.name) &&
              Math.abs(example.totalCents - service.minimumCents!) <= service.minimumCents! * 0.01,
          ),
      )?.minimumCents ?? null;
  // A minimum above a price the owner charged for a job of one service isn't theirs. (A job of two
  // services together can come in under it, after the discount for booking both.)
  const alone = examples.filter((example) => !example.parts.otherServices.length);
  const charged = (service?: string) =>
    Math.min(
      ...alone
        .filter((example) => !service || same(example.parts.service, service))
        .map((example) => example.totalCents),
    );
  if (best.minimumCents !== null && charged() < best.minimumCents * 0.99) best.minimumCents = null;
  best = {
    ...best,
    services: best.services.map((service) =>
      service.minimumCents && charged(service.name) < service.minimumCents * 0.99
        ? { ...service, minimumCents: null }
        : service,
    ),
  };
  // The AI sometimes takes a small job raised to a minimum for a price at its size. When there's
  // no minimum, the cheapest totals are each tried as one, without the prices at that amount, and
  // kept only when the quotes' totals come back clearly better: a job at a minimum says nothing
  // line by line, so its lines can't count for or against one. A minimum is a price jobs of
  // different sizes share, so only a total at least two of them came to is tried: one cheap job
  // is just a cheap job.
  if (best.minimumCents === null && !best.services.some((service) => service.minimumCents)) {
    const totals = (candidate: PriceFormula) =>
      fitGaps(candidate, examples).reduce<number>((sum, gap) => sum + (gap ?? 100), 0);
    let current = totals(best);
    const shared = (total: number) =>
      new Set(
        examples
          .filter((example) => Math.abs(example.totalCents - total) <= total * 0.01)
          .map((example) => `${example.parts.service}:${example.parts.size}`),
      ).size >= 2;
    const cheapest = [...new Set(examples.map((example) => example.totalCents))]
      .sort((a, b) => a - b)
      .slice(0, 3)
      // Never above a price the owner charged for one service alone.
      .filter((total) => shared(total) && total <= charged() * 1.01);
    for (const total of cheapest) {
      const alternative = {
        ...best,
        minimumCents: total,
        services: best.services.map((service) => {
          const points = service.points.filter(
            (point) => Math.abs(point.cents - total) > total * 0.01,
          );
          return { ...service, points, shape: priceShape(points) };
        }),
      };
      const candidate = totals(alternative) + 5;
      if (candidate < current) {
        best = alternative;
        current = candidate;
      }
    }
  }
  // A second count's price, and how many the main price includes: each job says what its count
  // added, given the rest of the formula.
  for (const [index, service] of best.services.entries()) {
    if (!service.extra) continue;
    const extra = service.extra;
    const withRate = (rateCents: number, included: number) => ({
      ...best,
      services: best.services.map((item, at) =>
        at === index ? { ...item, extra: { ...extra, rateCents, included } } : item,
      ),
    });
    let current = miss(best);
    for (const included of new Set([0, 1, extra.included]))
      for (const example of examples) {
        const count = example.parts.extraSize;
        if (!same(example.parts.service, service.name) || !count || count <= included) continue;
        const rest = priceJob(withRate(0, included), example.parts);
        const cost = rest ? example.totalCents - rest.totalCents : 0;
        if (cost <= 0) continue;
        const alternative = withRate(Math.round(cost / (count - included)), included);
        const candidate = miss(alternative);
        if (candidate < current) {
          best = alternative;
          current = candidate;
        }
      }
  }
  const fromNotes = (name: string) => formula.setByNotes?.some((item) => same(item, name));
  // A set charge on nearly every quote the owner itemized that customers don't ask for, like a
  // trip charge, is on every job.
  const itemized = examples.filter((example) => example.lines?.length);
  best = {
    ...best,
    addOns: best.addOns.map((addOn) => {
      if (addOn.per !== 'job' || addOn.always || fromNotes(addOn.name)) return addOn;
      const listed = itemized.filter((example) =>
        example.lines!.some((line) => overlap(line.label, addOn.name) >= 0.5),
      ).length;
      const asked = examples.filter((example) =>
        example.parts.addOns.some((item) => same(item.name, addOn.name)),
      ).length;
      return listed >= Math.max(2, itemized.length * 0.8) && asked < listed / 2
        ? { ...addOn, always: true }
        : addOn;
    }),
  };
  for (const [index, surcharge] of formula.surcharges.entries()) {
    if (fromNotes(surcharge.name)) continue;
    const had = examples.filter((example) =>
      example.parts.surcharges.some((name) => same(name, surcharge.name)),
    );
    const mains = had
      .map((example) => {
        const service = best.services.find((item) => same(item.name, example.parts.service));
        return service && example.parts.size ? workAt(best, service, example.parts.size) : null;
      })
      .filter((cents): cents is number => cents !== null && cents > 0);
    if (!mains.length) continue;
    // Jobs that had it at about the same size can't tell a percent from a flat amount, since
    // both give them back alike, so it's a percent unless their sizes differ by half again.
    const flatTold = mains.length > 1 && Math.max(...mains) >= Math.min(...mains) * 1.5;
    const average = mains.reduce((sum, main) => sum + main, 0) / mains.length;
    if (!flatTold && best.surcharges[index].percent === null)
      best = {
        ...best,
        surcharges: best.surcharges.map((item, at) =>
          at === index
            ? { ...item, percent: ((item.flatCents ?? 0) / average) * 100, flatCents: null }
            : item,
        ),
      };
    // Each job that had it gives one way to turn the amount into the other kind, and a percent is
    // also searched from none to 80% in half points, since rounding can hide the right one, off
    // the price for what takes off. A quote that lists it says what it was, next to the main work.
    const off = (surcharge.percent ?? surcharge.flatCents ?? 0) < 0 ? -1 : 1;
    const listed = had.flatMap((example) => {
      const line = ownerLine(best, example, (item) => same(item.label, surcharge.name));
      const main = example.lines?.[0]?.amountCents;
      return line && main
        ? [
            { ...surcharge, percent: (line.amountCents / main) * 100, flatCents: null },
            { ...surcharge, percent: null, flatCents: line.amountCents },
          ]
        : [];
    });
    const others: FormulaSurcharge[] = [
      ...[...new Set(mains.length > 1 ? mains : [])].map((main) =>
        surcharge.percent !== null
          ? { ...surcharge, percent: null, flatCents: Math.round((main * surcharge.percent) / 100) }
          : { ...surcharge, percent: ((surcharge.flatCents ?? 0) / main) * 100, flatCents: null },
      ),
      ...listed,
      ...Array.from({ length: 161 }, (_, step) => ({
        ...surcharge,
        percent: (off * step) / 2,
        flatCents: null,
      })),
    ].filter((other) => flatTold || other.percent !== null);
    // A surcharge at all has to give the quotes back better than none, and a flat amount better
    // than a percent, by half a point for each job that had it: an owner who prices by eye
    // strays enough to make a small surcharge, or a flat one, look a little closer.
    const weight = (item: FormulaSurcharge) =>
      item.percent === 0 ? 0 : ((item.percent === null ? 2 : 1) * mains.length) / 2;
    let current = miss(best) + weight(best.surcharges[index]);
    for (const other of others) {
      const alternative = {
        ...best,
        surcharges: best.surcharges.map((item, at) => (at === index ? other : item)),
      };
      const candidate = miss(alternative) + weight(other);
      if (candidate < current) {
        best = alternative;
        current = candidate;
      }
    }
  }
  // Add-ons the same way: each job that had one says what it must have cost, given the rest of
  // the formula, per unit, per item or per job, and a quote that lists it says what it was.
  for (const [index, addOn] of best.addOns.entries()) {
    if (fromNotes(addOn.name)) continue;
    const without = {
      ...best,
      addOns: best.addOns.map((item, at) => (at === index ? { ...item, cents: 0 } : item)),
    };
    const ways = (cost: number, size: number, count: number | null): FormulaAddOn[] => [
      { ...addOn, per: 'unit', cents: Math.round(cost / size) },
      { ...addOn, per: 'job', cents: cost },
      ...(count ? [{ ...addOn, per: 'item' as const, cents: Math.round(cost / count) }] : []),
    ];
    const candidates: FormulaAddOn[] = [];
    let seen = 0;
    for (const example of examples) {
      const wanted = addOn.always
        ? { name: addOn.name, count: null }
        : example.parts.addOns.find((item) => same(item.name, addOn.name));
      if (!wanted) continue;
      seen++;
      const rest = priceJob(without, example.parts);
      if (!rest || !example.parts.size) continue;
      const cost = example.totalCents - rest.totalCents;
      if (cost > 0) candidates.push(...ways(cost, example.parts.size, wanted.count));
      const line = ownerLine(best, example, (item) => item.label.startsWith(addOn.name));
      if (line) candidates.push(...ways(line.amountCents, example.parts.size, wanted.count));
    }
    // From one job, per unit and per job give it back equally, so how it's charged stays the
    // AI's reading of how the trade charges it, unless that reading can't give the job back.
    // Charging it another way has to give the quotes back better by a point for each job.
    const sameWay = candidates.filter((other) => other.per === addOn.per);
    const weight = (item: FormulaAddOn) => (item.per === addOn.per ? 0 : seen);
    let current = miss(best);
    for (const other of seen > 1 || !sameWay.length ? candidates : sameWay) {
      const alternative = {
        ...best,
        addOns: best.addOns.map((item, at) => (at === index ? other : item)),
      };
      const candidate = miss(alternative) + weight(other);
      if (candidate < current) {
        best = alternative;
        current = candidate;
      }
    }
  }
  // Each add-on priced by the size keeps the unit of the jobs it was quoted on, and what it came to
  // on them (the middle one).
  return {
    ...best,
    addOns: best.addOns.map((addOn) => {
      if (addOn.per !== 'unit') return addOn;
      const seen = examples.flatMap((example) => {
        const wanted = example.parts.addOns.some((item) => same(item.name, addOn.name));
        const service = best.services.find((item) => same(item.name, example.parts.service));
        return (wanted || addOn.always) && service && example.parts.size
          ? [{ unit: service.unit, cents: addOn.cents * example.parts.size }]
          : [];
      });
      if (!seen.length) return addOn;
      const units = [...new Set(seen.map((item) => item.unit.toLowerCase()))];
      if (units.length > 1) return addOn;
      const costs = seen.map((item) => item.cents).sort((a, b) => a - b);
      return {
        ...addOn,
        unit: seen[0].unit,
        jobCents: Math.round(costs[Math.floor(costs.length / 2)]),
      };
    }),
  };
}

/**
 * What makes this quote one not to send as a firm price, in the owner's words, or nothing. Each is
 * a sign the formula is guessing rather than following the owner's own quotes: a size far from
 * any they priced, a service they've priced only once or twice, a size between two of their
 * prices that jump, a rate far from theirs, less than anything they've ever charged, extras that
 * come to more than the job itself, or a minimum never charged for the service. On
 * the benchmark these catch most of the quotes that end up far from the owner's price (see
 * src/bench.ts), and a quote with one goes out as a range.
 */
export function doubtsAbout(
  formula: PriceFormula,
  examples: FormulaCheck[],
  parts: JobParts,
  quote: FormulaQuote,
): string[] {
  // Without the owner's quotes there's nothing to judge it against.
  if (!examples.length) return [];
  const doubts: string[] = [];
  const sizesOf = (name: string) =>
    examples.flatMap((example) => [
      ...(same(example.parts.service, name) && example.parts.size ? [example.parts.size] : []),
      ...example.parts.otherServices
        .filter((other) => same(other.name, name) && other.size)
        .map((other) => other.size!),
    ]);
  const services = [
    { name: parts.service, size: parts.size },
    ...parts.otherServices.map((other) => ({ name: other.name, size: other.size ?? parts.size })),
  ];
  for (const { name, size } of services) {
    if (!size) continue;
    const sizes = sizesOf(name);
    if (sizes.length <= 2)
      doubts.push(
        `You’ve priced ${name.toLowerCase()} only ${sizes.length === 1 ? 'once' : sizes.length ? 'twice' : 'in other jobs'} so far.`,
      );
    else if (size > Math.max(...sizes) * 1.5)
      doubts.push(`It’s much bigger than the ${name.toLowerCase()} jobs you’ve priced.`);
    else if (size < Math.min(...sizes) * 0.67)
      doubts.push(`It’s much smaller than the ${name.toLowerCase()} jobs you’ve priced.`);
  }
  const service = formula.services.find((item) => same(item.name, parts.service));
  const size = parts.size;
  if (service && size) {
    const points = sortedPoints(service.points);
    const main = workAt(formula, service, size) ?? 0;
    const perUnit = points.map((point) => point.cents / point.size);
    // Between two of their prices where the price per unit jumps: where it steps up can't be told.
    for (const [index, low] of points.slice(0, -1).entries()) {
      const high = points[index + 1];
      if (
        size > low.size * 1.01 &&
        size < high.size * 0.99 &&
        perUnit[index + 1] > perUnit[index] * 1.3
      ) {
        doubts.push('Your price jumps between the sizes on either side of this one.');
        break;
      }
    }
    if (perUnit.length >= 2 && main > 0) {
      const rate = main / size;
      if (rate < Math.min(...perUnit) * 0.6 || rate > Math.max(...perUnit) * 1.6)
        doubts.push(`Its rate is far from what you charge for ${service.name.toLowerCase()}.`);
    }
    const extras = parts.surcharges
      .map((name) => formula.surcharges.find((item) => same(item.name, name)))
      .reduce(
        (sum, item) =>
          sum +
          Math.max(
            0,
            item
              ? item.percent !== null
                ? (main * item.percent) / 100
                : (item.flatCents ?? 0)
              : 0,
          ),
        0,
      );
    if (main > 0 && extras > main) doubts.push('Its extras come to more than the job itself.');
    const elsewhere = parts.addOns
      .map((wanted) => formula.addOns.find((item) => same(item.name, wanted.name)))
      .find((item) => item?.per === 'unit' && item.unit && !same(item.unit, service.unit));
    if (elsewhere)
      doubts.push(
        `${elsewhere.name} is priced by the ${elsewhere.unit!.replace(/s$/, '')} on other jobs, not by the ${service.unit.replace(/s$/, '')}.`,
      );
  }
  // Lifted well up to a minimum this service was never charged: the minimum may not be its.
  if (service) {
    const minimum = minimumFor(formula, service);
    const unlifted = priceJob(
      {
        ...formula,
        minimumCents: null,
        services: formula.services.map((item) => ({ ...item, minimumCents: null })),
      },
      parts,
    );
    const chargedHere = examples.some(
      (example) =>
        same(example.parts.service, service.name) &&
        minimum !== null &&
        Math.abs(example.totalCents - minimum) <= minimum * 0.01,
    );
    if (minimum && unlifted && quote.totalCents > unlifted.totalCents * 1.25 && !chargedHere)
      doubts.push(
        `It’s lifted to your minimum, which you haven’t charged for ${service.name.toLowerCase()}.`,
      );
  }
  const cheapest = Math.min(
    ...examples.map((example) => example.totalCents).filter((cents) => cents > 0),
  );
  if (Number.isFinite(cheapest) && quote.totalCents < cheapest * 0.9)
    doubts.push('It’s less than anything you’ve charged.');
  // A surcharge or add-on far beyond what it came to on any of their own quotes: one seen on small
  // jobs, as a share, can run far past what they'd charge on a big one.
  const most = new Map<string, number>();
  for (const example of examples)
    for (const line of priceJob(formula, example.parts)?.lines.slice(1) ?? [])
      most.set(
        line.label.replace(/ \(\d+\)$/, ''),
        Math.max(most.get(line.label.replace(/ \(\d+\)$/, '')) ?? 0, line.amountCents),
      );
  const runaway = quote.lines.slice(1).find((line) => {
    const before = most.get(line.label.replace(/ \(\d+\)$/, ''));
    return (
      before !== undefined && line.amountCents > before * 2.5 && line.amountCents - before > 5000
    );
  });
  if (runaway)
    doubts.push(
      `Its ${runaway.label.replace(/ \(\d+\)$/, '').toLowerCase()} is far more than you’ve charged for it.`,
    );
  const dearest = Math.max(...examples.map((example) => example.totalCents));
  if (quote.totalCents > dearest * 2) doubts.push('It’s more than twice anything you’ve charged.');
  return doubts;
}

/** The share of the owner's own quotes the formula gives back within 10%. */
const givenBack = (gaps: (number | null)[]) =>
  gaps.filter((gap) => gap !== null && gap <= 10).length / (gaps.length || 1);

/**
 * Whether the formula is trusted to price firmly: it has to give back most of the owner's own
 * quotes within 10%. Owners who price by eye stray a few percent job to job, so a formula that has
 * them right still can't match every quote to the dollar.
 */
export function formulaFits(gaps: (number | null)[]) {
  return gaps.length >= 3 && givenBack(gaps) >= 0.6;
}

/**
 * Whether the formula still prices, as a range, when it doesn't fit: it gives back at least 40%
 * of the owner's quotes. One that misses a good few still prices new jobs far closer than the
 * AI's usual draft does (on the benchmark, 57% within 10% against 37% for a formula giving back
 * 70–79% of the owner's quotes, and the draft was 130–240% off for one giving back 56%), so only
 * one that misses most of them is left to the AI.
 */
export function formulaUsable(gaps: (number | null)[]) {
  return gaps.length >= 3 && givenBack(gaps) >= 0.4;
}
