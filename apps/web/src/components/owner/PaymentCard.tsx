'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { feeText, startCheckout, type Billing } from '@/lib/owner';
import { cx } from '@/lib/util';

/**
 * Quotes can't reach customers until billing is set up, so this stays in view until it is.
 * Nothing shows once quotes can go out.
 */
export function PaymentCard({
  billing,
  email,
  emailVerified,
  className,
}: {
  billing: Billing;
  email: string;
  emailVerified: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (billing.canSend) return null;
  const needsCard = billing.status !== 'active' && billing.checkoutAvailable;

  return (
    <section
      className={cx('rounded-md border border-line bg-surface p-5 sm:p-6', className)}
      aria-labelledby="payment-title"
    >
      <h2 id="payment-title" className="t-h3 flex items-center gap-2">
        <CreditCard className="size-5 text-accent" aria-hidden />
        {needsCard ? 'Add a payment method so quotes can go out' : 'Quotes are waiting for you'}
      </h2>
      <p className="mt-2 max-w-2xl text-ink-2">
        {needsCard
          ? `You pay ${feeText(billing.tariff)}, only when a customer receives it. Setup, practice and your own tests stay free. Until then, every quote waits for you.`
          : billing.reason}
      </p>
      {needsCard && !emailVerified && (
        <p className="mt-2 text-sm text-muted">
          Confirm your email first, with the code we sent to{' '}
          <span className="font-semibold text-ink">{email}</span>.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {needsCard ? (
          <Button
            disabled={busy || !emailVerified}
            onClick={() => {
              setBusy(true);
              setError('');
              startCheckout()
                .then(({ url }) => window.location.assign(url))
                .catch((checkoutError) => {
                  setError(errorMessage(checkoutError));
                  setBusy(false);
                });
            }}
          >
            {busy ? 'Opening…' : 'Add a payment method'}
          </Button>
        ) : (
          <Link href="/app/settings" className="text-accent underline underline-offset-4">
            Open billing settings
          </Link>
        )}
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
