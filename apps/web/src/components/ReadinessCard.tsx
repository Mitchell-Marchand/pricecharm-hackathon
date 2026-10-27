'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { buttonClass } from '@/components/button-class';
import type { AgentReadiness } from '@/lib/account';

type Next = NonNullable<AgentReadiness['next']>;

const STORE = 'pricecharm:readiness';
const nextText = (next: Next) =>
  next.action === 'job'
    ? `Add a ${next.service} job with its size.`
    : `Practice a ${next.service} job.`;

/**
 * How close the agent is to quoting the owner's work without them, and the one step that would
 * help most. It never stands in the way of going live; it's there to keep them training.
 */
export function ReadinessCard({
  readiness,
  onNext,
  nextHref,
  className,
}: {
  /** Nothing shows without one. */
  readiness?: AgentReadiness;
  /** Takes the next step right here, like opening the job form. */
  onNext?: (next: Next) => void;
  /** Or a page to take it on. */
  nextHref?: string;
  className?: string;
}) {
  const score = readiness?.score ?? 0;
  const next = readiness?.next ?? null;
  // Points gained since this browser last showed it, so training feels like it's going somewhere.
  const [gained, setGained] = useState(0);
  useEffect(() => {
    if (!readiness) return;
    try {
      const last = Number(localStorage.getItem(STORE));
      if (last && score > last) setGained(score - last);
      localStorage.setItem(STORE, String(score));
    } catch {
      // Private browsing: no running tally, and nothing else changes.
    }
  }, [readiness, score]);
  if (!readiness) return null;

  return (
    <section
      className={`rounded-md border border-line bg-surface p-5 sm:p-6 ${className ?? ''}`}
      aria-labelledby="readiness-title"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="readiness-title" className="font-semibold">
          Agent readiness
        </h2>
        <p className="tabular font-display text-3xl font-[800]">{score}%</p>
      </div>
      <div
        role="meter"
        aria-label="Agent readiness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        className="mt-3 h-2 overflow-hidden rounded-full bg-line"
      >
        <span className="block h-full rounded-full bg-go" style={{ width: `${score}%` }} />
      </div>
      <p className="mt-3 text-sm text-ink-2">
        {next
          ? 'How much of your work it can quote without you. It gets there one service at a time, and the services you do most count most. You can go live at any point.'
          : 'Every service you offer sends quotes on its own. Anything unusual still waits for you.'}
      </p>
      {gained > 0 && (
        <p className="mt-1 text-sm font-semibold text-go">Up {gained} since you last looked.</p>
      )}
      {next && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-[15px]">
            <span className="font-semibold">Next:</span> {nextText(next)}{' '}
            <span className="text-go">+{next.gain}%</span>
          </p>
          {onNext ? (
            <Button size="sm" onClick={() => onNext(next)}>
              {next.action === 'job' ? 'Add a job' : 'Practice one'}
            </Button>
          ) : nextHref ? (
            <Link href={nextHref} className={buttonClass('secondary', 'sm')}>
              Keep training
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}
