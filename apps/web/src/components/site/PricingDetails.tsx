'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/util';

type Pricing = {
  feeBasisPoints: number;
  minimumFeeCents: number;
  maximumFeeCents: number;
  trialQuotes: number;
};

/** The numbers come from the API, so this page can't drift from what billing charges. */
export function PricingDetails() {
  const [pricing, setPricing] = useState<Pricing>();
  useEffect(() => {
    api<Pricing>('/pricing')
      .then(setPricing)
      .catch(() => {});
  }, []);
  const percent = pricing ? `${pricing.feeBasisPoints / 100}%` : '…';
  return (
    <dl className="mt-10 grid gap-4 sm:grid-cols-2">
      <div className="rounded-md border border-line bg-surface p-5">
        <dt className="t-label text-muted">To start</dt>
        <dd className="mt-2">
          <p className="t-h2">{pricing ? `${pricing.trialQuotes} quotes free` : '…'}</p>
          <p className="mt-2 text-ink-2">
            Your first quotes cost nothing, so you can see how your customers take to it.
          </p>
        </dd>
      </div>
      <div className="rounded-md border border-line bg-surface p-5">
        <dt className="t-label text-muted">After that</dt>
        <dd className="mt-2">
          <p className="t-h2">{percent} of each quote</p>
          <p className="mt-2 text-ink-2">
            {pricing
              ? `At least ${money(pricing.minimumFeeCents)} and never more than ${money(pricing.maximumFeeCents)} per quote, whether the customer says yes or not.`
              : 'Loading the current fee…'}
          </p>
        </dd>
      </div>
      <div className="rounded-md border border-line bg-surface p-5 sm:col-span-2">
        <dt className="t-label text-muted">What counts as a quote</dt>
        <dd className="mt-2 text-ink-2">
          A quote counts when a customer who confirmed their email receives it, whether it went out
          on its own or you approved it first. Practice quotes, your own tests and sending the same
          quote again don’t count. You can set a monthly limit, and when you reach it, new requests
          wait for you instead.
        </dd>
      </div>
    </dl>
  );
}
