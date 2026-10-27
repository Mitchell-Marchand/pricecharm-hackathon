import { quoteTotal, type Quote } from '../practice/types.js';

/** What goes out for a service the Charm is still learning: a range, an estimate, or a firm price. */
export const LEARNING_STYLES = ['range', 'estimate', 'firm'] as const;
export type LearningStyle = (typeof LEARNING_STYLES)[number];

/** A service gets firm prices from this far along, unless the owner picks another mark. */
export const TRAINED_PERCENT = 60;
/** A range for a service it barely knows goes this far each way, narrowing to the next one. */
const WIDEST = 0.25;
const NARROWEST = 0.1;

/** How a quote for a service this far along goes out, by the owner's settings. */
export function priceStyle(
  progress: number,
  settings: { trainedPercent: number; learningStyle: LearningStyle },
): LearningStyle {
  return progress >= settings.trainedPercent ? 'firm' : settings.learningStyle;
}

/** How far each way a range goes: wide for a service it barely knows, narrower as it learns. */
export function rangeSpread(progress: number, trainedPercent: number) {
  const known = trainedPercent > 0 ? Math.min(1, Math.max(0, progress) / trainedPercent) : 1;
  return WIDEST - (WIDEST - NARROWEST) * known;
}

/** A range around the total, rounded outward to steps a person would say out loud. */
export function rangeAround(totalCents: number, spread: number) {
  const step =
    totalCents < 50_000
      ? 1_000
      : totalCents < 200_000
        ? 2_500
        : totalCents < 1_000_000
          ? 5_000
          : 10_000;
  // Whole cents first, so 500 × 1.1 doesn't round up a step.
  const low = Math.floor(Math.round(totalCents * (1 - spread)) / step) * step;
  const high = Math.ceil(Math.round(totalCents * (1 + spread)) / step) * step;
  return {
    lowCents: Math.min(Math.max(step, low), totalCents),
    highCents: Math.max(high, totalCents),
  };
}

/**
 * The card with a new price style, or the same one with its range moved to a new total. A range
 * keeps how wide it was when the owner changes the price.
 */
export function restyle(card: Quote, style: LearningStyle | undefined): Quote {
  const next = style ?? card.style ?? 'firm';
  const { style: _style, range, ...firm } = card;
  if (next === 'firm') return firm;
  if (next === 'estimate') return { ...firm, style: 'estimate' };
  const total = quoteTotal(card);
  const before = range && card.style === 'range' ? range : null;
  const middle = before ? (before.lowCents + before.highCents) / 2 : 0;
  const spread = before && middle ? (before.highCents - before.lowCents) / 2 / middle : 0.15;
  return { ...firm, style: 'range', range: rangeAround(total, spread) };
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

/** "$380 to $460" for a range, or the total. */
export function priceText(card: Partial<Quote> | null | undefined, totalCents: number) {
  return card?.style === 'range' && card.range
    ? `${money(card.range.lowCents)} to ${money(card.range.highCents)}`
    : money(totalCents);
}

/** A new card's price fields in this style. A firm price needs none. */
export function pricedAs(
  style: LearningStyle,
  totalCents: number,
  spread: number,
): Pick<Quote, 'style' | 'range'> {
  if (style === 'estimate') return { style: 'estimate' };
  if (style === 'range' && totalCents > 0)
    return { style: 'range', range: rangeAround(totalCents, spread) };
  return {};
}
