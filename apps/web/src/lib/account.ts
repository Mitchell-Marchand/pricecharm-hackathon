import { api, json } from './api';
import type { PracticeResult } from './practice';
import type { Quote } from './quote';

/** One real quote the owner reviewed: the AI's draft against what they sent. */
export interface ReviewedQuote {
  quoteId: string;
  customer: string;
  service: string;
  sentAt: string;
  draftCents: number | null;
  sentCents: number;
  gap: number | null;
  agree: boolean;
}

/** Whether one service's quotes can go out without the owner, and what it needs if not. */
export interface ServiceReadiness {
  service: string;
  ready: boolean;
  sizedPrices: number;
  checked: number;
  matched: number;
  /** Sized jobs it still needs before its guesses can be checked. */
  jobsToGo: number;
  /** Close guesses it still needs among its latest ones. None once it's ready. */
  matchesToGo: number;
  /** "150 to 1,800 sq ft": the sizes it sends on its own. Bigger or smaller jobs wait. */
  covers: string;
  /** Why its quotes wait for the owner. Empty once it's ready. */
  reason: string;
}

export interface Profile {
  asks: string[];
  prices: string[];
  /** Rates worked out from every job and quote with a size. */
  rates: string[];
  handoffs: string[];
  results: PracticeResult[];
  /** Each service's quotes go out on their own once it has learned the owner's prices for it. */
  services: ServiceReadiness[];
  autoSendReady: boolean;
  /** The AI's record on real quotes the owner checked before sending. */
  live: {
    reviewed: number;
    considered: number;
    agreed: number;
    recent: ReviewedQuote[];
  };
  liveQuotesLearned: number;
  autoSend: boolean;
  jobsCount: number;
  practiceCount: number;
  practiceQuotes: Quote[];
}

export interface Me {
  user: {
    id: string;
    name: string;
    firstName?: string;
    lastName?: string;
    email: string;
    emailVerified: boolean;
  };
  business: { id: string; name: string; slug: string };
}

export interface Share {
  slug: string;
  url: string;
  websiteDomain: string;
  widgetStyle: 'floating' | 'inline';
  embedCode: string;
}

export const loadProfile = () => api<Profile>('/onboarding/profile');
export const loadMe = () => api<Me>('/auth/me');
export const loadShare = () => api<Share>('/share');
export const saveShare = (patch: { website?: string; widgetStyle?: Share['widgetStyle'] }) =>
  api<Share>('/share', { method: 'PATCH', ...json(patch) });
export const sendInstructions = (email: string) =>
  api('/share/instructions', { method: 'POST', ...json({ email }) });
/** On a local run the API also returns the link's token, since no email is sent. */
/** A new confirmation email, with a fresh code and link. Locally both come back here instead. */
export const resendVerification = () =>
  api<{ devToken?: string; devCode?: string | null }>('/auth/request-verification', {
    method: 'POST',
    ...json({}),
  });
export const confirmEmailCode = (code: string) =>
  api('/auth/verify-email-code', { method: 'POST', ...json({ code }) });

export function register(
  body: { firstName: string; lastName: string; email: string; password: string },
  headers: Record<string, string>,
) {
  return api<Me & { devCode?: string | null }>('/auth/register', {
    method: 'POST',
    headers,
    ...json(body),
  });
}

export const login = (email: string, password: string) =>
  api<Me>('/auth/login', { method: 'POST', ...json({ email, password }) });
export const logout = () => api('/auth/logout', { method: 'POST', ...json({}) });
export const forgotPassword = (email: string) =>
  api<{ devToken?: string }>('/auth/forgot-password', { method: 'POST', ...json({ email }) });
export const resetPassword = (token: string, password: string) =>
  api('/auth/reset-password', { method: 'POST', ...json({ token, password }) });
export const verifyEmail = (token: string) =>
  api('/auth/verify-email', { method: 'POST', ...json({ token }) });

/** The one-time token in a link from one of our emails: /reset-password#token=… */
export function tokenFromLink(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
