import { api, json } from './api';
import type { PracticeResult } from './practice';
import type { Quote } from './quote';
import type { Currency } from './currency';

/** One real quote the owner reviewed: the Charm's draft against what they sent. */
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

/** How well the Charm knows one service's prices, and what it still needs. */
export interface ServiceReadiness {
  service: string;
  /** Fully trained. */
  ready: boolean;
  sizedPrices: number;
  checked: number;
  matched: number;
  /** Sized jobs it still needs before its guesses can be checked. */
  jobsToGo: number;
  /** Close guesses it still needs among its latest ones. None once it's ready. */
  matchesToGo: number;
  /** "150 to 1,800 sq ft": the sizes it knows. Much bigger or smaller jobs wait for the owner. */
  covers: string;
  /** 0 to 100: how well it knows this service. */
  progress: number;
  /** What it still needs. Empty once it's ready. */
  reason: string;
}

/** One thing that raises the score: sized jobs to add, or practice for one service. */
export interface ReadinessStep {
  service: string;
  action: 'job' | 'practice';
  /** How many more of it. Missing from older APIs. */
  count?: number;
  /** Points one more adds. */
  gain: number;
}

/** How well the Charm knows the owner's work. Never needed to go live. */
export interface AgentReadiness {
  /** 0 to 100. 100 once every service is fully trained; the services they do most count most. */
  score: number;
  /** The step that would raise it most. */
  next: ReadinessStep | null;
  /** One step for each service still learning, the biggest first. Missing from older APIs. */
  steps?: ReadinessStep[];
  /** About how many more practice customers would take it to 85%. Missing from older APIs. */
  toWellTrained?: number;
}

/** What goes out while a service is still learning. */
export type LearningStyle = 'range' | 'estimate' | 'firm';

/** How the owner's Charm quotes. */
export interface CharmSettings {
  /** Quotes go out without waiting for the owner. */
  autoSend: boolean;
  /** Quotes over this always wait. Null for no limit. */
  limitCents: number | null;
  /** A service gets firm prices from this score on. */
  trainedPercent: number;
  learningStyle: LearningStyle;
  /** A draft this close to the owner's price, in percent, counts as a match while it learns. */
  closePercent: number;
}

/** Settings from an API older than this page: what it did before there were any. */
export const OLD_SETTINGS: CharmSettings = {
  autoSend: false,
  limitCents: null,
  trainedPercent: 100,
  learningStyle: 'firm',
  closePercent: 15,
};

/** The Charm card's data. */
export interface CharmView {
  /** Missing from an API older than this page. */
  businessId?: string;
  readiness: AgentReadiness;
  services: ServiceReadiness[];
  settings: CharmSettings;
}

export const loadCharm = () => api<CharmView>('/onboarding/charm');
export const saveCharm = (patch: Partial<CharmSettings>) =>
  api<CharmView>('/onboarding/charm', { method: 'PATCH', ...json(patch) });

export interface Profile {
  results: PracticeResult[];
  /** How well it knows each service. */
  services: ServiceReadiness[];
  autoSendReady: boolean;
  /** Missing from an API older than this page. */
  settings?: CharmSettings;
  /** Missing from an API older than this page, as when web and API deploy a moment apart. */
  readiness?: AgentReadiness;
  /** The Charm's record on real quotes the owner checked before sending. */
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
  /** What the business's quotes and fees are in. An older API leaves it out, for dollars. */
  business: { id: string; name: string; slug: string; currency?: Currency };
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
