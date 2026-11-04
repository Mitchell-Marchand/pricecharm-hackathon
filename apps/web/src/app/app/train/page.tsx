'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/button-class';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { CharmCard, useCharm } from '@/components/Charm';
import { TellCharm } from '@/components/owner/TellCharm';
import { api, errorMessage } from '@/lib/api';
import { loadKnows, type Knows } from '@/lib/knows';
import type { Profile } from '@/lib/account';
import type { Onboarding } from '@/lib/onboarding';
import { loadOwnerProfile } from '@/lib/owner';
import { money } from '@/lib/util';
import { TRADES_BY_ID } from '@/lib/trades';

export default function TrainPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [knows, setKnows] = useState<Knows | null>(null);
  const [business, setBusiness] = useState<Onboarding['business'] | null>(null);
  const [error, setError] = useState('');
  const [addRequest, setAddRequest] = useState<{ service: string; at: number } | null>(null);
  const [changes, setChanges] = useState(0);
  const [charm, setCharm] = useCharm(changes);

  const refresh = useCallback(() => {
    loadOwnerProfile()
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
    // Its rates come from the jobs, so they change with them.
    loadKnows()
      .then(setKnows)
      .catch(() => setKnows(null));
    setChanges((current) => current + 1);
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
      <h1 className="t-h1">Train your Charm</h1>
      <p className="mt-3 max-w-2xl text-lg text-ink-2">
        {profile
          ? `It learned from ${[
              `${profile.jobsCount} past ${profile.jobsCount === 1 ? 'job' : 'jobs'}`,
              profile.practiceCount
                ? `${profile.practiceCount} practice ${profile.practiceCount === 1 ? 'customer' : 'customers'}`
                : '',
              profile.liveQuotesLearned
                ? `${profile.liveQuotesLearned} real ${profile.liveQuotesLearned === 1 ? 'quote' : 'quotes'}`
                : '',
            ]
              .filter(Boolean)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1')}. Add jobs to sharpen its prices.`
          : 'Practice and past jobs teach it how you price.'}
      </p>
      {error && (
        <p className="mt-4 text-stop" role="alert">
          {error}
        </p>
      )}

      <TellCharm className="mt-10 max-w-3xl" />

      {charm && (
        <CharmCard
          className="mt-10 max-w-3xl"
          charm={charm}
          onChange={setCharm}
          onStep={(step) =>
            step.action === 'job'
              ? setAddRequest({ service: step.service, at: Date.now() })
              : router.push(`/app/train/practice?service=${encodeURIComponent(step.service)}`)
          }
        />
      )}

      {profile && profile.live.reviewed > 0 && (
        <LiveRecord live={profile.live} closePercent={profile.settings?.closePercent ?? 15} />
      )}

      <section className="mt-14 border-t border-line pt-10" aria-labelledby="practice-title">
        <h2 id="practice-title" className="t-h2">
          Practice
        </h2>
        <p className="mt-2 max-w-xl text-ink-2">
          A pretend customer for your trade, like the ones in setup. Answer them like a real lead
          and your Charm learns how you ask and how you price. Do as many as you like.
        </p>
        <Link href="/app/train/practice" className={buttonClass('secondary', 'md', 'mt-6')}>
          Practice with a customer
        </Link>
      </section>

      <section className="mt-14 border-t border-line pt-10" aria-labelledby="jobs-title">
        <h2 id="jobs-title" className="t-h2">
          Past jobs
        </h2>
        <p className="mt-2 max-w-xl text-ink-2">
          Real jobs and what you charged. Your Charm prices new requests from these.
        </p>
        <div className="mt-6 max-w-[680px]">
          {business && (
            <PastJobsEditor
              services={services}
              jobHint={trade?.jobHint}
              sizeHint={trade?.sizeHint}
              onJobsChange={onJobsChange}
              addRequest={addRequest}
            />
          )}
        </div>
      </section>

      <section className="mt-14 border-t border-line pt-10" aria-labelledby="knows-title">
        <h2 id="knows-title" className="t-h2">
          What your Charm knows
        </h2>
        <p className="mt-2 max-w-xl text-ink-2">
          {knows
            ? knowsSummary(knows)
            : 'The questions it asks customers, its rates and your notes on your prices.'}
        </p>
        <Link href="/app/train/knows" className={buttonClass('secondary', 'md', 'mt-6')}>
          See and change it
        </Link>
      </section>
    </>
  );
}

/** "It asks customers 6 questions, has your rate for Windows and follows 2 notes from you." */
function knowsSummary({ questions, rates, notes }: Knows) {
  const rated = rates.filter((rate) => rate.price);
  const parts = [
    `asks customers ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`,
    !rates.length
      ? ''
      : rated.length === rates.length
        ? rates.length === 1
          ? `has your rate for ${rates[0].service}`
          : `has your rates for all ${rates.length} services`
        : `has rates for ${rated.length} of your ${rates.length} services`,
    notes.length ? `follows ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} from you` : '',
  ].filter(Boolean);
  return `It ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`;
}

/** How close its drafts came to what the owner sent real customers. */
function LiveRecord({ live, closePercent }: { live: Profile['live']; closePercent: number }) {
  return (
    <section className="mt-14 border-t border-line pt-10" aria-labelledby="record-title">
      <h2 id="record-title" className="t-h2">
        On real quotes
      </h2>
      <p className="mt-2 max-w-xl text-ink-2">
        Of the last {live.considered} {live.considered === 1 ? 'quote' : 'quotes'} you checked
        before sending, its draft was within {closePercent}% of what you sent on {live.agreed}.
        Every change you make teaches it.
      </p>
      <ul className="mt-5 flex max-w-xl flex-col gap-2 text-[15px]">
        {live.recent.map((item) => (
          <li key={item.quoteId} className="flex justify-between gap-4 border-b border-line pb-2">
            <span className="truncate">{item.customer}</span>
            <span className={item.agree ? 'text-go' : 'text-ink-2'}>
              {item.draftCents === null
                ? `It didn’t price it. You sent ${money(item.sentCents)}`
                : `${money(item.draftCents)} → you sent ${money(item.sentCents)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
