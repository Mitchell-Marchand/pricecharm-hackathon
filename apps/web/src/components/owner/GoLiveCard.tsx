'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { buttonClass } from '@/components/button-class';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { setLinkOn, type Billing } from '@/lib/owner';
import { cx } from '@/lib/util';

/**
 * Whatever is still between the owner and customers asking for quotes: a plan and a card, then
 * deploying, or turning a paused link back on. Nothing shows once the link is taking requests.
 */
export function GoLiveCard({
  billing,
  onChange,
  className,
}: {
  billing: Billing;
  onChange: (billing: Billing) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (billing.canSend && billing.linkOn) return null;
  const paused = billing.canSend && billing.deployed && !billing.linkOn;
  const title = !billing.plan
    ? 'Choose a plan to go live'
    : !billing.canSend
      ? billing.checkoutAvailable
        ? 'Add a card so quotes can go out'
        : 'Quotes are waiting for you'
      : paused
        ? 'Your quote link is paused'
        : 'Deploy your agent';
  const text = !billing.plan
    ? 'Your agent is set up. Pick how you’d like to pay and add a card, then deploy it and customers can ask for quotes.'
    : !billing.canSend
      ? billing.reason
      : paused
        ? 'Customers who open it see that you aren’t taking requests right now.'
        : 'Your plan and card are set. Deploy it and your quote link starts taking requests.';

  return (
    <section
      className={cx('rounded-md border border-line bg-surface p-5 sm:p-6', className)}
      aria-labelledby="go-live-title"
    >
      <h2 id="go-live-title" className="t-h3 flex items-center gap-2">
        <CreditCard className="size-5 text-accent" aria-hidden />
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-ink-2">{text}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {paused ? (
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              setLinkOn(true)
                .then(onChange)
                .catch((linkError) => setError(errorMessage(linkError)))
                .finally(() => setBusy(false));
            }}
          >
            Turn it back on
          </Button>
        ) : billing.canSend || billing.checkoutAvailable ? (
          <a href="/start/live" className={buttonClass('primary', 'md')}>
            {billing.canSend ? 'Deploy your agent' : 'Finish going live'}
          </a>
        ) : (
          <a href="/app/settings" className="text-accent underline underline-offset-4">
            Open billing settings
          </a>
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
