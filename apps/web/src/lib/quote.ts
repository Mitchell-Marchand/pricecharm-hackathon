/** The quote card's data. Practice quotes, customer quotes and the landing page samples share it. */
export interface Discount {
  kind: 'amount' | 'percent';
  /** Cents for an amount, whole percent for a percentage. */
  value: number;
  reason: string;
}

export interface QuoteLine {
  id: string;
  label: string;
  amountCents: number;
}

export interface Quote {
  number: number;
  customer: string;
  place: string;
  lines: QuoteLine[];
  discount: Discount | null;
  start: string;
  duration: string;
  included: string[];
  excluded: string[];
  validDays: number;
  /** Private to the owner and the Charm. Never shown on the card. */
  note: string;
  issuedAt: string;
  /** Set while the service is still learning, if the owner sends ranges or estimates until then. */
  style?: 'range' | 'estimate';
  /** What the customer sees instead of the total, with style 'range'. */
  range?: { lowCents: number; highCents: number };
}

export function subtotal(quote: Pick<Quote, 'lines'>): number {
  return quote.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

export function discountCents(quote: Pick<Quote, 'lines' | 'discount'>): number {
  if (!quote.discount) return 0;
  const base = subtotal(quote);
  return quote.discount.kind === 'amount'
    ? Math.min(quote.discount.value, base)
    : Math.round((base * quote.discount.value) / 100);
}

export function total(quote: Pick<Quote, 'lines' | 'discount'>): number {
  return Math.max(0, subtotal(quote) - discountCents(quote));
}

/** The range a card shows, if it's a range quote. */
export function rangeOf(quote: Pick<Quote, 'style' | 'range'>) {
  return quote.style === 'range' && quote.range ? quote.range : null;
}

/** The line under a customer's quote, saying how firm the price is. */
export function quoteFootnote(quote: Pick<Quote, 'style' | 'range'>, owner: string) {
  if (rangeOf(quote))
    return `A price range from the photos and details you shared. ${owner} confirms the final price before starting.`;
  if (quote.style === 'estimate')
    return `An estimate from the photos and details you shared. ${owner} confirms the final price before starting.`;
  return 'Based on the photos and details you shared.';
}

/** A range around the total, rounded outward like the server's. */
function rangeAround(totalCents: number, spread: number) {
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

/** The card as it would go out in another price style. The server works out the real one. */
export function restyle(quote: Quote, style: 'firm' | 'range' | 'estimate'): Quote {
  const { style: _style, range, ...firm } = quote;
  if (style === 'firm') return firm;
  if (style === 'estimate') return { ...firm, style: 'estimate' };
  return { ...firm, style: 'range', range: rangeOf(quote) ?? rangeAround(total(quote), 0.15) };
}
