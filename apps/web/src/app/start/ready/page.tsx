'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CircleCheckBig } from 'lucide-react';
import { CharmCard, LEARNING_TEXT, useCharm } from '@/components/Charm';
import { JobSheet, newJob, type Editing } from '@/components/jobs/PastJobs';
import { KnowsSummary } from '@/components/knows/CharmKnows';
import { Logo } from '@/components/Logo';
import { QuoteForm } from '@/components/QuoteForm';
import { SetupLoading } from '@/components/SetupLoading';
import { TryCharm } from '@/components/TryCharm';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { loadProfile, type CharmSettings, type Profile } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { loadKnows, type Knows } from '@/lib/knows';
import { useOnboarding } from '@/lib/onboarding';
import { morePractice } from '@/lib/practice';
import { tradeName, TRADES_BY_ID } from '@/lib/trades';
import { money } from '@/lib/util';

/**
 * The end of training. Before signup it shows what the Charm learned and asks for the account.
 * After it, the same page lets the owner try their Charm as a customer before going live.
 */
export default function ReadyStep() {
  const { state, goTo } = useOnboarding();
  const pathname = usePathname();
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
  if (!state) return <SetupLoading />;
  const trying = !state.draft && pathname === '/start/try';
  const business = state.business.name || 'Your business';
  const trade = tradeName(state.business.tradeId, state.business.customTrade).toLowerCase();
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
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto max-w-5xl pt-6 pb-20">
        <div className="grid items-center gap-12 md:grid-cols-[1fr_380px]">
          <div>
            <p className="inline-flex items-center gap-2 font-semibold text-go">
              <CircleCheckBig className="size-5" aria-hidden />{' '}
              {trying ? 'Account created' : 'Setup done'}
            </p>
            <h1 className="t-hero mt-4">
              {trying ? 'Try your Charm.' : headline(charm?.readiness.score, charm?.settings)}
            </h1>
            {trying && (
              <p className="mt-5 max-w-xl text-lg text-ink-2">
                Ask for a quote the way your customers will. You&apos;re signed in, so it&apos;s a
                test: nothing is emailed or billed, and you see exactly what they&apos;d get.
              </p>
            )}
            <p className={trying ? 'mt-3 max-w-xl text-ink-2' : 'mt-5 max-w-xl text-lg text-ink-2'}>
              {profile && !trying && (
                <>
                  It learned from {profile.jobsCount} past{' '}
                  {profile.jobsCount === 1 ? 'job' : 'jobs'} and {profile.practiceCount} practice{' '}
                  {profile.practiceCount === 1 ? 'customer' : 'customers'}.{' '}
                </>
              )}
              {charm
                ? charm.readiness.score >= charm.settings.trainedPercent ||
                  charm.settings.learningStyle === 'firm'
                  ? `It can quote ${trade} customers for ${business} now, and anything unusual comes to you first.`
                  : `It can start quoting ${trade} customers for ${business} now. Until a service reaches ${charm.settings.trainedPercent}%, customers get ${LEARNING_TEXT[charm.settings.learningStyle]}.`
                : `Here’s how it will handle ${trade} requests for ${business}.`}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              {trying && state.slug ? (
                <>
                  <TryCharm slug={state.slug} onClose={refresh} />
                  <Button size="lg" variant="secondary" onClick={() => void goTo('live')}>
                    Go live <ArrowRight aria-hidden />
                  </Button>
                </>
              ) : (
                <>
                  <Button size="lg" onClick={() => void goTo(state.draft ? 'account' : 'try')}>
                    {state.draft ? 'Create your free account' : 'Try your Charm'}{' '}
                    <ArrowRight aria-hidden />
                  </Button>
                  {state.draft && (
                    <p className="text-sm text-muted">Then try it as a customer would.</p>
                  )}
                </>
              )}
            </div>
          </div>
          <div
            className="relative mx-auto h-[430px] w-full max-w-[360px]"
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
            {charm && (
              <CharmCard
                className="mt-16 max-w-3xl"
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
                {!state.draft && (
                  <p className="mt-6 text-sm text-muted">
                    You can change these any time under{' '}
                    <Link
                      href="/app/train/knows"
                      className="text-accent underline underline-offset-2"
                    >
                      Train
                    </Link>
                    .
                  </p>
                )}
              </div>
            )}

            <section
              className="mt-14 rounded-md border border-line bg-surface p-5 sm:p-6"
              aria-labelledby="accuracy-title"
            >
              <h2 id="accuracy-title" className="t-h2">
                Your Charm&apos;s guesses next to yours
              </h2>
              <div className="mt-5">
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
  if (score >= settings.trainedPercent) return 'Your Charm is ready to quote.';
  return `Your Charm is ${score}% trained.`;
}
