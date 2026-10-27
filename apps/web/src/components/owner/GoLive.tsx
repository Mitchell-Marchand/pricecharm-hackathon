'use client';

import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { EmailCode } from '@/components/owner/EmailCode';
import { Button } from '@/components/ui';
import type { Me } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { feeText, startCheckout, type Billing } from '@/lib/owner';
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
 * What's left before quotes can reach customers: the owner confirms their email with the code we
 * sent, then adds a payment method. Both on the page they're on.
 */
export function GoLiveSteps({
  me,
  billing,
  devCode,
  onConfirmed,
}: {
  me: Me;
  billing: Billing;
  devCode?: string | null;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verified = me.user.emailVerified;
  const needsCard = billing.status !== 'active' && billing.checkoutAvailable;

  return (
    <ol className="flex flex-col gap-3" aria-label="Before you go live">
      <Step number={1} title="Confirm your email" done={verified} open={!verified}>
        {verified ? (
          <p className="text-ink-2">{me.user.email}</p>
        ) : (
          <>
            <p className="mb-4 text-ink-2">
              We sent a 6-digit code to{' '}
              <span className="font-semibold text-ink">{me.user.email}</span>.
            </p>
            <EmailCode email={me.user.email} devCode={devCode} onConfirmed={onConfirmed} />
          </>
        )}
      </Step>
      <Step
        number={2}
        title="Add a payment method"
        done={billing.canSend}
        open={verified && !billing.canSend}
      >
        <p className="text-ink-2">
          {needsCard || !verified
            ? `You pay ${feeText(billing.tariff)}, only when a customer receives it. Setup, practice and your own tests stay free.`
            : billing.reason}
        </p>
        {verified && needsCard && (
          <div className="mt-4">
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                startCheckout('setup')
                  .then(({ url }) => window.location.assign(url))
                  .catch((checkoutError) => {
                    setError(errorMessage(checkoutError));
                    setBusy(false);
                  });
              }}
            >
              {busy ? 'Opening…' : 'Add a payment method'}
            </Button>
          </div>
        )}
        {error && (
          <p className="mt-2 text-sm text-stop" role="alert">
            {error}
          </p>
        )}
      </Step>
    </ol>
  );
}
