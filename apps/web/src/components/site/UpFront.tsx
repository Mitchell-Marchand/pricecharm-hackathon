'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { guessCurrency } from '@/lib/currency';
import type { Pricing } from '@/lib/plans';
import { money } from '@/lib/util';

// The title and the text share one request.
let loading: Promise<Pricing> | null = null;

/**
 * The prices on the home page, in the visitor's own currency once the browser says where it is.
 * The page renders in dollars first, from the server.
 */
export function useVisitorPricing(initial: Pricing) {
  const [pricing, setPricing] = useState(initial);
  useEffect(() => {
    const guess = guessCurrency();
    if (guess === initial.currency) return;
    loading ??= api<Pricing>(`/pricing?currency=${guess}`);
    loading.then(setPricing).catch(() => {});
  }, [initial.currency]);
  return pricing;
}

export function UpFrontTitle({ pricing: initial }: { pricing: Pricing }) {
  const pricing = useVisitorPricing(initial);
  return <>{money(0, pricing.currency)} up front</>;
}

export function UpFrontText({ pricing: initial }: { pricing: Pricing }) {
  const pricing = useVisitorPricing(initial);
  const amount = (cents: number) => money(cents, pricing.currency);
  return (
    <>
      Pay {amount(pricing.perQuoteCents)} a quote, or {pricing.accepted.basisPoints / 100}% of the
      quotes customers accept. Or {amount(pricing.subscription.monthlyCents)} a month with the first
      week free. Setting up and practice are free.
    </>
  );
}
