import { api, json } from './api';
import type {
  AgentReadiness,
  CharmSettings,
  LearningStyle,
  Profile,
  ServiceReadiness,
} from './account';
import { money } from './util';
import { DEFAULT_PRICING, type Plan, type PlanChoice, type Pricing } from './plans';
import type { Logo } from './chat';
import type { Quote } from './quote';

export type QuoteStatus =
  'review' | 'sent' | 'accepted' | 'visit_requested' | 'lost' | 'expired' | 'declined' | 'void';

export interface QuoteListItem {
  id: string;
  number: number;
  status: QuoteStatus;
  customer: string;
  serviceName: string;
  totalCents: number;
  /** What the customer sees instead of the total, for a range quote. Missing from older APIs. */
  range?: { lowCents: number; highCents: number } | null;
  reviewReason: string;
  test: boolean;
  createdAt: string;
}

export interface Home {
  business: { name: string; slug: string };
  counts: { needsOk: number; sentThisMonth: number; acceptedThisMonth: number };
  waiting: QuoteListItem[];
  autoSend: boolean;
  /** Null for no limit. */
  autoSendLimitCents: number | null;
  websiteDomain: string;
  /** Missing from an API older than this page, as when web and API deploy a moment apart. */
  readiness?: AgentReadiness;
  settings?: CharmSettings;
  services?: ServiceReadiness[];
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
  /** The job as fields: "600 sq ft; heavy moss; wants it next week". */
  details: string;
  /** What the price started from, like your usual rate for this size. */
  basis: string;
  /** Why the customer didn't go ahead, when they said. */
  outcome: { reason: string; note: string } | null;
  /** The words on the customer's accept button. Missing from older APIs. */
  acceptLabel?: string | null;
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
export const approveQuote = (id: string, card?: Quote, style?: LearningStyle) =>
  api<QuoteDetail>(`/app/quotes/${id}/approve`, {
    method: 'POST',
    ...json({ ...(card ? { card } : {}), ...(style ? { style } : {}) }),
  });
export const messageCustomer = (id: string, text: string) =>
  api<QuoteDetail>(`/app/quotes/${id}/messages`, { method: 'POST', ...json({ text }) });
export const declineQuote = (id: string, message: string) =>
  api<QuoteDetail>(`/app/quotes/${id}/decline`, { method: 'POST', ...json({ message }) });

/** What customers see that the owner can change. Empty text means the default. */
export interface QuotePage {
  logo: Logo | null;
  contactName: string;
  /** The name the chat uses while contactName is empty. */
  ownerFirstName: string;
  acceptedMessage: string;
  visitMessage: string;
  /** What customers read while a message is empty. */
  defaults: { acceptedMessage: string; visitMessage: string };
  /** Empty lets PriceCharm try wordings. */
  acceptLabel: string;
  wordings: string[];
}
export type QuotePageText = Pick<
  QuotePage,
  'contactName' | 'acceptedMessage' | 'visitMessage' | 'acceptLabel'
>;
export const loadQuotePage = () => api<QuotePage>('/app/quote-page');
export const saveQuotePage = (patch: Partial<QuotePageText>) =>
  api<QuotePage>('/app/quote-page', { method: 'PATCH', ...json(patch) });
export function uploadLogo(file: File) {
  const body = new FormData();
  body.append('file', file);
  return api<QuotePage>('/app/quote-page/logo', { method: 'POST', body });
}
export const removeLogo = () => api<QuotePage>('/app/quote-page/logo', { method: 'DELETE' });

export interface Settings extends CharmSettings {
  /** "$1,500", or empty with no limit. */
  limitText: string;
}
export const saveSettings = (patch: Partial<CharmSettings>) =>
  api<Settings>('/app/settings', { method: 'PATCH', ...json(patch) });

export interface Billing {
  provider: 'local' | 'stripe';
  configured: boolean;
  /** Null until they choose one, which comes before the card. */
  plan: Plan | null;
  /** A switch booked for the end of the paid period. */
  nextPlan: Plan | null;
  /** The order to show the choices in, random per business. */
  planOrder: PlanChoice[];
  pricing: Pricing;
  /** The subscription's free week is still theirs to use. */
  freeWeek: boolean;
  /**
   * The first-month max while they have it: no end date until a card is added, then 30 days.
   * Null once it's over.
   */
  firstMonth: { endsAt: string | null; feesCents: number; waivedCents: number } | null;
  periodEnd: string | null;
  coveredThisMonth: number;
  /** The quote link takes requests: deployed, and not paused. */
  linkOn: boolean;
  deployed: boolean;
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

/**
 * Billing with anything an older API leaves out filled in, as when the web app and the API deploy
 * a moment apart, so pages show what they can instead of breaking.
 */
function complete(billing: Billing): Billing {
  return {
    ...billing,
    plan: billing.plan ?? null,
    nextPlan: billing.nextPlan ?? null,
    planOrder: billing.planOrder?.length
      ? billing.planOrder
      : ['per_quote', 'per_accepted', 'subscription'],
    pricing: billing.pricing ?? DEFAULT_PRICING,
    freeWeek: billing.freeWeek ?? true,
    firstMonth: billing.firstMonth ?? null,
    periodEnd: billing.periodEnd ?? null,
    coveredThisMonth: billing.coveredThisMonth ?? 0,
    // Before deploying existed, a link with billing in place was already taking requests.
    linkOn: billing.linkOn ?? true,
    deployed: billing.deployed ?? true,
  };
}

export const loadBilling = () => api<Billing>('/app/billing').then(complete);
export const saveSpendingCap = (spendingCapCents: number) =>
  api('/billing', { method: 'PATCH', ...json({ spendingCapCents }) });
/** Where to add a card. From setup, it comes back to setup's last screen. */
export const startCheckout = (from?: 'setup') =>
  api<{ url: string }>('/billing/checkout', {
    method: 'POST',
    ...json(from ? { from } : {}),
  });
/** Picks or switches the plan. Off a paid subscription, it waits for the end of the period. */
export const choosePlan = (plan: Plan) =>
  api<Billing>('/app/billing/plan', { method: 'POST', ...json({ plan }) }).then(complete);
/** Deploys the agent: the quote link starts taking requests. Needs a plan and a card. */
export const deployAgent = () =>
  api<Billing>('/app/deploy', { method: 'POST', ...json({}) }).then(complete);
/** Pauses the quote link, or turns it back on. */
export const setLinkOn = (on: boolean) =>
  api<Billing>('/app/link', { method: 'PATCH', ...json({ on }) }).then(complete);
/** Billing as Stripe has it right now, for coming back from adding a card. */
export const syncBilling = () =>
  api<Billing>('/app/billing/sync', { method: 'POST', ...json({}) }).then(complete);
export const openBillingPortal = () =>
  api<{ url: string }>('/billing/portal', { method: 'POST', ...json({}) });
export const deleteAccount = (password: string, confirmation: string) =>
  api('/account', { method: 'DELETE', ...json({ password, confirmation }) });
export const loadOwnerProfile = () => api<Profile>('/app/profile');

/** The fee in words, from the account's own tariff: "1% of each quote, at least $1 and at most $25". */

/** One waiting quote, as the one-tap link in a "needs your OK" email shows it. */
export interface ApprovalView {
  quoteId: string;
  business: string;
  customer: string;
  serviceName: string;
  status: 'waiting' | 'declined' | 'sent';
  totalCents: number;
  card: Quote;
  details: string;
  reasons: string[];
  expiresAt: string;
}

export const viewApproval = (id: string, token: string) =>
  api<ApprovalView>(`/approve/${id}/view`, { method: 'POST', ...json({ token }) });
/** Sends it as it is. The link can't do anything else. */
export const approveFromLink = (id: string, token: string) =>
  api<ApprovalView>(`/approve/${id}`, { method: 'POST', ...json({ token }) });
