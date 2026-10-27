'use client';

import Link from 'next/link';
import { cx } from '@/lib/util';

/** A price tag on a ring, like a charm: the product's mark, beside a wide wordmark. */
export function Logo({
  className,
  onClick,
  href,
}: {
  className?: string;
  onClick?: () => void;
  href?: string;
}) {
  const content = (
    <>
      <svg viewBox="0 0 28 28" className="size-[28px] shrink-0" aria-hidden>
        <g transform="rotate(-45 14 14) translate(0 -2.35)">
          <circle cx="14" cy="9.6" r="4" fill="none" stroke="var(--canary)" strokeWidth="2.2" />
          <path
            d="M14 10 20.5 15.5V27H7.5V15.5Z"
            fill="var(--canary)"
            stroke="var(--canary)"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
        </g>
      </svg>
      <span className="font-display text-[21px] leading-none font-[850] tracking-[-0.03em] text-ink [font-stretch:118%]">
        pricecharm
      </span>
    </>
  );
  const classes = cx('inline-flex items-center gap-2', className);
  if (href)
    return (
      <Link href={href} className={classes} aria-label="PriceCharm home">
        {content}
      </Link>
    );
  return onClick ? (
    <button type="button" onClick={onClick} className={classes} aria-label="PriceCharm home">
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  );
}
