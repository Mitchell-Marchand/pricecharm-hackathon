'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheckBig, FileText, MessageSquareText } from 'lucide-react';
import { useCharm } from '@/components/Charm';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { ConfirmEmail } from '@/components/owner/ConfirmEmail';
import { SetupLoading } from '@/components/SetupLoading';
import { TryCharm } from '@/components/TryCharm';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Button } from '@/components/ui';
import { loadMe, type Me } from '@/lib/account';
import { useOnboarding } from '@/lib/onboarding';
import { TRADES_BY_ID } from '@/lib/trades';

/**
 * Right after signup: the owner tests their Charm as a customer would, and can teach it more from
 * jobs they've done. Going live is the main thing on the page.
 */
export default function TryStep() {
  const router = useRouter();
  const { state, goTo } = useOnboarding();
  const [me, setMe] = useState<Me | null>(null);
  const [changes, setChanges] = useState(0);
  const [boosting, setBoosting] = useState(false);
  const [charm] = useCharm(changes);
  const bump = useCallback(() => setChanges((current) => current + 1), []);
  useEffect(() => {
    if (!state) return;
    if (state.draft) {
      router.replace('/start/ready');
      return;
    }
    loadMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, [state, router]);
  if (!state || state.draft) return <SetupLoading />;
  const trade = state.business.tradeId ? TRADES_BY_ID[state.business.tradeId] : null;
  const services = state.business.services.length ? state.business.services : ['General'];
  const score = charm?.readiness.score;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="try" />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-8 pb-16 sm:pt-12">
        <p className="inline-flex items-center gap-2 font-semibold text-go">
          <CircleCheckBig className="size-5" aria-hidden /> Account created
        </p>
        <h1 className="t-hero mt-4">Test your Charm.</h1>
        <p className="mt-5 text-lg text-ink-2">
          Ask for a quote the way your customers will, photos and all. You&apos;re signed in, so
          it&apos;s a test: nothing is emailed or billed.
        </p>
        <div className="mt-7">
          {state.slug && (
            <TryCharm slug={state.slug} variant="secondary" onClose={bump}>
              <MessageSquareText aria-hidden /> Test your Charm
            </TryCharm>
          )}
        </div>
        {me && !me.user.emailVerified && (
          <div className="mt-8">
            <ConfirmEmail
              email={me.user.email}
              onConfirmed={() =>
                setMe((current) =>
                  current
                    ? { ...current, user: { ...current.user, emailVerified: true } }
                    : current,
                )
              }
            />
          </div>
        )}

        <section className="mt-12 border-t border-line pt-10" aria-labelledby="sharper-title">
          <h2 id="sharper-title" className="t-h2">
            Make it sharper <span className="font-normal text-muted">(optional)</span>
          </h2>
          <p className="mt-2 text-ink-2">
            {score !== undefined ? `Your Charm is ${score}% trained. ` : ''}Every job you&apos;ve
            done teaches it more. Snap a photo of an old invoice and it reads it for you, or type a
            few in.
          </p>
          {boosting ? (
            <div className="mt-6">
              <PastJobsEditor
                services={services}
                jobHint={trade?.jobHint}
                sizeHint={trade?.sizeHint}
                onJobsChange={bump}
              />
            </div>
          ) : (
            <Button variant="secondary" className="mt-5" onClick={() => setBoosting(true)}>
              <FileText aria-hidden /> Add past jobs
            </Button>
          )}
        </section>
      </main>
      <BottomBar onNext={() => void goTo('live')} nextLabel="Let’s go live" />
    </div>
  );
}
