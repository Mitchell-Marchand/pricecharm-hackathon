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
  /** Private to the owner and the AI. Never shown on the card. */
  note: string;
  issuedAt: string;
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
