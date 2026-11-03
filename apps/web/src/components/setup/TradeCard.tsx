import type { ReactNode } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cx } from '@/lib/util';

/** One trade to pick in setup, as a radio. Tapping it moves on, even when it's already picked. */
export function TradeCard({
  icon: Icon,
  selected,
  busy,
  onClick,
  className,
  children,
}: {
  icon: LucideIcon;
  selected: boolean;
  /** Saving this pick and opening the next screen. */
  busy?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={cx(
        'relative flex min-h-[72px] min-w-0 items-center gap-2.5 rounded-md border px-3 py-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] sm:gap-3 sm:px-4',
        selected
          ? 'border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]'
          : 'border-line bg-surface hover:border-line-strong',
        busy && 'opacity-80',
        className,
      )}
    >
      <Icon
        className={cx('size-6 shrink-0', selected ? 'text-accent' : 'text-ink-2')}
        aria-hidden
      />
      {/* Whole words on a phone: "Landscaping" fits a card 360px wide. Narrower ones hyphenate. */}
      <span className="min-w-0 pr-3 text-[15px] leading-tight font-semibold break-words hyphens-auto max-[379px]:text-[14px]">
        {children}
      </span>
      {selected && (
        <span className="absolute top-1.5 right-1.5 inline-flex size-4 items-center justify-center rounded-full bg-accent text-on-accent">
          <Check className="size-3" aria-hidden />
        </span>
      )}
    </button>
  );
}
