'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { Logo } from '@/lib/chat';
import { discountCents, rangeOf, total, type Quote } from '@/lib/quote';
import { addDays, cx, lowerFirst, money, prefersReducedMotion, shortDate } from '@/lib/util';

export type Stamp = 'practice' | 'sent' | 'accepted' | 'draft';
const STAMP_TEXT: Record<Stamp, string> = {
  practice: 'Practice',
  sent: 'Sent',
  accepted: 'Accepted',
  draft: 'Draft',
};

function useCountUp(target: number, animate: boolean): number {
  const [value, setValue] = useState(() => (animate && !prefersReducedMotion() ? 0 : target));
  useEffect(() => {
    if (!animate || prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start - 300) / 750));
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(progress < 1 ? Math.round((target * eased) / 100) * 100 : target);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);
  return value;
}

function FormField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="t-label text-[10px]! text-paper-muted">{label}</p>
      <p className="qf-rule truncate pb-1 text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

/**
 * The signature quote: an estimate-pad sheet over its canary and pink copies.
 * One component renders practice quotes, customer quotes and the landing page sample. A quote for
 * a service the Charm is still learning can be a price range, or a price marked as an estimate.
 */
export function QuoteForm({
  quote,
  business,
  logo,
  stamp,
  animate = false,
  compact = false,
  footnote,
  actions,
}: {
  quote: Quote;
  business: string;
  /** Printed at the top of the sheet, like an estimate pad's letterhead. */
  logo?: Logo | null;
  stamp?: Stamp;
  animate?: boolean;
  compact?: boolean;
  footnote?: string;
  actions?: ReactNode;
}) {
  const sum = total(quote);
  const off = discountCents(quote);
  const range = rangeOf(quote);
  const shown = useCountUp(sum, animate);
  const low = useCountUp(range?.lowCents ?? 0, animate);
  const high = useCountUp(range?.highCents ?? 0, animate);
  const pad = compact ? 'px-4' : 'px-5 sm:px-6';
  // A range shows what's included, not what each part costs.
  const amount = (cents: string) => (range ? '' : cents);
  return (
    <div className={cx('qf-stack', animate && 'quote-in')}>
      <div className="qf-copy is-pink" aria-hidden />
      <div className="qf-copy is-canary" aria-hidden />
      <article
        className="qf"
        aria-label={`${quote.style === 'estimate' ? 'Estimate' : 'Quote'} number ${quote.number} from ${business}, ${range ? `price range ${money(range.lowCents)} to ${money(range.highCents)}` : `total ${money(sum)}`}`}
      >
        <header
          className={cx('flex items-start justify-between gap-4', compact ? 'pt-6' : 'pt-7', pad)}
        >
          <div className="min-w-0">
            {logo && !compact && (
              <img
                src={logo.url}
                alt=""
                width={logo.width}
                height={logo.height}
                className="mb-3 h-10 w-auto max-w-[160px] object-contain object-left"
              />
            )}
            <p className="t-label truncate text-paper-muted">{business}</p>
            <p
              className={cx(
                'font-display leading-none font-[820] tracking-[-0.02em] [font-stretch:112%]',
                compact ? 'mt-1 text-[22px]' : 'mt-1.5 text-[28px]',
              )}
            >
              {quote.style === 'estimate' ? 'Estimate' : 'Quote'}
            </p>
          </div>
          <p className="qf-no shrink-0 text-sm">No. {quote.number}</p>
        </header>

        <div className={cx('mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6', pad)}>
          {quote.customer || quote.place ? (
            <FormField
              label="For"
              value={[quote.customer, quote.place].filter(Boolean).join(' · ')}
            />
          ) : (
            <span />
          )}
          <FormField label="Date" value={shortDate(quote.issuedAt)} />
        </div>

        <table className={cx('mt-4 w-full', compact ? 'text-sm' : 'text-[15px]')}>
          <thead className="sr-only">
            <tr>
              <th>Item</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((line) => (
              <tr key={line.id} className="qf-rule">
                <td
                  className={cx(
                    'py-2.5 pr-3 align-top wrap-anywhere',
                    compact ? 'pl-4' : 'pl-5 sm:pl-6',
                  )}
                >
                  {line.label}
                </td>
                <td
                  className={cx(
                    'tabular py-2.5 text-right align-top font-mono whitespace-nowrap',
                    compact ? 'pr-4' : 'pr-5 sm:pr-6',
                  )}
                >
                  {amount(money(line.amountCents))}
                </td>
              </tr>
            ))}
            {quote.discount && off > 0 && (
              <tr className="qf-rule text-[var(--stamp-green)]">
                <td className={cx('py-2.5 pr-3 align-top', compact ? 'pl-4' : 'pl-5 sm:pl-6')}>
                  {quote.discount.kind === 'percent' ? `${quote.discount.value}% off` : 'Discount'}
                  {quote.discount.reason ? `, ${lowerFirst(quote.discount.reason)}` : ''}
                </td>
                <td
                  className={cx(
                    'tabular py-2.5 text-right align-top font-mono whitespace-nowrap',
                    compact ? 'pr-4' : 'pr-5 sm:pr-6',
                  )}
                >
                  {amount(`−${money(off)}`)}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* On a phone, a big total or a stamp drops to its own line, still on the right. */}
        <div
          className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-4', pad)}
        >
          <span className="t-label shrink-0 text-paper-muted">
            {range ? 'Price range' : 'Total'}
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
            {stamp && (
              <span className={cx('qf-stamp', `is-${stamp}`, animate && 'is-animated')}>
                {STAMP_TEXT[stamp]}
              </span>
            )}
            {range ? (
              <span className={cx('qf-total text-right', compact ? 'text-[22px]' : 'text-[30px]')}>
                <span className="hl">
                  {money(low)}–{money(high)}
                </span>
              </span>
            ) : (
              <span className={cx('qf-total', compact ? 'text-[32px]' : 'text-[42px]')}>
                <span className="hl">{money(shown)}</span>
              </span>
            )}
          </div>
        </div>

        {!compact && (
          <>
            {/* A blank the owner never set says nothing, so it's left off. */}
            <div className={cx('mt-5 grid grid-cols-3 gap-x-4', pad)}>
              {quote.start.trim() && <FormField label="Can start" value={quote.start} />}
              {quote.duration.trim() && (
                <FormField label="Takes about" value={quote.duration.replace(/^about\s+/i, '')} />
              )}
              <FormField label="Good until" value={addDays(quote.issuedAt, quote.validDays)} />
            </div>
            {(quote.included.length > 0 || quote.excluded.length > 0) && (
              <div className={cx('mt-5 grid gap-4 sm:grid-cols-2', pad)}>
                {quote.included.length > 0 && (
                  <div>
                    <p className="t-label text-[10px]! text-paper-muted">Included</p>
                    <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                      {quote.included.map((item) => (
                        <li key={item} className="flex gap-2 wrap-anywhere">
                          <Check
                            className="mt-0.5 size-4 shrink-0 text-[var(--stamp-green)]"
                            aria-hidden
                          />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {quote.excluded.length > 0 && (
                  <div>
                    <p className="t-label text-[10px]! text-paper-muted">Not included</p>
                    <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                      {quote.excluded.map((item) => (
                        <li key={item} className="flex gap-2 wrap-anywhere">
                          <X className="mt-0.5 size-4 shrink-0 text-paper-muted" aria-hidden />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {footnote && (
          <p className={cx('mt-5 text-[13px] text-paper-muted wrap-anywhere', pad)}>{footnote}</p>
        )}
        {/* Buttons fill each row, so on a phone they stack full width instead of ragged. */}
        {actions && <div className={cx('mt-5 flex flex-wrap gap-2 *:grow', pad)}>{actions}</div>}
        <div className={compact ? 'h-5' : 'h-6'} />
      </article>
    </div>
  );
}

/** Buttons that sit on paper keep paper colors in both themes. */
export function PaperButton({
  children,
  onClick,
  primary,
  disabled,
  sample,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Looks like the button but does nothing, for sample quotes on marketing pages. */
  sample?: boolean;
}) {
  const Element = sample ? 'span' : 'button';
  return (
    <Element
      {...(sample ? {} : { type: 'button' as const, onClick, disabled })}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-sm px-4 py-2 text-center text-[15px] font-semibold transition-[filter,background-color] disabled:opacity-50 [&_svg]:size-4',
        primary
          ? 'bg-[var(--canary)] text-[var(--paper-ink)] shadow-[inset_0_-2px_0_rgb(16_22_51/0.18)] hover:brightness-[1.03]'
          : 'border border-[var(--paper-rule)] bg-[var(--paper)] text-[var(--paper-ink)] hover:bg-[var(--paper-hover)]',
      )}
    >
      {children}
    </Element>
  );
}
