'use client';

import Link from 'next/link';
import { useId } from 'react';
import { cx } from '@/lib/util';

/** A tear-off estimate slip, the product's mark, beside a wide wordmark. */
export function Logo({
  className,
  onClick,
  href,
}: {
  className?: string;
  onClick?: () => void;
  href?: string;
}) {
  const maskId = `slip-${useId().replace(/:/g, '')}`;
  const content = (
    <>
      <svg viewBox="0 0 24 28" className="h-[26px] w-[22px] shrink-0" aria-hidden>
        <defs>
          <mask id={maskId}>
            <rect width="24" height="28" fill="#fff" />
            <circle cx="7" cy="2" r="2.1" fill="#000" />
            <circle cx="12" cy="2" r="2.1" fill="#000" />
            <circle cx="17" cy="2" r="2.1" fill="#000" />
          </mask>
        </defs>
        <rect
          x="2"
          y="2"
          width="20"
          height="24"
          rx="2.5"
          fill="var(--canary)"
          mask={`url(#${maskId})`}
        />
        <path
          d="M6.5 11h11M6.5 15.5h11M6.5 20h6.5"
          stroke="#101633"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-display text-[21px] leading-none font-[850] tracking-[-0.03em] text-ink [font-stretch:118%]">
        quotefolk
      </span>
    </>
  );
  const classes = cx('inline-flex items-center gap-2', className);
  if (href)
    return (
      <Link href={href} className={classes} aria-label="Quotefolk home">
        {content}
      </Link>
    );
  return onClick ? (
    <button type="button" onClick={onClick} className={classes} aria-label="Quotefolk home">
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  );
}
