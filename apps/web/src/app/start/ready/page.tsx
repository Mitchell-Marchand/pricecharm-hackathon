'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CircleCheckBig, Hand, MessageSquareText, Receipt } from 'lucide-react';
import { JobSheet, newJob, type Editing } from '@/components/jobs/PastJobs';
import { Logo } from '@/components/Logo';
import { QuoteForm } from '@/components/QuoteForm';
import { ServiceList, ServicesIntro } from '@/components/ServiceList';
import { SetupLoading } from '@/components/SetupLoading';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { loadProfile, type Profile } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import { morePractice } from '@/lib/practice';
import { tradeName, TRADES_BY_ID } from '@/lib/trades';
import { money } from '@/lib/util';

export default function ReadyStep() {
  const { state, goTo } = useOnboarding();
  const notify = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<Editing | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const refresh = useCallback(() => {
    loadProfile()
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);
  useEffect(refresh, [refresh]);
  if (!state) return <SetupLoading />;
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
              <CircleCheckBig className="size-5" aria-hidden /> Training complete
            </p>
            <h1 className="t-hero mt-4">Your AI is ready.</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">
              {profile ? (
                <>
                  It learned from {profile.jobsCount} past{' '}
                  {profile.jobsCount === 1 ? 'job' : 'jobs'} and {profile.practiceCount} practice
                  customers. Here&apos;s how it will handle {trade} requests for {business}.
                </>
              ) : (
                <>
                  Here&apos;s how it will handle {trade} requests for {business}.
                </>
              )}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => void goTo(state.draft ? 'account' : 'live')}>
                {state.draft ? 'Create your free account' : 'Get your quote link'}{' '}
                <ArrowRight aria-hidden />
              </Button>
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
            <section className="mt-16 border-t border-line pt-12" aria-labelledby="services-title">
              <h2 id="services-title" className="t-h2">
                Your services
              </h2>
              <ServicesIntro services={profile.services} autoSend />
              <ServiceList
                services={profile.services}
                autoSend
                busy={starting}
                onAddJob={(service) => setAdding(newJob(service))}
                onPractice={(service) => void practice(service)}
              />
            </section>

            <div className="mt-16 grid gap-10 border-t border-line pt-12 md:grid-cols-3 md:gap-8">
              <section>
                <h2 className="t-h3 flex items-center gap-2">
                  <MessageSquareText className="size-5 text-accent" aria-hidden /> It will ask
                </h2>
                <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
                  {profile.asks.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h2 className="t-h3 flex items-center gap-2">
                  <Receipt className="size-5 text-accent" aria-hidden /> How it prices
                </h2>
                <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
                  {profile.prices.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h2 className="t-h3 flex items-center gap-2">
                  <Hand className="size-5 text-accent" aria-hidden /> When it checks with you
                </h2>
                <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
                  {profile.handoffs.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            </div>

            <section
              className="mt-14 rounded-md border border-line bg-surface p-5 sm:p-6"
              aria-labelledby="accuracy-title"
            >
              <h2 id="accuracy-title" className="t-h2">
                Its guesses next to yours
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
