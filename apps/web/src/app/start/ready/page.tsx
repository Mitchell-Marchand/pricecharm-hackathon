'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheckBig } from 'lucide-react';
import { CharmCard, useCharm } from '@/components/Charm';
import { JobSheet, newJob, type Editing } from '@/components/jobs/PastJobs';
import { KnowsSummary } from '@/components/knows/CharmKnows';
import { QuoteForm } from '@/components/QuoteForm';
import { SetupLoading } from '@/components/SetupLoading';
import { SignupForm } from '@/components/setup/SignupForm';
import { useToast } from '@/components/Toast';
import { WizardHeader } from '@/components/Wizard';
import { loadProfile, type CharmSettings, type Profile } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { loadKnows, type Knows } from '@/lib/knows';
import { useOnboarding } from '@/lib/onboarding';
import { morePractice } from '@/lib/practice';
import { TRADES_BY_ID } from '@/lib/trades';
import { money } from '@/lib/util';

/**
 * The end of practice: what the Charm learned, and the account that saves it. Signed in already,
 * it's the try page's turn.
 */
export default function ReadyStep() {
  const router = useRouter();
  const { state, goTo } = useOnboarding();
  const notify = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [knows, setKnows] = useState<Knows | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Editing | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);
  const [charm, setCharm] = useCharm(changes);
  const refresh = useCallback(() => {
    loadProfile()
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
    loadKnows()
      .then(setKnows)
      .catch(() => setKnows(null));
    setChanges((current) => current + 1);
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (state && !state.draft) router.replace('/start/try');
  }, [state, router]);
  if (!state || !state.draft) return <SetupLoading />;
  const business = state.business.name || 'Your business';
  const tradeHints = state.business.tradeId ? TRADES_BY_ID[state.business.tradeId] : null;
  const services = state.business.services.length ? state.business.services : ['General'];

  // A practice customer for one service, in setup's practice screen, then back here.
  async function practice(service: string) {
    setStarting(service);
    try {
      await morePractice(service);
      await goTo('practice');
    } catch (startError) {
      notify(errorMessage(startError));
      setStarting(null);
    }
  }

  return (
    <div className="min-h-dvh">
      <WizardHeader screen="ready" />
      <main className="gutter mx-auto max-w-5xl pt-8 pb-20 sm:pt-12">
        <div className="grid items-start gap-12 md:grid-cols-[1fr_380px]">
          <div className="max-w-xl">
            <p className="inline-flex items-center gap-2 font-semibold text-go">
              <CircleCheckBig className="size-5" aria-hidden /> Practice done
            </p>
            <h1 className="t-hero mt-4">{headline(charm?.readiness.score, charm?.settings)}</h1>
            <p className="mt-5 text-lg text-ink-2">
              {profile ? (
                <>
                  It learned from {profile.practiceCount} practice{' '}
                  {profile.practiceCount === 1 ? 'customer' : 'customers'}
                  {profile.jobsCount
                    ? ` and ${profile.jobsCount} past ${profile.jobsCount === 1 ? 'job' : 'jobs'}`
                    : ''}
                  .{' '}
                </>
              ) : null}
              Create your free account to save it. Then test it the way your customers will.
            </p>
            <section id="account" className="mt-8 scroll-mt-24" aria-label="Create your account">
              <SignupForm />
            </section>
          </div>
          <div
            className="relative mx-auto hidden h-[430px] w-full max-w-[360px] md:block"
            aria-label="Your practice quotes"
          >
            {profile?.practiceQuotes.map((quote, position) => (
              <div
                key={quote.number}
                className="absolute top-0 left-3 w-[calc(100%-72px)]"
                style={{
                  transform: `translate(${position * 18}px, ${position * 28}px) rotate(${(position - 1) * 2.5}deg)`,
                }}
              >
                <QuoteForm quote={quote} business={business} stamp="practice" compact />
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="mt-10 text-stop" role="alert">
            {error}
          </p>
        )}
        {profile && (
          <>
            <section
              className="mt-16 rounded-md border border-line bg-surface p-5 sm:p-6"
              aria-labelledby="accuracy-title"
            >
              <h2 id="accuracy-title" className="t-h2">
                Your Charm&apos;s guesses next to yours
              </h2>
              <div className="mt-5 overflow-x-auto">
                <table className="w-full max-w-2xl text-left text-[15px]">
                  <thead>
                    <tr className="border-b border-line text-sm text-muted">
                      <th className="py-2 pr-4 font-medium">Practice</th>
                      <th className="py-2 pr-4 text-right font-medium">Its guess</th>
                      <th className="py-2 pr-4 text-right font-medium">You</th>
                      <th className="py-2 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.results.map((result) => (
                      <tr key={result.runId} className="border-b border-line last:border-0">
                        <td className="py-3 pr-4">{result.customer}</td>
                        <td className="tabular py-3 pr-4 text-right font-mono">
                          {result.siteVisit && result.aiFlagged
                            ? 'Visit first'
                            : result.guessCents !== null
                              ? money(result.guessCents)
                              : '—'}
                        </td>
                        <td className="tabular py-3 pr-4 text-right font-mono">
                          {result.siteVisit
                            ? 'Visit first'
                            : result.ownerCents !== null
                              ? money(result.ownerCents)
                              : '—'}
                        </td>
                        <td className="py-3">
                          {result.siteVisit ? (
                            result.aiFlagged ? (
                              <span className="text-go">Agreed</span>
                            ) : (
                              <span className="text-muted">Learned</span>
                            )
                          ) : result.gap === null ? (
                            <span className="text-muted">Learned</span>
                          ) : (
                            <span className={result.agree ? 'text-go' : 'text-muted'}>
                              {result.gap}% apart
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {charm && (
              <CharmCard
                className="mt-12 max-w-3xl"
                charm={charm}
                onChange={setCharm}
                busyService={starting}
                onStep={(step) =>
                  step.action === 'job'
                    ? setAdding(newJob(step.service))
                    : void practice(step.service)
                }
              />
            )}

            {knows && (
              <div className="mt-16 border-t border-line pt-12">
                <KnowsSummary knows={knows} />
              </div>
            )}
          </>
        )}
      </main>
      <JobSheet
        key={adding ? adding.fields.serviceName : 'closed'}
        editing={adding}
        services={services}
        placeholder={tradeHints?.jobHint ?? 'What you did, how big it was, anything unusual.'}
        sizeHint={tradeHints?.sizeHint}
        onClose={() => setAdding(null)}
        onSaved={() => {
          setAdding(null);
          refresh();
        }}
      />
    </div>
  );
}

/** The headline says what the score means, so it never claims more than the Charm knows. */
function headline(score: number | undefined, settings: CharmSettings | undefined) {
  if (score === undefined || !settings) return 'Your Charm is set up.';
  if (score >= 100) return 'Your Charm is fully trained.';
  if (score >= settings.trainedPercent) return 'Your Charm is ready to try.';
  return `Your Charm is ${score}% trained.`;
}
