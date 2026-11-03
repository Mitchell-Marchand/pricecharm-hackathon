import { notesFor, type Walkaround } from '../ai/walkaround.js';
import type { Currency } from '../money.js';
import { SIZE_FACT, specFromScenario } from '../pricing/spec.js';
import { canonicalUnit, formatNumber, formatQuantity, roundSize } from '../pricing/units.js';
import type { Distance, Fact, PracticeScenario } from './types.js';

/**
 * A practice customer's facts squared with their own photos. Generated photos drift on counts:
 * asked for 18 windows, the picture may show 15. Once the photos are read, the customer's size
 * and any count their answers give takes what the reading found, so nothing they say contradicts
 * what the owner can see. The owner's fixes to the reading go the same way, as exact numbers.
 */

/** A surface the reading sized as a range is only moved when the customer's size is this far out. */
const AREA_SLACK = 1.25;

/** What the owner changed in what their Charm saw: counts by label, the surface's size, a note. */
export type PhotoFixes = {
  counts: Record<string, number>;
  area: number | null;
  note: string;
};

export const noFixes = (): PhotoFixes => ({ counts: {}, area: null, note: '' });

const unitOf = (unit: string) => canonicalUnit(unit) ?? unit.trim().toLowerCase();

/** The number as written in text, with or without a thousands comma: 1200 and 1,200. */
function numberPattern(value: number) {
  const plain = String(Math.round(value * 100) / 100);
  const comma = formatNumber(value);
  const spellings = [...new Set([plain, comma])].map((text) => text.replace(/[.,]/g, '\\$&'));
  // Not part of a price, a longer number or a date like "the 18th".
  return new RegExp(
    `(?<![$\\d.,])(?:${spellings.join('|')})(?!\\d|\\.\\d|st\\b|nd\\b|rd\\b|th\\b)`,
    'gi',
  );
}

/** The text with one number changed to another, or null when the number isn't in it. */
export function swapNumber(text: string, from: number, to: number): string | null {
  if (!numberPattern(from).test(text)) return null;
  return text.replace(numberPattern(from), formatNumber(to));
}

/** Like swapNumber, but only where the number is followed by the unit: "18 windows". */
function swapNumberOf(text: string, from: number, to: number, unit: string): string | null {
  const words = labelWords(unit).join('|');
  const pattern = new RegExp(
    `${numberPattern(from).source}(?=\\s+(?:[a-z-]+\\s+)?(?:${words})\\b)`,
    'gi',
  );
  if (!pattern.test(text)) return null;
  return text.replace(new RegExp(pattern.source, 'gi'), formatNumber(to));
}

