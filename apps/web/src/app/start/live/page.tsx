'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Mail, MessageSquareText, Receipt } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SetupLoading } from '@/components/SetupLoading';
import { EmailCode } from '@/components/owner/EmailCode';
import { GoLiveSteps } from '@/components/owner/GoLive';
import { ShareSections } from '@/components/share/ShareSections';
import { ButtonLink } from '@/components/ui';
import { loadMe, loadShare, type Me, type Share } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import { loadBilling, syncBilling, type Billing } from '@/lib/owner';

/** Checks of the card after coming back from adding it, two seconds apart. */
const CARD_CHECKS = 10;

/**
 * Setup's last screen. It says they're live only once quotes can reach customers; until then it
 * shows what's left, the same two steps as right after signing up.
 */
export default function LiveStep() {
  const { state } = useOnboarding();
  const [me, setMe] = useState<Me | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [checkingCard, setCheckingCard] = useState(false);
  const [error, setError] = useState('');
  const fromCheckout = useRef<boolean | null>(null);

  const refresh = useCallback(() => {
    Promise.all([loadMe(), loadBilling()])
      .then(([nextMe, nextBilling]) => {
        setMe(nextMe);
        setBilling(nextBilling);
      })
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);

  useEffect(() => {
    loadShare()
      .then(setShare)
      .catch((loadError) => setError(errorMessage(loadError)));
    fromCheckout.current ??=
      new URLSearchParams(window.location.search).get('billing') === 'active';
    if (!fromCheckout.current) return refresh();
    // Back from adding a card. Stripe can take a few seconds to confirm it.
    window.history.replaceState(null, '', window.location.pathname);
    loadMe()
      .then(setMe)
      .catch((loadError) => setError(errorMessage(loadError)));
    setCheckingCard(true);
    let stopped = false;
    void (async () => {
      for (let check = 0; check < CARD_CHECKS && !stopped; check++) {
        try {
          const fresh = await syncBilling();
          if (stopped) return;
          setBilling(fresh);
          if (fresh.canSend) break;
        } catch (syncError) {
          setError(errorMessage(syncError));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!stopped) setCheckingCard(false);
    })();
    return () => {
      stopped = true;
    };
  }, [refresh]);

  if (error)
    return (
      <div className="min-h-dvh">
        <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
          <Logo href="/app" />
        </header>
        <main className="gutter mx-auto max-w-5xl pt-4 pb-20">
          <p className="text-stop" role="alert">
            {error}
          </p>
        </main>
      </div>
    );
  if (!state || !share || !me || !billing) return <SetupLoading />;
  const business = state.business.name || 'Your business';
  const firstName = me.user.firstName || me.user.name.split(' ')[0] || 'there';
  const live = billing.canSend;

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/app" />
      </header>

      <main className="gutter mx-auto max-w-5xl pt-4 pb-20">
        {live && !me.user.emailVerified && (
          <div className="mb-8 flex flex-col gap-3 rounded-md border border-line bg-canary-soft px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="flex gap-2.5 text-[15px]">
              <Mail className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>
                Enter the code we sent to <span className="font-semibold">{me.user.email}</span>, so
                we can send you every quote.
              </span>
            </p>
            <EmailCode email={me.user.email} onConfirmed={refresh} compact />
          </div>
        )}

        {live ? (
          <>
            <p className="inline-flex items-center gap-2 font-semibold text-go">
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-go text-surface">
                <Check className="size-4" aria-hidden />
              </span>
              You&apos;re all set, {firstName}
            </p>
            <h1 className="t-hero mt-4">You&apos;re live.</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">
              Customers can ask {business} for a quote right now. Share your link, add it to your
              website, or both.
            </p>
          </>
        ) : checkingCard ? (
          <div role="status">
            <h1 className="t-hero">Checking your card…</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">This takes a few seconds.</p>
          </div>
        ) : (
          <>
            <p className="font-semibold text-ink-2">Your account is saved, {firstName}</p>
            <h1 className="t-hero mt-4">Almost live.</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">
              Your quote link is ready, but quotes can&apos;t reach customers until these are done.
              Anyone who asks before then waits for you.
            </p>
            <div className="mt-8 max-w-[560px]">
              <GoLiveSteps me={me} billing={billing} onConfirmed={refresh} />
            </div>
          </>
        )}

        <div className="mt-12">
          <ShareSections business={business} share={share} onChange={setShare} />
        </div>

        <section className="mt-12 grid gap-8 md:grid-cols-3" aria-label="What happens next">
          {[
            {
              icon: Mail,
              title: 'Every quote lands in your inbox',
              text: 'You get an email each time a customer receives a quote.',
            },
            {
              icon: MessageSquareText,
              title: 'Unusual jobs wait for you',
              text: 'Anything outside your usual range comes to you first. One tap to approve.',
            },
            {
              icon: Receipt,
              title: billing
                ? `${billing.tariff.basisPoints / 100}% per quote`
                : 'A small fee per quote',
              text: 'You pay only when a customer receives a quote. Setup, practice and your own tests are free.',
            },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon className="size-6 text-accent" aria-hidden />
              <h3 className="t-h3 mt-3">{title}</h3>
              <p className="mt-1.5 text-ink-2">{text}</p>
            </div>
          ))}
        </section>

        <div className="mt-12 flex justify-end border-t border-line pt-8">
          <ButtonLink href="/app" size="lg">
            Go to your dashboard <ArrowRight aria-hidden />
          </ButtonLink>
        </div>
      </main>
    </div>
  );
}
