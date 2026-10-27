'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Lock, Mail, MessageSquareText, Receipt } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { ReadinessCard } from '@/components/ReadinessCard';
import { SetupLoading } from '@/components/SetupLoading';
import { EmailCode } from '@/components/owner/EmailCode';
import { PlanCards } from '@/components/owner/PlanCards';
import { ShareSections } from '@/components/share/ShareSections';
import { Button, ButtonLink } from '@/components/ui';
import { loadMe, loadShare, type AgentReadiness, type Me, type Share } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import {
  choosePlan,
  deployAgent,
  loadBilling,
  loadHome,
  startCheckout,
  syncBilling,
  type Billing,
} from '@/lib/owner';
import { planDetail, planName, type Plan } from '@/lib/plans';
import { money } from '@/lib/util';

/** Checks of the card after coming back from adding it, two seconds apart. */
const CARD_CHECKS = 10;

/**
 * Setup's last screen, in three states: the plans, then deploying once a card is on, then live
 * with the link to share. It says they're live only once quotes can reach customers.
 */
export default function LiveStep() {
  const { state } = useOnboarding();
  const [me, setMe] = useState<Me | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
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
    // Only to show at the deploy step; going live doesn't wait on it.
    loadHome()
      .then((home) => setReadiness(home.readiness ?? null))
      .catch(() => {});
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
  const live = billing.canSend && billing.linkOn;

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/app" />
      </header>
      <main className="gutter mx-auto max-w-5xl pt-4 pb-20">
        {live ? (
          <Live
            business={business}
            firstName={firstName}
            me={me}
            billing={billing}
            share={share}
            onShare={setShare}
            onConfirmed={refresh}
          />
        ) : checkingCard ? (
          <div role="status">
            <h1 className="t-hero">Checking your card…</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">This takes a few seconds.</p>
          </div>
        ) : billing.canSend ? (
          <Deploy
            business={business}
            link={share.url}
            billing={billing}
            readiness={readiness}
            onDeployed={setBilling}
          />
        ) : (
          <Plans business={business} billing={billing} />
        )}
      </main>
    </div>
  );
}

/**
 * The ask: three plans, each a button straight to adding a card. What it's for is said once,
 * plainly, above them.
 */
function Plans({ business, billing }: { business: string; billing: Billing }) {
  const [busy, setBusy] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const { pricing } = billing;

  async function choose(plan: Plan) {
    setBusy(plan);
    setError('');
    try {
      if (plan !== billing.plan) await choosePlan(plan);
      window.location.assign((await startCheckout('setup')).url);
    } catch (chooseError) {
      setError(errorMessage(chooseError));
      setBusy(null);
    }
  }

  return (
    <>
      <p className="inline-flex items-center gap-2 font-semibold text-go">
        <Check className="size-5" aria-hidden /> Your AI is trained
      </p>
      <h1 className="t-hero mt-4 max-w-3xl">Pick a plan. Then go live.</h1>
      <p className="mt-5 max-w-2xl text-lg text-ink-2">
        Customers get a real quote from {business} in about 2 minutes, day or night. Until your AI
        is ready to send on its own, each quote waits for your OK, one tap from your email.
      </p>
      <div className="mt-10">
        {billing.checkoutAvailable ? (
          <PlanCards
            billing={billing}
            busy={busy}
            onChoose={(plan) => void choose(plan)}
            action={(plan) =>
              plan === 'per_quote'
                ? `Start with ${money(pricing.perQuoteCents)} a quote`
                : plan === 'per_accepted'
                  ? `Start with ${pricing.accepted.basisPoints / 100}% a job`
                  : billing.freeWeek
                    ? 'Start your free week'
                    : `Start ${plan === 'monthly' ? 'monthly' : 'yearly'}`
            }
          />
        ) : (
          <p className="text-ink-2">{billing.reason}</p>
        )}
      </div>
      {error && (
        <p className="mt-4 text-stop" role="alert">
          {error}
        </p>
      )}
      <div className="mt-8 flex flex-col gap-4 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Lock className="size-4 shrink-0 text-muted" aria-hidden />
          Stripe keeps your card details. Switch plans or cancel any time. Practice and your own
          tests are always free.
        </p>
        <Link
          href="/app"
          className="shrink-0 text-sm text-muted underline underline-offset-4 hover:text-ink"
        >
          I&apos;ll do this later
        </Link>
      </div>
    </>
  );
}

