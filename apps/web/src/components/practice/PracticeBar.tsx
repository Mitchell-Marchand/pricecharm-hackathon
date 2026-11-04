'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { Meter } from '@/components/Charm';
import { Avatar } from '@/components/ui';
import type { CharmView } from '@/lib/account';
import { distanceText, type PracticeRun } from '@/lib/practice';

export type PracticeMenuItem = { label: string } & ({ href: string } | { onSelect: () => void });

/** What the last move added to the score, for a moment after it lands. */
export function useScoreGain(score: number | null) {
  const last = useRef<number | null>(null);
  const [gain, setGain] = useState(0);
  useEffect(() => {
    if (score === null) return;
    const before = last.current;
    last.current = score;
    if (before === null || score <= before) return;
    setGain(score - before);
    const timer = window.setTimeout(() => setGain(0), 2400);
    return () => window.clearTimeout(timer);
  }, [score]);
  return gain;
}

/** Everything a phone doesn't have room for up top, behind the ⋯. */
function PracticeMenu({ items }: { items: PracticeMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const row =
    'flex h-11 w-full items-center rounded-sm px-2.5 text-left text-[15px] text-ink-2 hover:bg-surface-2 hover:text-ink';
  return (
    <div ref={root} className="relative -mr-2 shrink-0">
      <button
        ref={toggle}
        type="button"
        aria-label="More"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex size-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Ellipsis className="size-5" aria-hidden />
      </button>
      <div
        id={panel}
        hidden={!open}
        className="absolute top-full right-0 z-50 mt-1 w-48 rounded-md border border-line bg-surface p-1.5 shadow-2"
      >
        {items.map((item) =>
          'href' in item ? (
            <Link key={item.label} href={item.href} className={row}>
              {item.label}
            </Link>
          ) : (
            <button
              key={item.label}
              type="button"
              className={row}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The top of a practice chat on a phone, in one row so the chat gets the screen: who's asking,
 * how trained the Charm is, and the rest behind a menu. The meter is the line along its bottom.
 */
export function PracticeBar({
  run,
  charm,
  menu,
}: {
  run: PracticeRun | null;
  charm: CharmView | null;
  menu: PracticeMenuItem[];
}) {
  const customer = run?.customer;
  const score = charm?.readiness.score ?? null;
  const gain = useScoreGain(score);
  const about = ['Practice', customer?.place, distanceText(customer?.distance)]
    .filter(Boolean)
    .join(' · ');
  return (
    <header
      className="sticky z-40 bg-bg/92 backdrop-blur-md sm:hidden"
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="gutter flex h-13 items-center gap-2.5">
        {customer ? (
          <Avatar initials={customer.initials} tone={customer.tone} />
        ) : (
          <span className="shimmer size-9 shrink-0 rounded-full" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] leading-5 font-semibold">
            {customer?.name ?? 'Your next practice customer'}
          </h1>
          <p className="truncate text-xs leading-4 text-muted">{about}</p>
        </div>
        <p className="tabular shrink-0 text-sm" aria-live="polite">
          {gain > 0 && <span className="mr-1.5 font-semibold text-go">+{gain}</span>}
          {score === null ? '…' : `${score}%`} trained
        </p>
        <PracticeMenu items={menu} />
      </div>
      <Meter score={score ?? 0} mark={charm?.settings.trainedPercent ?? 60} size="line" />
    </header>
  );
}
