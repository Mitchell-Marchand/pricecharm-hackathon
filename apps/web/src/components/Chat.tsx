'use client';

import type { ReactNode } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Avatar } from './ui';
import { PhotoGrid } from './Photos';
import type { Logo } from '@/lib/chat';
import { cx } from '@/lib/util';

/**
 * The business's logo on a tile of paper, which stays white in both themes as logos expect, or its
 * initials. A wide logo gets a wider tile, unless it has to fit a square.
 */
export function BusinessMark({
  initials,
  logo,
  square = false,
}: {
  initials: string;
  logo?: Logo | null;
  square?: boolean;
}) {
  if (!logo) return <Avatar initials={initials || 'Q'} tone="ink" />;
  const wide = !square && logo.width / logo.height > 1.6;
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-[var(--paper)]',
        wide ? 'h-9 max-w-[124px] px-1.5 py-1' : 'size-9 p-1',
      )}
    >
      <img
        src={logo.url}
        alt=""
        width={logo.width}
        height={logo.height}
        className={wide ? 'h-full w-auto object-contain' : 'size-full object-contain'}
      />
    </span>
  );
}

export function CustomerMessage({
  name,
  initials,
  tone,
  photos,
  children,
  showAvatar = true,
}: {
  name: string;
  initials: string;
  tone: 'canary' | 'pink' | 'blue';
  photos?: string[];
  children?: ReactNode;
  showAvatar?: boolean;
}) {
  return (
    <div className="fade-up flex items-end gap-2.5">
      <div className="w-9 shrink-0">{showAvatar && <Avatar initials={initials} tone={tone} />}</div>
      <div
        className={cx(
          'min-w-0 rounded-[16px] rounded-bl-[4px] border border-line bg-surface shadow-1',
          photos?.length ? 'w-full max-w-[420px] p-2' : 'max-w-[85%] px-4 py-3 sm:max-w-[75%]',
        )}
      >
        <span className="sr-only">{name}: </span>
        {children && (
          <p
            className={cx(
              'text-[15.5px] leading-[1.55] text-ink',
              photos?.length ? 'px-2 pt-1 pb-2.5' : undefined,
            )}
          >
            {children}
          </p>
        )}
        {photos && <PhotoGrid photos={photos} label={name} />}
      </div>
    </div>
  );
}

export function OwnerMessage({ children }: { children: ReactNode }) {
  return (
    <div className="fade-up flex justify-end">
      <p className="max-w-[85%] rounded-[16px] rounded-br-[4px] bg-ink px-4 py-3 text-[15.5px] leading-[1.55] text-on-ink sm:max-w-[75%]">
        <span className="sr-only">You: </span>
        {children}
      </p>
    </div>
  );
}

export function SiteVisitMessage({ reason }: { reason: string }) {
  return (
    <div className="fade-up flex justify-end">
      <div className="max-w-[85%] rounded-[16px] rounded-br-[4px] bg-ink px-4 py-3 text-on-ink sm:max-w-[75%]">
        <p className="t-label flex items-center gap-1.5 text-on-ink/70">
          <CalendarCheck className="size-3.5" aria-hidden /> Asked for a site visit
        </p>
        <p className="mt-1.5 text-[15.5px] leading-[1.55]">
          I'd like to take a look in person before I give you a price. {reason}
        </p>
      </div>
    </div>
  );
}

export function Typing({
  name,
  initials,
  tone,
  logo,
}: {
  name: string;
  initials: string;
  tone: 'canary' | 'pink' | 'blue';
  /** The business's own logo, in place of its initials. */
  logo?: Logo | null;
}) {
  return (
    <div className="fade-up flex items-end gap-2.5" role="status">
      <div className="w-9 shrink-0">
        {logo ? (
          <BusinessMark initials={initials} logo={logo} square />
        ) : (
          <Avatar initials={initials} tone={tone} />
        )}
      </div>
      <div className="typing flex h-11 items-center gap-1.5 rounded-[16px] rounded-bl-[4px] border border-line bg-surface px-4 text-muted shadow-1">
        <span />
        <span />
        <span />
        <span className="sr-only">{name} is typing</span>
      </div>
    </div>
  );
}