/** Card added: one button to start taking requests, with how ready the agent is beside it. */
function Deploy({
  business,
  link,
  billing,
  readiness,
  onDeployed,
}: {
  business: string;
  /** The quote link that starts taking requests. */
  link: string;
  billing: Billing;
  readiness: AgentReadiness | null;
  onDeployed: (billing: Billing) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const learning = readiness && readiness.score < 100;

  async function deploy() {
    setBusy(true);
    setError('');
    try {
      onDeployed(await deployAgent());
    } catch (deployError) {
      setError(errorMessage(deployError));
      setBusy(false);
    }
  }

  return (
    <div className="grid items-start gap-10 md:grid-cols-[1fr_360px]">
      <div>
        <p className="inline-flex items-center gap-2 font-semibold text-go">
          <Check className="size-5" aria-hidden />
          {billing.plan ? planName(billing.plan, billing.pricing) : 'Plan chosen'}, card added
          {billing.status === 'trialing' ? ', free week started' : ''}
        </p>
        <h1 className="t-hero mt-4">Ready when you are.</h1>
        <p className="mt-5 max-w-xl text-lg text-ink-2">
          Deploying turns on your quote link and website widget, so customers can ask {business} for
          a quote straight away.
        </p>
        <p className="mt-5 inline-flex max-w-full items-center gap-2 rounded-sm border border-line bg-surface px-3 py-2 font-mono text-sm">
          <span className="size-2 shrink-0 rounded-full bg-line-strong" aria-hidden />
          <span className="truncate">{link.replace(/^https?:\/\//, '')}</span>
        </p>
        <p className="mt-5 max-w-xl text-ink-2">
          {learning
            ? `It’s ${readiness.score}% ready, so for now it drafts each quote and you approve it with one tap. It sends more on its own as it learns your prices.`
            : 'It sends quotes on its own where it knows your prices, and asks you about anything unusual.'}
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button size="lg" disabled={busy} onClick={() => void deploy()}>
            {busy ? 'Deploying…' : 'Deploy your agent'} <ArrowRight aria-hidden />
          </Button>
          {learning && (
            <Link
              href="/app/train"
              className="text-ink-2 underline underline-offset-4 hover:text-ink"
            >
              Train it more first
            </Link>
          )}
        </div>
        {error && (
          <p className="mt-4 text-stop" role="alert">
            {error}
          </p>
        )}
      </div>
      {readiness && <ReadinessCard readiness={readiness} nextHref="/app/train" />}
    </div>
  );
}

/** Live: where to share the link, and what happens from here. */
function Live({
  business,
  firstName,
  me,
  billing,
  share,
  onShare,
  onConfirmed,
}: {
  business: string;
  firstName: string;
  me: Me;
  billing: Billing;
  share: Share;
  onShare: (share: Share) => void;
  onConfirmed: () => void;
}) {
  return (
    <>
      {!me.user.emailVerified && (
        <div className="mb-8 flex flex-col gap-3 rounded-md border border-line bg-canary-soft px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="flex gap-2.5 text-[15px]">
            <Mail className="mt-0.5 size-5 shrink-0" aria-hidden />
            <span>
              Enter the code we sent to <span className="font-semibold">{me.user.email}</span>, so
              we can send you every quote.
            </span>
          </p>
          <EmailCode email={me.user.email} onConfirmed={onConfirmed} compact />
        </div>
      )}
      <p className="inline-flex items-center gap-2 font-semibold text-go">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-go text-surface">
          <Check className="size-4" aria-hidden />
        </span>
        You&apos;re all set, {firstName}
      </p>
      <h1 className="t-hero mt-4">You&apos;re live.</h1>
      <p className="mt-5 max-w-xl text-lg text-ink-2">
        Customers can ask {business} for a quote right now. Share your link, add it to your website,
        or both.
      </p>

      <div className="mt-12">
        <ShareSections business={business} share={share} onChange={onShare} />
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
            title: billing.plan ? planName(billing.plan, billing.pricing) : 'Your plan',
            text: billing.plan
              ? `${planDetail(billing.plan, billing.pricing, false)} Change it any time in Settings.`
              : 'Setup, practice and your own tests are free.',
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
    </>
  );
}
