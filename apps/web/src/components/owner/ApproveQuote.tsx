'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { QuoteForm } from '@/components/QuoteForm';
import { Button, ButtonLink } from '@/components/ui';
import { tokenFromLink } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { approveFromLink, viewApproval, type ApprovalView } from '@/lib/owner';
import { money } from '@/lib/util';

/** Kept for the tab, so a reload after switching apps still works. The address loses it. */
function linkToken(quoteId: string): string | null {
  const key = `approve:${quoteId}`;
  const fromLink = tokenFromLink();
  try {
    if (fromLink) sessionStorage.setItem(key, fromLink);
    return fromLink ?? sessionStorage.getItem(key);
  } catch {
    return fromLink;
  }
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/app" />
      </header>
      <main className="gutter mx-auto max-w-[560px] pt-6 pb-20">{children}</main>
    </div>
  );
}

/**
 * Opened from the one-tap link in a "needs your OK" email, usually on a phone. It shows the
 * quote and sends it as it is. Changing it, or anything else, is in the dashboard.
 */
export function ApproveQuote({ quoteId }: { quoteId: string }) {
  const token = useRef<string | null>(null);
  const [view, setView] = useState<ApprovalView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [justSent, setJustSent] = useState(false);

  useEffect(() => {
    token.current ??= linkToken(quoteId);
    if (!token.current) {
      setLoadError('This link isn’t complete. Open it from your email again.');
      return;
    }
    viewApproval(quoteId, token.current)
      .then(setView)
      .catch((error) => setLoadError(errorMessage(error)));
  }, [quoteId]);

  const dashboard = `/app/quotes/${quoteId}`;

  if (loadError)
    return (
      <Shell>
        <h1 className="t-h1">This link doesn&apos;t work</h1>
        <p className="mt-3 text-lg text-ink-2">{loadError}</p>
        <ButtonLink href={dashboard} size="lg" className="mt-8">
          Open it in your dashboard
        </ButtonLink>
      </Shell>
    );
  if (!view)
    return (
      <Shell>
        <div aria-busy="true" aria-label="Opening the quote" className="flex flex-col gap-4">
          <div className="shimmer h-10 w-3/4 rounded-sm" />
          <div className="shimmer h-80 rounded-md" />
        </div>
      </Shell>
    );

  if (view.status !== 'waiting')
    return (
      <Shell>
        {justSent && (
          <p className="inline-flex items-center gap-2 font-semibold text-go">
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-go text-surface">
              <Check className="size-4" aria-hidden />
            </span>
            Done
          </p>
        )}
        <h1 className="t-h1 mt-3">
          {justSent
            ? `Sent to ${view.customer}.`
            : view.status === 'declined'
              ? 'You declined this one.'
              : 'This quote has already gone out.'}
        </h1>
        <p className="mt-3 text-lg text-ink-2">
          {view.status === 'declined'
            ? `${view.customer} heard back from you already. There's nothing more to do here.`
            : `${view.customer} gets it by email, with a link to accept. We'll let you know when they reply.`}
        </p>
        <ButtonLink href={dashboard} variant="secondary" size="lg" className="mt-8">
          See it in your dashboard
        </ButtonLink>
      </Shell>
    );

  async function approve() {
    if (!token.current || busy) return;
    setBusy(true);
    setSendError('');
    try {
      setView(await approveFromLink(quoteId, token.current));
      setJustSent(true);
      window.scrollTo({ top: 0 });
    } catch (error) {
      setSendError(errorMessage(error));
      setBusy(false);
    }
  }

  const service = view.serviceName.toLowerCase();
  return (
    <Shell>
      <p className="text-sm text-muted">{view.business}</p>
      <h1 className="t-h1 mt-1">
        {view.customer} wants a {service ? `${service} quote` : 'quote'}
      </h1>
      {view.details && <p className="mt-2 text-ink-2">{view.details}</p>}

      {view.reasons.length > 0 && (
        <section
          className="mt-6 rounded-md border border-line bg-canary-soft p-4"
          aria-labelledby="why-title"
        >
          <h2 id="why-title" className="flex items-center gap-2 font-semibold">
            <CircleAlert className="size-5" aria-hidden /> Why it&apos;s waiting for you
          </h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[15px]">
            {view.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6">
        <QuoteForm quote={view.card} business={view.business} stamp="draft" compact />
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <Button size="lg" className="w-full" disabled={busy} onClick={() => void approve()}>
          {busy ? 'Sending…' : `Approve and send ${money(view.totalCents)}`}
        </Button>
        {sendError && (
          <p className="text-sm text-stop" role="alert">
            {sendError}
          </p>
        )}
        <p className="text-center text-sm text-muted">
          Want to change something first?{' '}
          <Link href={dashboard} className="font-semibold text-accent underline underline-offset-4">
            Open it in your dashboard
          </Link>
        </p>
      </div>
    </Shell>
  );
}