/** "windows" and "window", for finding "3 windows" or "3 big windows" in what a customer says. */
function labelWords(label: string) {
  const plural = label.trim().toLowerCase();
  const single = plural.replace(/(?:es|s)$/, '');
  return [...new Set([plural, single, `${single}s`])]
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** Changes the number in "3 skylights" or "3 big skylights" to the count the photos show. */
function swapCounted(text: string, label: string, count: number) {
  const pattern = new RegExp(
    `(?<![$\\d.,])\\d+(?=\\s+(?:[a-z-]+\\s+)?(?:${labelWords(label).join('|')})\\b)`,
    'gi',
  );
  return text.replace(pattern, String(count));
}

/** The size the reading gives in the customer's unit: a count of that thing, or a surface. */
function readSize(reading: Walkaround, unit: string) {
  const counted = reading.counts.find((item) => item.count > 0 && unitOf(item.unit) === unit);
  if (counted)
    return { kind: 'count' as const, quantity: counted.count, atLeast: Boolean(counted.atLeast) };
  const area = reading.area;
  if (area && unitOf(area.unit) === unit && area.low > 0 && area.high >= area.low)
    return { kind: 'area' as const, quantity: (area.low + area.high) / 2, ...area };
  return null;
}

/** The size the customer should give once their photos are read, or null to keep theirs. */
function sizeFromReading(current: number, reading: Walkaround, unit: string, exact: boolean) {
  const read = readSize(reading, unit);
  if (!read) return null;
  if (read.kind === 'count') {
    // More than could be counted one by one: only a smaller number contradicts the photos.
    if (read.atLeast && !exact) return current < read.quantity ? read.quantity : null;
    return read.quantity === current ? null : read.quantity;
  }
  if (exact) return read.quantity === current ? null : read.quantity;
  const inside = current >= read.low / AREA_SLACK && current <= read.high * AREA_SLACK;
  return inside ? null : roundSize(read.quantity);
}

/** The facts the photos settle: the ones marked visible, or every one when none are marked. */
function shownFacts(facts: Fact[]) {
  return facts.some((fact) => fact.visible) ? facts.filter((fact) => fact.visible) : facts;
}

/**
 * Where the customer's facts and their photos' reading disagree, like "trees: says 1, photos show
 * 2". The customer's own words never change for it: generated photos drift on counts and readers
 * miscount, and a customer who contradicts their own answer is worse than a photo that's off.
 * Only an owner's fix to the reading (`exact`) is taken as the job, and then just the number
 * moves, where it's written as one. Nothing is added to what the customer said.
 */
export function reconcileScenario(
  scenario: PracticeScenario,
  reading: Walkaround,
  { exact = false }: { exact?: boolean } = {},
): { scenario: PracticeScenario; changes: string[] } {
  const spec = specFromScenario(scenario);
  const unit = spec.unit ? unitOf(spec.unit) : '';
  const target =
    spec.quantity && unit ? sizeFromReading(spec.quantity, reading, unit, exact) : null;
  if (!exact)
    return {
      scenario,
      changes:
        spec.quantity && target !== null
          ? [`${unit}: says ${formatNumber(spec.quantity)}, photos show ${formatNumber(target)}`]
          : [],
    };
  const next: PracticeScenario = {
    ...scenario,
    facts: scenario.facts.map((fact) => ({ ...fact })),
    suggestions: [...scenario.suggestions],
  };
  const changes: string[] = [];
  if (spec.quantity && target !== null) {
    const from = spec.quantity;
    next.quantity = target;
    next.unit = unit;
    changes.push(`${unit}: ${formatNumber(from)} to ${formatNumber(target)}`);
    // In the size answer any mention of the number is the size. Elsewhere only "18 windows" is.
    for (const fact of next.facts) {
      const swapped = SIZE_FACT.test(fact.key)
        ? swapNumber(fact.answer, from, target)
        : swapNumberOf(fact.answer, from, target, unit);
      if (swapped !== null) fact.answer = swapped;
    }
    next.suggestions = next.suggestions.map(
      (line) => swapNumberOf(line, from, target, unit) ?? line,
    );
    next.opener = swapNumberOf(next.opener, from, target, unit) ?? next.opener;
  }
  // Other things the owner counted, like "3 skylights", say the same number as their fix.
  for (const item of reading.counts) {
    if (!item.count || unitOf(item.unit) === unit) continue;
    for (const fact of shownFacts(next.facts)) {
      const swapped = swapCounted(fact.answer, item.label, item.count);
      if (swapped !== fact.answer) {
        changes.push(`${item.label} in ${fact.key}`);
        fact.answer = swapped;
      }
    }
  }
  return { scenario: next, changes };
}

/** The reading with the owner's fixes in: their counts and size in place of what was read. */
export function fixedReading(
  reading: Walkaround,
  fixes: PhotoFixes | null | undefined,
): Walkaround {
  if (!fixes) return reading;
  const counts = reading.counts.map((item) =>
    item.label in fixes.counts
      ? { ...item, count: fixes.counts[item.label], atLeast: undefined, kinds: undefined }
      : item,
  );
  const area =
    reading.area && fixes.area !== null
      ? { ...reading.area, low: fixes.area, high: fixes.area }
      : reading.area;
  const counted = counts.find(
    (item) => item.count > 0 && unitOf(item.unit) === unitOf(reading.unit),
  );
  const sized = counted
    ? counted.count
    : area && unitOf(area.unit) === unitOf(reading.unit)
      ? area.low
      : reading.quantity;
  return { ...reading, counts, area, quantity: sized, notes: readingNotes(reading, fixes) };
}

/** Only what the owner fixed, as a reading, so squaring the facts with it moves nothing else. */
export function ownerReading(reading: Walkaround, fixes: PhotoFixes): Walkaround {
  const fixed = fixedReading(reading, fixes);
  return {
    ...fixed,
    counts: fixed.counts.filter((item) => item.label in fixes.counts),
    area: fixes.area !== null ? fixed.area : null,
  };
}

/**
 * What the Charm reads about the photos, fixes and all. A count or size the owner fixed is said as
 * theirs, not as something found in the photos, and their note goes in as they wrote it.
 */
export function readingNotes(reading: Walkaround, fixes: PhotoFixes | null | undefined): string[] {
  if (!fixes) return reading.notes;
  const fixedLabels = new Set(Object.keys(fixes.counts));
  const read = {
    ...reading,
    counts: reading.counts.filter((item) => !fixedLabels.has(item.label)),
    area: fixes.area !== null ? null : reading.area,
  };
  return [
    ...reading.counts
      .filter((item) => fixedLabels.has(item.label))
      .map(
        (item) =>
          `The owner counted ${formatQuantity(fixes.counts[item.label], item.unit)} in the customer's photos.`,
      ),
    ...(reading.area && fixes.area !== null
      ? [
          `The owner says the ${reading.area.surface} in the customer's photos is about ${formatQuantity(fixes.area, reading.area.unit)}.`,
        ]
      : []),
    ...notesFor(read),
    ...(fixes.note.trim()
      ? [`The owner says about the customer's photos: ${fixes.note.trim()}`]
      : []),
  ];
}

/**
 * How far a practice customer is from the business, when nothing better says: most nearby, some
 * across town, now and then far enough that an owner might turn it down.
 */
export function drawDistance(
  currency: Currency,
  from = '',
  random: () => number = Math.random,
): Distance {
  const band = random();
  const miles =
    band < 0.7 ? 2 + random() * 10 : band < 0.92 ? 12 + random() * 13 : 25 + random() * 20;
  return distanceOf(miles, currency, from);
}

/** A distance in miles, in the unit the business uses: miles with US dollars, km otherwise. */
export function distanceOf(miles: number, currency: Currency, from = ''): Distance {
  const unit = currency === 'USD' ? 'mi' : 'km';
  const value = Math.max(1, Math.round(unit === 'mi' ? miles : miles * 1.609));
  return { value, unit, ...(from ? { from } : {}) };
}
