import { api, json } from './api';
import type { Profile } from './account';
import type { Quote } from './quote';

export type QuoteStatus = 'review' | 'sent' | 'accepted' | 'visit_requested' | 'declined' | 'void';

export interface QuoteListItem {
  id: string;
  number: number;
  status: QuoteStatus;
  customer: string;
  serviceName: string;
  totalCents: number;
  reviewReason: string;
  test: boolean;
  createdAt: string;
}

export interface Home {
  business: { name: string; slug: string };
  counts: { needsOk: number; sentThisMonth: number; acceptedThisMonth: number };
  waiting: QuoteListItem[];
  autoSend: boolean;
  autoSendLimitCents: number;
  websiteDomain: string;
}

export interface QuoteCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ThreadMessage {
  id: string;
  from: 'customer' | 'assistant' | 'owner';
  kind: 'text' | 'status';
  text: string;
  photos: { id: string; url: string }[];
  createdAt?: string;
}

export interface QuoteDetail extends QuoteListItem {
  customerEmail: string | null;
  summary: string;
  card: Quote;
  reasoning: string;
  confidence: string;
  checks: QuoteCheck[];
  messages: ThreadMessage[];
}

export type QuoteFilter = 'review' | 'sent' | 'accepted' | 'all';

export const loadHome = () => api<Home>('/app/home');
export const listQuotes = (filter: QuoteFilter) =>
  api<QuoteListItem[]>(`/app/quotes?filter=${filter}`);
export const loadQuote = (id: string) => api<QuoteDetail>(`/app/quotes/${id}`);
export const approveQuote = (id: string, card?: Quote) =>
  api<QuoteDetail>(`/app/quotes/${id}/approve`, {
    method: 'POST',
    ...json(card ? { card } : {}),
  });
export const messageCustomer = (id: string, text: string) =>
  api<QuoteDetail>(`/app/quotes/${id}/messages`, { method: 'POST', ...json({ text }) });
export const declineQuote = (id: string, message: string) =>
  api<QuoteDetail>(`/app/quotes/${id}/decline`, { method: 'POST', ...json({ message }) });

export interface Settings {
  autoSend: boolean;
  autoSendLimitCents: number;
  limitText: string;
}
export const saveSettings = (patch: Partial<Pick<Settings, 'autoSend' | 'autoSendLimitCents'>>) =>
  api<Settings>('/app/settings', { method: 'PATCH', ...json(patch) });

export interface Billing {
  provider: 'local' | 'stripe';
  configured: boolean;
  status: string;
  trial: { quoteLimit: number; remainingQuotes: number };
  deliveredQuotes: number;
  usage: { billableQuotes: number; feesCents: number; month: string };
  tariff: { basisPoints: number; minimumFeeCents: number; maximumFeeCents: number };
  spendingCapCents: number;
  subscription: { status: string; cancelAtPeriodEnd: boolean; periodEnd: string | null } | null;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
  canSend: boolean;
  reason: string;
}

export const loadBilling = () => api<Billing>('/app/billing');
export const saveSpendingCap = (spendingCapCents: number) =>
  api('/billing', { method: 'PATCH', ...json({ spendingCapCents }) });
export const startCheckout = () =>
  api<{ url: string }>('/billing/checkout', { method: 'POST', ...json({}) });
export const openBillingPortal = () =>
  api<{ url: string }>('/billing/portal', { method: 'POST', ...json({}) });
export const deleteAccount = (password: string, confirmation: string) =>
  api('/account', { method: 'DELETE', ...json({ password, confirmation }) });
export const loadOwnerProfile = () => api<Profile>('/app/profile');
