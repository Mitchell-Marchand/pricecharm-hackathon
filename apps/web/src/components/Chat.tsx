'use client';

import type { ReactNode } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Avatar } from './ui';
import { PhotoGrid } from './Photos';
import { cx } from '@/lib/util';

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
}: {
  name: string;
  initials: string;
  tone: 'canary' | 'pink' | 'blue';
}) {
  return (
    <div className="fade-up flex items-end gap-2.5" role="status">
      <div className="w-9 shrink-0">
        <Avatar initials={initials} tone={tone} />
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
