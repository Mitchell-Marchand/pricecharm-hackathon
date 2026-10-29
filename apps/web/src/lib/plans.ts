import { money } from './util';

/** The prices the API charges, read from it so nothing on the site can drift from billing. */
export interface Pricing {
  currency: 'USD';
  perQuoteCents: number;
  accepted: { basisPoints: number; minimumFeeCents: number; maximumFeeCents: number };
  subscription: {
    monthlyCents: number;
    yearlyCents: number;
    trialDays: number;
    includedQuotes: number;
    overageCents: number;
  };
  trialQuotes: number;
  /** Quote fees in the 30 days after the first card stop here. An older API leaves it out. */
  firstMonthMaxCents?: number;
}

/** The API's defaults, shown only if it can't be reached. */
export const DEFAULT_PRICING: Pricing = {
  currency: 'USD',
  perQuoteCents: 200,
  accepted: { basisPoints: 100, minimumFeeCents: 100, maximumFeeCents: 2500 },
  subscription: {
    monthlyCents: 4900,
    yearlyCents: 49900,
    trialDays: 7,
    includedQuotes: 100,
    overageCents: 100,
  },
  trialQuotes: 0,
  firstMonthMaxCents: 4900,
};

export type Plan = 'per_quote' | 'per_accepted' | 'monthly' | 'yearly';
/** What an owner picks between. The subscription is one choice, paid monthly or yearly. */
export type PlanChoice = 'per_quote' | 'per_accepted' | 'subscription';

export const choiceOf = (plan: Plan): PlanChoice =>
  plan === 'monthly' || plan === 'yearly' ? 'subscription' : plan;

const percent = (pricing: Pricing) => `${pricing.accepted.basisPoints / 100}%`;
const freeTime = (days: number) => (days === 7 ? 'week' : `${days} days`);

/** A plan in a few words: "$2 per quote", "$49 a month". */
export function planName(plan: Plan, pricing: Pricing): string {
  if (plan === 'per_quote') return `${money(pricing.perQuoteCents)} per quote`;
  if (plan === 'per_accepted') return `${percent(pricing)} when they say yes`;
  return plan === 'monthly'
    ? `${money(pricing.subscription.monthlyCents)} a month`
    : `${money(pricing.subscription.yearlyCents)} a year`;
}

/** What the plan costs, in a sentence or two. The free week only for those who still have it. */
export function planDetail(plan: Plan, pricing: Pricing, freeWeek = true): string {
  if (plan === 'per_quote')
    return `Nothing up front. You pay ${money(pricing.perQuoteCents)} each time a customer gets a quote.`;
  if (plan === 'per_accepted')
    return `Nothing up front. You pay ${percent(pricing)} of a quote when the customer accepts it, at least ${money(pricing.accepted.minimumFeeCents)} and at most ${money(pricing.accepted.maximumFeeCents)}.`;
  const { trialDays, includedQuotes, overageCents } = pricing.subscription;
  return `${freeWeek ? `First ${freeTime(trialDays)} free. ` : ''}${includedQuotes} quotes a month included, then ${money(overageCents)} each. Cancel any time.`;
}
