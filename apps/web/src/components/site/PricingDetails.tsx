'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEFAULT_PRICING, planDetail, type Pricing } from '@/lib/plans';
import { money } from '@/lib/util';

type Card = {
  label: string;
  /** The two plans that charge per quote have nothing to pay up front. */
  upFront: boolean;
  price: string;
  unit: string;
  rate: string;
  detail: string;
};

/** The numbers come from the API, so this page can't drift from what billing charges. */
export function PricingDetails() {
  const [pricing, setPricing] = useState<Pricing>();
  useEffect(() => {
    api<Pricing>('/pricing')
      .then(setPricing)
      .catch(() => setPricing(DEFAULT_PRICING));
  }, []);
  const loading = '…';
  const cards: Card[] = [
    {
      label: 'Per quote',
      upFront: true,
      price: '$0',
      unit: 'up front',
      rate: pricing ? `${money(pricing.perQuoteCents)} per quote` : loading,
      detail: 'Each time a customer gets a quote from you. No monthly fee.',
    },
    {
      label: 'When they say yes',
      upFront: true,
      price: '$0',
      unit: 'up front',
      rate: pricing ? `${pricing.accepted.basisPoints / 100}% of accepted quotes` : loading,
      detail: pricing
        ? `Nothing if they say no. At least ${money(pricing.accepted.minimumFeeCents)}, never more than ${money(pricing.accepted.maximumFeeCents)} a quote.`
        : 'Nothing if they say no.',
    },
    {
      label: 'Subscription',
      upFront: false,
      price: pricing ? money(pricing.subscription.monthlyCents) : loading,
      unit: 'a month',
      rate: pricing ? `or ${money(pricing.subscription.yearlyCents)} a year` : loading,
      detail: pricing ? planDetail('monthly', pricing) : 'Loading the current prices…',
    },
  ];
  return (
    <dl className="mt-10 grid gap-4 md:grid-cols-3">
      <div className="rounded-md border border-line bg-surface p-5 md:col-span-3">
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
      {cards.map((card) => (
        <div key={card.label} className="rounded-md border border-line bg-surface p-5">
          <dt className="t-label text-muted">{card.label}</dt>
          <dd className="mt-4">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="qf-total text-[48px]">
                {card.upFront ? <span className="hl">{card.price}</span> : card.price}
              </span>
              <span className="text-lg text-ink-2">{card.unit}</span>
            </p>
            <p className="t-h3 mt-4">{card.rate}</p>
            <p className="mt-1 text-ink-2">{card.detail}</p>
          </dd>
        </div>
      ))}
      {pricing?.firstMonthMaxCents ? (
        <div className="rounded-md border border-line bg-surface p-5 md:col-span-3">
          <dt className="t-label text-muted">Your first 30 days</dt>
          <dd className="mt-2">
            <p className="t-h2">Quote fees stop at {money(pricing.firstMonthMaxCents)}</p>
            <p className="mt-2 text-ink-2">
              On any plan, counted from the day you add a card. Quotes past that still go out, and
              you don’t pay for them.
            </p>
          </dd>
        </div>
      ) : null}
      <div className="rounded-md border border-line bg-surface p-5 md:col-span-3">
        <dt className="t-label text-muted">What counts as a quote</dt>
        <dd className="mt-2 text-ink-2">
          A quote counts when a customer who confirmed their email receives it, whether it went out
          on its own or you approved it first. It counts as accepted when they say yes to it in the
          chat. Practice quotes, your own tests and sending the same quote again don’t count. You
          can switch plans any time, and set a monthly limit on fees: when you reach it, new
          requests wait for you instead.
        </dd>
      </div>
    </dl>
  );
}
