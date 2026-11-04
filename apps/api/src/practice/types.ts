import { z } from 'zod';

/** One thing the practice customer knows. The owner only learns it by asking. */
export type Fact = {
  /** Short lowercase id, like "size" or "access". */
  key: string;
  /** How it reads in "Asks about ___", like "the surface" or "how dirty it is". */
  label: string;
  /** How the owner would ask it, like "How big is the area?" */
  question: string;
  answer: string;
  /** The customer's photos show it, like the size, the state it's in or a second story. */
  visible?: boolean;
};

export type PracticePhoto = {
  scene: string;
  photoId: string | null;
  /** Which of the project's places it's of, the first when left out. */
  place?: number;
};

/** The photos a customer opens with, chosen by the server so the mix stays real. */
export type PhotoSet = 'overview' | 'overview_detail' | 'two_parts';

/** The job a practice customer has in mind. They arrive with it and it never changes. */
export type Project = {
  /** What they want done, in one sentence. */
  summary: string;
  /** What this job is here to teach about the owner's prices. */
  teaches: string;
  /** What the photos have to make plain for the owner to price it. */
  shows: string[];
  /** Where the work is, almost always one place. Each photo of a place looks like that place. */
  places: { name: string; look: string }[];
  photoSet: PhotoSet;
};

/** How far the job is from the business: miles for US dollar businesses, km otherwise. */
export type Distance = {
  value: number;
  unit: 'mi' | 'km';
  /** The owner's location it's measured from, as they typed it. */
  from?: string;
};

/** A fictional customer request, written for this business's trade. */
export type PracticeScenario = {
  firstName: string;
  lastInitial: string;
  place: string;
  serviceName: string;
  opener: string;
  facts: Fact[];
  photos: PracticePhoto[];
  /** Held back until asked for. New customers have none: the photo asked for is made then. */
  extraPhoto: PracticePhoto & { text: string };
  /** What they came for. Older customers and the demo's don't have one. */
  project?: Project;
  /** What kind of job they were picked for (src/pricing/next-job.ts), so it isn't asked again. */
  pick?: string;
  suggestions: string[];
  siteVisitLikely: boolean;
  siteVisitCue: string;
  acceptReply: string;
  siteVisitReply: string;
  /** What they say when the owner turns the job down. Older customers say DECLINE_REPLY. */
  declineReply?: string;
  /** Set for the demo customers, which answer from fixed patterns instead of the AI. */
  demoId?: string;
  /** The job's main size as a number, like 550 and "sq ft". Older customers don't have it. */
  quantity?: number | null;
  unit?: string;
  /** What kind of request this was written to be, so the next one can be different. */
  situation?: string;
  /** How far the job is from the owner. Older customers don't have it. */
  distance?: Distance | null;
  /** The checked library entry this customer was copied from (src/practice/library.ts). */
  libraryId?: string;
};

export const discountSchema = z
  .object({
    kind: z.enum(['amount', 'percent']),
    value: z.number().int().min(1).max(100_000_000),
    reason: z.string().trim().max(160).default(''),
  })
  .strict()
  .refine((discount) => discount.kind === 'amount' || discount.value <= 100, {
    message: 'A percent discount can’t be more than 100%.',
  });
export type Discount = z.infer<typeof discountSchema>;

export const lineSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1, 'Name each line.').max(120),
    amountCents: z.number().int().min(1).max(100_000_000),
  })
  .strict();
export type QuoteLine = z.infer<typeof lineSchema>;

/** What the owner fills in on the quote builder. The server adds the number and date. */
export const quoteDraftSchema = z
  .object({
    lines: z.array(lineSchema).min(1, 'Add at least one priced line.').max(20),
    discount: discountSchema.nullable().default(null),
    start: z.string().trim().max(40).default(''),
    duration: z.string().trim().max(60).default(''),
    included: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
    excluded: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
    validDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(14),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
export type QuoteDraft = z.infer<typeof quoteDraftSchema>;

export type Quote = QuoteDraft & {
  number: number;
  customer: string;
  place: string;
  issuedAt: string;
  /** Set while the service is still learning, if the owner sends ranges or estimates until then. */
  style?: 'range' | 'estimate';
  /** What the customer sees instead of the total, with style 'range'. */
  range?: { lowCents: number; highCents: number };
  /** What the price is for: the size and the details it was priced on (jobFacts). */
  assumes?: string[];
  /**
   * Conditions and extras the customer couldn't settle, and what each would change the price by
   * (ifPrices in src/pricing/formula-draft.ts). The total doesn't include them.
   */
  ifs?: { when: string; cents: number; each?: boolean }[];
};

/** The AI's own quote for the same request, made before it sees the owner's. */
export type DraftedQuote = {
  decision: 'quote' | 'site_visit';
  reason: string;
  lines: { label: string; amountCents: number }[];
  discount: Discount | null;
  start: string;
  duration: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
};

/** What drafted a quote: the model and instructions, and what the server priced it from. */
export type DraftEngine = {
  provider: string;
  model: string | null;
  promptVersion: string;
  /** The main work at the owner's usual rate, when the size and their history allowed it. */
  estimateCents: number | null;
  estimateBasis: string;
  estimateSolid: boolean;
  /** Other businesses' rate was offered because this owner had never priced the service. */
  startingPoint: boolean;
  examples: { pastJobs: number; practice: number; liveQuotes: number };
  referencePhotos: number;
  /** Priced from the owner's formula, with the AI only reading the request. */
  formula?: boolean;
};

/**
 * The Charm's own price for a practice job, before it sees the owner's. `withheld` when it doesn't
 * guess yet: too few priced customers for a formula (`toGo` more), a service it hasn't seen
 * priced, or a formula still being worked out. Cents are 0 then.
 */
export type Shadow = DraftedQuote & {
  cents: number;
  engine?: DraftEngine;
  withheld?: 'learning' | 'service' | 'working';
  toGo?: number;
};

export type Insight = { id: string; text: string };

export function subtotal(quote: { lines: { amountCents: number }[] }): number {
  return quote.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

export function discountCents(quote: {
  lines: { amountCents: number }[];
  discount: Discount | null;
}): number {
  if (!quote.discount) return 0;
  const base = subtotal(quote);
  return quote.discount.kind === 'amount'
    ? Math.min(quote.discount.value, base)
    : Math.round((base * quote.discount.value) / 100);
}

/** The server always does the math. A model's totals are never used. */
export function quoteTotal(quote: {
  lines: { amountCents: number }[];
  discount: Discount | null;
}): number {
  return Math.max(0, subtotal(quote) - discountCents(quote));
}

export function gapPercent(guessCents: number, ownerCents: number): number | null {
  return ownerCents > 0 ? Math.round((Math.abs(guessCents - ownerCents) / ownerCents) * 100) : null;
}
