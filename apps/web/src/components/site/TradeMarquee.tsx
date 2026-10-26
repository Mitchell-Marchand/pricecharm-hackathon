import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { TRADES } from '@/lib/trades';
import { cx } from '@/lib/util';

const ROWS = [TRADES.slice(0, 8), TRADES.slice(8, 16), TRADES.slice(16)];

/** Every trade Quotefolk sets up for, drifting past in three rows. Decorative only. */
export function TradeMarquee() {
  return (
    <div
      className="marquee-frame flex h-44 w-full min-w-0 flex-col justify-center gap-2.5 overflow-hidden rounded-md bg-surface-2 py-5"
      aria-hidden
    >
      {ROWS.map((row, position) => (
        <div
          key={position}
          className={cx('marquee', position % 2 === 1 && 'is-reverse')}
          style={{ '--marquee-duration': `${36 + position * 8}s` } as CSSProperties}
        >
          {[...row, ...row].map(({ id, name, icon: Icon }, index) => {
            const picked = position === 0 && id === 'pressure-washing';
            return (
              <span
                key={`${id}-${index}`}
                className={cx(
                  // A margin rather than a gap, so the two copies are exactly half the row each.
                  'mr-2 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap',
                  picked
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line-strong bg-surface text-ink-2',
                )}
              >
                {picked ? (
                  <Check className="size-4 text-accent" />
                ) : (
                  <Icon className="size-4 text-muted" />
                )}
                {name}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
