export type Screen = 'landing' | 'business' | 'jobs' | 'practice' | 'ready' | 'account' | 'live';

export interface Discount {
  kind: 'amount' | 'percent';
  /** Cents for an amount, whole percent for a percentage. */
  value: number;
  reason: string;
}

export interface Job {
  id: string;
  serviceName: string;
  description: string;
  priceCents: number | null;
  photos: string[];
  size: string;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: Discount | null;
  notes: string;
  source: 'manual' | 'invoice' | 'sample';
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
  note: string;
  issuedAt: string;
}

export interface ChatMessage {
  id: string;
  from: 'customer' | 'owner';
  text?: string;
  photos?: string[];
  quote?: Quote;
  siteVisit?: string;
}

export interface Insight {
  id: string;
  text: string;
}

export interface Run {
  scenarioId: string;
  messages: ChatMessage[];
  asked: string[];
  photoSent: boolean;
  outcome: null | 'quote' | 'site-visit';
  quote: Quote | null;
  siteVisitReason: string;
  shadowCents: number | null;
  shadowFlag: boolean;
  insights: Insight[];
  finished: boolean;
}

export interface Business {
  tradeId: string | null;
  customTrade: string;
  services: string[];
  customServices: string[];
  name: string;
  area: string;
  radius: string;
}

export interface Account {
  name: string;
  email: string;
  google: boolean;
}

export interface LiveSettings {
  website: string;
  style: 'floating' | 'inline';
  verified: boolean;
}

export interface State {
  screen: Screen;
  business: Business;
  jobs: Job[];
  runs: Run[];
  current: number;
  account: Account | null;
  live: LiveSettings;
  nextQuoteNumber: number;
}
