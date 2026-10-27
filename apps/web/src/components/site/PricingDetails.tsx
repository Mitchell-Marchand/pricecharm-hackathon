'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEFAULT_PRICING, planDetail, planName, type Plan, type Pricing } from '@/lib/plans';
import { money } from '@/lib/util';

/** The numbers come from the API, so this page can't drift from what billing charges. */
export function PricingDetails() {
  const [pricing, setPricing] = useState<Pricing>();
  useEffect(() => {
    api<Pricing>('/pricing')
      .then(setPricing)
      .catch(() => setPricing(DEFAULT_PRICING));
  }, []);
  const plans: { plan: Plan; label: string; name?: string }[] = [
    { plan: 'per_quote', label: 'Per quote' },
    { plan: 'per_accepted', label: 'When they say yes' },
    {
      plan: 'monthly',
      label: 'Subscription',
      name: pricing
        ? `${money(pricing.subscription.monthlyCents)} a month or ${money(pricing.subscription.yearlyCents)} a year`
        : undefined,
    },
  ];
  return (
    <dl className="mt-10 grid gap-4 sm:grid-cols-3">
      <div className="rounded-md border border-line bg-surface p-5 sm:col-span-3">
        <dt className="t-label text-muted">To train it</dt>
        <dd className="mt-2">
          <p className="t-h2">Free</p>
          <p className="mt-2 text-ink-2">
            {pricing && pricing.trialQuotes > 0
              ? `Set it up, practice and try it as a customer as much as you like. Your first ${pricing.trialQuotes} customer quotes are free too.`
              : 'Set it up, practice and try it as a customer as much as you like.'}
          </p>
        </dd>
      </div>
      {plans.map(({ plan, label, name }) => (
        <div key={plan} className="rounded-md border border-line bg-surface p-5">
          <dt className="t-label text-muted">{label}</dt>
          <dd className="mt-2">
            <p className="t-h3">{pricing ? (name ?? planName(plan, pricing)) : '…'}</p>
            <p className="mt-2 text-ink-2">
              {pricing ? planDetail(plan, pricing) : 'Loading the current prices…'}
            </p>
          </dd>
        </div>
      ))}
      <div className="rounded-md border border-line bg-surface p-5 sm:col-span-3">
        <dt className="t-label text-muted">What counts as a quote</dt>
        <dd className="mt-2 text-ink-2">
          A quote counts when a customer who confirmed their email receives it, whether it went out
          on its own or you approved it first. It counts as accepted when they tap Accept on it.
          Practice quotes, your own tests and sending the same quote again don’t count. You can
          switch plans any time, and set a monthly limit on fees: when you reach it, new requests
          wait for you instead.
        </dd>
      </div>
    </dl>
  );
}
