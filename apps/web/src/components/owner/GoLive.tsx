'use client';

import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { PlanPicker } from '@/components/owner/PlanPicker';
import { Button } from '@/components/ui';
import type { AgentReadiness } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { choosePlan, deployAgent, startCheckout, type Billing } from '@/lib/owner';
import { planName, type Plan } from '@/lib/plans';
import { cx } from '@/lib/util';

function Step({
  number,
  title,
  done,
  open,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cx(
        'flex gap-4 rounded-md border p-4 sm:p-5',
        open ? 'border-line-strong bg-surface' : 'border-line',
      )}
    >
      <span
        className={cx(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
          done ? 'bg-go text-surface' : open ? 'bg-ink text-on-ink' : 'bg-surface-2 text-muted',
        )}
        aria-hidden
      >
        {done ? <Check className="size-4" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className={cx('font-semibold', !open && !done && 'text-muted')}>
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h2>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

/**
 * What's left before customers can ask for quotes: choose a plan and add a card, then deploy the
 * agent. Nothing else stands in the way: not confirming the email, and not how ready it is.
 */
export function GoLiveSteps({
  billing,
  readiness,
  onDeployed,
}: {
  billing: Billing;
  /** Shown at the deploy step, to keep them training. Not needed to deploy. */
  readiness?: AgentReadiness | null;
  onDeployed?: (billing: Billing) => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(billing.plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const paid = billing.canSend;
  const needsCard = billing.checkoutAvailable;

  async function addCard() {
    if (!plan || busy) return;
    setBusy(true);
    setError('');
    try {
      if (plan !== billing.plan) await choosePlan(plan);
      window.location.assign((await startCheckout('setup')).url);
    } catch (cardError) {
      setError(errorMessage(cardError));
      setBusy(false);
    }
  }

  async function deploy() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onDeployed?.(await deployAgent());
    } catch (deployError) {
      setError(errorMessage(deployError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ol className="flex flex-col gap-3" aria-label="Before you go live">
      <Step number={1} title="Choose a plan and add a card" done={paid} open={!paid}>
        {paid && billing.plan ? (
          <p className="text-ink-2">
            {planName(billing.plan, billing.pricing)}. Card added
            {billing.status === 'trialing' ? ', and your free week has started' : ''}.
          </p>
        ) : needsCard ? (
          <>
            <p className="mb-4 text-ink-2">
              Setup, practice and your own tests stay free. You can switch plans any time.
            </p>
            <PlanPicker billing={billing} value={plan} onChange={setPlan} />
            <Button className="mt-4" disabled={!plan || busy} onClick={() => void addCard()}>
              {busy ? 'Opening…' : 'Add a card'}
            </Button>
          </>
        ) : (
          <p className="text-ink-2">{billing.reason}</p>
        )}
      </Step>

      <Step
        number={2}
        title="Deploy your agent"
        done={billing.linkOn}
        open={paid && !billing.linkOn}
      >
        {paid && !billing.linkOn ? (
          <>
            <p className="text-ink-2">
              Your quote link and website widget start taking requests.
              {readiness && readiness.score < 100
                ? ` Your agent is ${readiness.score}% ready, so for now it drafts each quote and asks for your OK. Keep training and it sends more on its own.`
                : ' It sends quotes on its own where it has learned your prices, and asks you about anything else.'}
            </p>
            <Button className="mt-4" disabled={busy} onClick={() => void deploy()}>
              {busy ? 'Deploying…' : 'Deploy your agent'}
            </Button>
          </>
        ) : (
          <p className="text-muted">Your link starts taking requests.</p>
        )}
      </Step>
      {error && (
        <p className="text-sm text-stop" role="alert">
          {error}
        </p>
      )}
    </ol>
  );
}
