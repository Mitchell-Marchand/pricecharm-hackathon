'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Hand, MessageSquareText, Receipt } from 'lucide-react';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { api, errorMessage } from '@/lib/api';
import type { Profile } from '@/lib/account';
import type { Onboarding } from '@/lib/onboarding';
import { loadOwnerProfile } from '@/lib/owner';
import { TRADES_BY_ID } from '@/lib/trades';

export default function TrainPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [business, setBusiness] = useState<Onboarding['business'] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    loadOwnerProfile()
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);
  useEffect(() => {
    refresh();
    api<Onboarding>('/onboarding')
      .then((state) => setBusiness(state.business))
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [refresh]);

  // Its pricing comes from these jobs, so show the new picture once the list changes.
  const seen = useRef<number | null>(null);
  const onJobsChange = useCallback(
    (jobs: unknown[]) => {
      if (seen.current !== null && seen.current !== jobs.length) refresh();
      seen.current = jobs.length;
    },
    [refresh],
  );

  const services = business?.services.length ? business.services : ['General'];
  const trade = business?.tradeId ? TRADES_BY_ID[business.tradeId] : null;

  return (
    <>
      <h1 className="t-h1">What your AI knows</h1>
      <p className="mt-3 max-w-2xl text-lg text-ink-2">
        {profile
          ? `It learned from ${[
              `${profile.jobsCount} past ${profile.jobsCount === 1 ? 'job' : 'jobs'}`,
              profile.practiceCount ? `${profile.practiceCount} practice customers` : '',
            ]
              .filter(Boolean)
              .join(' and ')}. Add jobs to sharpen its prices.`
          : 'Everything it uses to quote for you.'}
      </p>
      {error && (
        <p className="mt-4 text-stop" role="alert">
          {error}
        </p>
      )}

      {profile ? (
        <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
          {[
            { icon: MessageSquareText, title: 'It will ask', items: profile.asks },
            {
              icon: Receipt,
              title: 'How it prices',
              items: profile.prices.length
                ? profile.prices
                : ['From what you charged for the past jobs below.'],
            },
            { icon: Hand, title: 'When it checks with you', items: profile.handoffs },
          ].map(({ icon: Icon, title, items }) => (
            <section key={title}>
              <h2 className="t-h3 flex items-center gap-2">
                <Icon className="size-5 text-accent" aria-hidden /> {title}
              </h2>
              <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="shimmer mt-10 h-40 rounded-md" aria-busy="true" />
      )}

      <section className="mt-14 border-t border-line pt-10" aria-labelledby="jobs-title">
        <h2 id="jobs-title" className="t-h2">
          Past jobs
        </h2>
        <p className="mt-2 max-w-xl text-ink-2">
          Real jobs and what you charged. Your AI prices new requests from these.
        </p>
        <div className="mt-6 max-w-[680px]">
          {business && (
            <PastJobsEditor
              services={services}
              jobHint={trade?.jobHint}
              onJobsChange={onJobsChange}
            />
          )}
        </div>
      </section>
    </>
  );
}
