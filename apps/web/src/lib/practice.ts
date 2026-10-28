import { api, json } from './api';
import type { Discount, Quote, QuoteLine } from './quote';

export type Tone = 'canary' | 'pink' | 'blue';

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
  customer: { name: string; firstName: string; initials: string; place: string; tone: Tone } | null;
  serviceName: string | null;
  /** The service the owner asked to practice, if they picked one. */
  focus: string | null;
  suggestions: string[];
  messages: PracticeMessage[];
  outcome: 'quote' | 'site-visit' | null;
  quote: Quote | null;
  siteVisitReason: string | null;
  /** The AI's private guess. Shown only after the owner answers. */
  shadow: { cents: number; siteVisit: boolean; reason: string; confidence: string } | null;
  insights: { id: string; text: string }[];
  finished: boolean;
}

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
 * Another practice customer once setup's three are done, for one service if given. An unfinished
 * one comes back instead.
 */
export const morePractice = (service?: string | null) =>
  api<{ runId: string; state: PracticeState }>('/onboarding/practice/more', {
    method: 'POST',
    ...json(service ? { service } : {}),
  });

/** The practice runs, with one of them swapped for a newer copy. */
export function withRun(state: PracticeState, run: PracticeRun): PracticeState {
  const runs = state.runs.map((item) => (item.id === run.id ? run : item));
  return { ...state, runs, finished: runs.filter((item) => item.finished).length };
}

export function typingDelay(text = ''): number {
  return Math.min(2200, 700 + text.length * 14);
}
