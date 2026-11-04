import { api, json } from './api';
import type { Discount, Quote, QuoteLine } from './quote';
import type { RuleInput, TurnDownKind, TurnDownRule } from './turn-downs';

export type Tone = 'canary' | 'pink' | 'blue';

/** How far the job is from the business: miles for US dollar businesses, km otherwise. */
export interface Distance {
  value: number;
  unit: 'mi' | 'km';
  /** The owner's location it's from, as they typed it. */
  from?: string;
}

export interface PracticeMessage {
  id: string;
  from: 'customer' | 'owner';
  text: string;
  photos: { id: string; url: string }[];
  quote: Quote | null;
  siteVisit: string | null;
}

export interface PracticeRun {
  id: string;
  position: number;
  status: 'preparing' | 'ready' | 'failed' | 'finished';
  failure: string | null;
  customer: {
    name: string;
    firstName: string;
    initials: string;
    place: string;
    /** Missing from older APIs, and null for customers from before distances. */
    distance?: Distance | null;
    tone: Tone;
  } | null;
  serviceName: string | null;
  /** The service the owner asked to practice, if they picked one. */
  focus: string | null;
  suggestions: string[];
  messages: PracticeMessage[];
  outcome: 'quote' | 'site-visit' | 'declined' | null;
  quote: Quote | null;
  siteVisitReason: string | null;
  /** The AI's private guess. Shown only after the owner answers. */
  shadow: {
    cents: number;
    siteVisit: boolean;
    reason: string;
    confidence: string;
    /**
     * Why it didn't guess: too few priced customers yet (`toGo` more before this one), a service
     * it hadn't seen priced, or a formula still being worked out. Missing from older APIs.
     */
    withheld?: 'learning' | 'service' | 'working' | null;
    toGo?: number | null;
  } | null;
  insights: { id: string; text: string }[];
  /**
   * Other businesses' combined rate for this service, when the owner charged clearly less than
   * it. Missing from older APIs.
   */
  market?: {
    trade: string;
    unit: string;
    businesses: number;
    centsPerUnit: number;
    ownerCentsPerUnit: number;
  } | null;
  /** Set once the owner turned this one down: why, and the rule or minimum it saved. */
  turnDown?: {
    reason: TurnDownKind;
    reasonText: string;
    /** The rule as it stands now. Null for a minimum, or once it's been taken out. */
    rule: TurnDownRule | null;
    minimumCents: number | null;
    removed: boolean;
  } | null;
  /** The customer is taking a photo the owner asked for. */
  takingPhoto?: boolean;
  /**
   * What the Charm asked the owner about their prices once they'd sent the quote, with tap
   * answers, "no" last. Missing from older APIs.
   */
  question?: {
    ask: string;
    answers: string[];
    answer: string | null;
    skipped: boolean;
    /** The note the answer was saved as. */
    note: string | null;
  } | null;
  finished: boolean;
}

/** What the "Why not?" sheet fills in from the practice customer. */
export interface DeclinePrefill {
  size: { quantity: number; unit: string } | null;
  service: string;
  extras: string[];
  distance: { value: number; unit: 'mi' | 'km' } | null;
}
export type DeclineInput = RuleInput | { kind: 'minimum'; minimumCents: number };

export interface PracticeResult {
  runId: string;
  customer: string;
  guessCents: number | null;
  ownerCents: number | null;
  gap: number | null;
  agree: boolean;
  siteVisit: boolean;
  aiFlagged: boolean;
}

export interface PracticeState {
  count: number;
  runs: PracticeRun[];
  current: number;
  finished: number;
  results: PracticeResult[];
  /** How close a guess has to come to count, in percent. Missing from older APIs. */
  closePercent?: number;
}

export type QuoteDraft = {
  lines: QuoteLine[];
  discount: Discount | null;
  start: string;
  duration: string;
  included: string[];
  excluded: string[];
  validDays: number;
  note: string;
};

export const preparePractice = () =>
  api<PracticeState>('/onboarding/practice/prepare', { method: 'POST', ...json({}) });
export const loadPractice = () => api<PracticeState>('/onboarding/practice');
export const sendPracticeMessage = (runId: string, text: string) =>
  api<{ run: PracticeRun; nudge: boolean }>(`/onboarding/practice/${runId}/messages`, {
    method: 'POST',
    ...json({ text }),
  });
export const requestGuess = (runId: string) =>
  api(`/onboarding/practice/${runId}/guess`, { method: 'POST', ...json({}) });
export const sendPracticeQuote = (runId: string, quote: QuoteDraft) =>
  api<PracticeRun>(`/onboarding/practice/${runId}/quote`, { method: 'POST', ...json(quote) });
export const declinePrefill = (runId: string) =>
  api<DeclinePrefill>(`/onboarding/practice/${runId}/decline`);
/** Turns the customer down and saves why, as a rule or the owner's minimum. */
export const declinePractice = (runId: string, input: DeclineInput) =>
  api<PracticeRun>(`/onboarding/practice/${runId}/decline`, { method: 'POST', ...json(input) });
/** Why the owner priced a practice quote as they did, added after it went. */
export const explainQuote = (runId: string, text: string) =>
  api<PracticeRun>(`/onboarding/practice/${runId}/explanation`, {
    method: 'PATCH',
    ...json({ text }),
  });
/** The owner's answer to the question their Charm asked about their prices, or a skip. */
export const answerQuestion = (runId: string, reply: { answer: string } | { skip: true }) =>
  api<PracticeRun>(`/onboarding/practice/${runId}/question`, { method: 'POST', ...json(reply) });
export const fixInsight = (runId: string, insightId: string, text: string) =>
  api<PracticeRun>(`/onboarding/practice/${runId}/insights/${insightId}`, {
    method: 'PATCH',
    ...json({ text }),
  });
export const retryPractice = (runId: string) =>
  api<PracticeState>(`/onboarding/practice/${runId}/retry`, { method: 'POST', ...json({}) });
export const finishPractice = () =>
  api<PracticeState>('/onboarding/practice/done', { method: 'POST', ...json({}) });
/**
 * Another practice customer once setup's are done, for one service if given. An unfinished
 * one comes back instead.
 */
export const morePractice = (service?: string | null) =>
  api<{ runId: string; state: PracticeState }>('/onboarding/practice/more', {
    method: 'POST',
    ...json(service ? { service } : {}),
  });

/** "12 mi away", "20 km away", kept on one line. */
export function distanceText(distance: Distance | null | undefined): string {
  return distance ? `${distance.value} ${distance.unit} away` : '';
}

/** The practice runs, with one of them swapped for a newer copy. */
export function withRun(state: PracticeState, run: PracticeRun): PracticeState {
  const runs = state.runs.map((item) => (item.id === run.id ? run : item));
  return { ...state, runs, finished: runs.filter((item) => item.finished).length };
}

export function typingDelay(text = ''): number {
  return Math.min(2200, 700 + text.length * 14);
}
