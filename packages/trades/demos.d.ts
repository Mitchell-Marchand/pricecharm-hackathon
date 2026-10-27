export interface DemoOption {
  label: string;
  /** Scales the service's base price. */
  factor: number;
  /** How the answer reads on the quote line, after the service: "Move-out clean, 3 bedrooms". */
  line: string;
}

export interface DemoExtra {
  label: string;
  /** A line this answer adds to the quote. None means it adds nothing. */
  add?: { label: string; amountCents: number };
}

/** A quote a customer already accepted, for the rotating example at the top of the home page. */
export interface HeroExample {
  number: number;
  customer: { name: string; place: string; initials: string; tone: 'canary' | 'pink' | 'blue' };
  request: string;
  facts: string[];
  /** Bundled photo keys, for the trades that have sample photos. */
  photos?: ('patio-overview' | 'patio-stains')[];
  lines: { label: string; amountCents: number }[];
}

export interface Demo {
  tradeId: string;
  business: string;
  owner: string;
  area: string;
  /** Base price for each of the trade's services, for the middle answer to the size question. */
  prices: Record<string, number>;
  size: { ask: string; options: DemoOption[] };
  extra?: { ask: string; options: DemoExtra[] };
  start: string;
  duration: string;
  included: string[];
  excluded: string[];
  hero?: HeroExample;
}

export declare const DEMOS: Demo[];
export declare const DEMOS_BY_TRADE: Record<string, Demo>;
