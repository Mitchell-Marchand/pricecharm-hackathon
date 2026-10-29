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
  /** No job of this service for less, when the owner has a minimum for it. */
  minimumCents: number | null;
};

export type FormulaSurcharge = {
  name: string;
  /** When it applies, in the owner's terms: "heavy moss", "second story". */
  when: string;
  /** Percent of the main work, or a flat amount. */
  percent: number | null;
  flatCents: number | null;
};

export type FormulaAddOn = {
  name: string;
  /** Per unit of the job's size, once per job, or per item counted (like each downspout). */
  per: 'unit' | 'job' | 'item';
  cents: number;
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
};

/** What a job is in the formula's terms. Names match the formula's own. */
export type JobParts = {
  service: string;
  size: number | null;
  surcharges: string[];
  addOns: { name: string; count: number | null }[];
  otherServices: { name: string; size: number | null }[];
};

export type FormulaQuote = {
  lines: { label: string; amountCents: number }[];
  discount: Discount | null;
  totalCents: number;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The main work at a size. Between sizes the owner priced, it goes on a straight line from one
 * to the next; past the biggest it carries on at the last step's rate; otherwise it's the rate.
 */
export function mainWork(service: FormulaService, size: number): number | null {
  const points = [...service.points]
    .filter((point) => point.size > 0 && point.cents > 0)
    .sort((a, b) => a.size - b.size);
  const first = points[0],
    last = points.at(-1);
  if (first && last && points.length >= 2 && size >= first.size && size <= last.size) {
    const upper = points.findIndex((point) => point.size >= size);
    const high = points[upper],
      low = points[Math.max(0, upper - 1)];
    if (high.size === low.size) return high.cents;
    return low.cents + ((high.cents - low.cents) * (size - low.size)) / (high.size - low.size);
  }
  if (first && last && points.length >= 2 && size > last.size) {
    // The rate across everything they've priced, not the last step: two close sizes, each
    // rounded, can make one step look far steeper than the owner's prices really are.
    const slope = (last.cents - first.cents) / (last.size - first.size);
    const rate = slope > 0 ? slope : (service.rateCents ?? last.cents / last.size);
    return last.cents + rate * (size - last.size);
  }
  if (service.rateCents) return service.rateCents * size;
  if (first) return (first.cents * size) / first.size;
  return null;
}

const rounded = (cents: number, to: number) =>
  to > 0 ? Math.max(to, Math.round(cents / to) * to) : Math.round(cents);

/** The quote the formula gives for a job, or null when the formula can't price it. */
export function priceJob(formula: PriceFormula, parts: JobParts): FormulaQuote | null {
  const service = formula.services.find((item) => same(item.name, parts.service));
  if (!service || !parts.size || parts.size <= 0) return null;
  const main = mainWork(service, parts.size);
  if (main === null) return null;
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
  const lines: { label: string; amountCents: number }[] = formula.itemizes
    ? [
        { label: `${service.name}, ${size}`, amountCents: main },
        ...extras.map((extra) => ({ label: extra!.label, amountCents: extra!.cents })),
      ]
    : [
        {
          label: `${service.name}, ${size}`,
          amountCents: main + extras.reduce((sum, extra) => sum + extra!.cents, 0),
        },
      ];
  for (const other of parts.otherServices) {
    const rule = formula.services.find((item) => same(item.name, other.name));
    const amount = rule && other.size ? mainWork(rule, other.size) : null;
    if (!rule || !other.size || amount === null) return null;
    lines.push({
      label: `${rule.name}, ${formatQuantity(other.size, rule.unit)}`,
      amountCents: amount,
    });
  }
  for (const wanted of parts.addOns) {
    const addOn = formula.addOns.find((item) => same(item.name, wanted.name));
    if (!addOn) return null;
    const amount =
      addOn.per === 'unit'
        ? addOn.cents * parts.size
        : addOn.per === 'item'
          ? addOn.cents * (wanted.count ?? 1)
          : addOn.cents;
    lines.push({
      label: addOn.per === 'item' && wanted.count ? `${addOn.name} (${wanted.count})` : addOn.name,
      amountCents: amount,
    });
  }
  for (const line of lines) line.amountCents = rounded(line.amountCents, formula.roundToCents);
  const minimum = service.minimumCents ?? formula.minimumCents;
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
export function fitGaps(
  formula: PriceFormula,
  examples: { parts: JobParts; totalCents: number }[],
): (number | null)[] {
  return examples.map((example) => {
    const priced = priceJob(formula, example.parts);
    if (!priced || example.totalCents <= 0) return null;
    return Math.round(
      (Math.abs(priced.totalCents - example.totalCents) / example.totalCents) * 100,
    );
  });
}

/**
 * Whether the formula is trusted to price: it has to give back the owner's own quotes, nearly
 * all of them within 5%. Otherwise the owner's prices don't follow a formula well enough yet,
 * and the AI drafts instead.
 */
export function formulaFits(gaps: (number | null)[]) {
  if (gaps.length < 3) return false;
  const close = gaps.filter((gap) => gap !== null && gap <= 5).length;
  return close / gaps.length >= 0.8;
}
