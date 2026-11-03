'use client';

import { useState } from 'react';
import { CalendarDays, Check, Handshake, Receipt, type LucideIcon } from 'lucide-react';
import { Button, Segmented, Tag } from '@/components/ui';
import type { Billing } from '@/lib/owner';
import { choiceOf, type Plan, type PlanChoice } from '@/lib/plans';
import { cx, money, shortDate } from '@/lib/util';

type Card = {
  label: string;
  icon: LucideIcon;
  price: string;
  unit: string;
  /** When they pay, in a few words. */
  when: string;
  points: string[];
};

/**
 * The three ways to pay, as a choice of one: tap a plan to pick it, then one button below goes on
 * with it. They come in the order this business is shown them, and none starts picked or is
 * marked as the one to pick, so what owners choose says what they'd pay.
 */
export function PlanCards({
  billing,
  current = null,
  busy = null,
  onChoose,
  action,
}: {
  billing: Billing;
  /** The plan they're on now: marked, and not offered again. */
  current?: Plan | null;
  /** The plan whose button is working. */
  busy?: Plan | null;
  onChoose: (plan: Plan) => void;
  /** The words on the button for the picked plan. */
  action: (plan: Plan) => string;
}) {
  const { pricing, freeWeek } = billing;
  const { subscription, accepted } = pricing;
  const [yearly, setYearly] = useState(current === 'yearly');
  const [picked, setPicked] = useState<PlanChoice | null>(null);
  const [nudged, setNudged] = useState(false);
  const saving = subscription.monthlyCents * 12 - subscription.yearlyCents;

  const cards: Record<PlanChoice, Card> = {
    per_quote: {
      label: 'Pay per quote',
      icon: Receipt,
      price: money(pricing.perQuoteCents),
      unit: 'per quote',
      when: 'You pay when a customer sees a quote.',
      points: ['Nothing up front', 'No monthly fee', 'Stop any time'],
    },
    per_accepted: {
      label: 'Pay when you win',
      icon: Handshake,
      price: `${accepted.basisPoints / 100}%`,
      unit: 'of the job',
      when: 'You pay when a customer says yes.',
      points: [
        'Nothing up front',
        `At least ${money(accepted.minimumFeeCents)}, never more than ${money(accepted.maximumFeeCents)}`,
        'Nothing if they say no',
      ],
    },
    subscription: {
      label: 'Subscription',
      icon: CalendarDays,
      price: money(yearly ? subscription.yearlyCents : subscription.monthlyCents),
      unit: yearly ? 'a year' : 'a month',
      when: yearly ? 'One price a year.' : 'One price a month.',
      points: [
        // With a code every plan starts free, as the line under them says.
        ...(freeWeek && !billing.code ? ['First week free'] : []),
        `${subscription.includedQuotes} quotes a month included`,
        `${money(subscription.overageCents)} a quote after that`,
      ],
    },
  };
  const planOf = (choice: PlanChoice): Plan =>
    choice === 'subscription' ? (yearly ? 'yearly' : 'monthly') : choice;
  const chosen = picked ? planOf(picked) : null;
  const mine = chosen !== null && current === chosen;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3 md:gap-4" role="radiogroup" aria-label="Plans">
        {billing.planOrder.map((choice) => {
          const card = cards[choice];
          const Icon = card.icon;
          const on = picked === choice;
          const onIt = current !== null && choiceOf(current) === choice;
          return (
            <div key={choice} className="flex flex-col gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={card.label}
                onClick={() => {
                  setPicked(choice);
                  setNudged(false);
                }}
                className={cx(
                  'relative flex flex-1 flex-col rounded-lg border-2 bg-surface p-5 text-left shadow-1 transition-[border-color,background-color,opacity] duration-150 sm:p-6',
                  on
                    ? 'border-ink bg-canary-soft'
                    : nudged
                      ? 'border-canary'
                      : 'border-line hover:border-line-strong',
                  picked && !on && 'opacity-70',
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <Icon className="size-5 text-ink-2" aria-hidden />
                    <span className="t-label text-muted">{card.label}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {onIt && <Tag tone="go">Current</Tag>}
                    <span
                      className={cx(
                        'inline-flex size-6 items-center justify-center rounded-full border-2',
                        on ? 'border-ink bg-ink text-on-ink' : 'border-line-strong',
                      )}
                      aria-hidden
                    >
                      {on && <Check className="size-4" />}
                    </span>
                  </span>
                </span>
                <span className="mt-4 flex flex-wrap items-baseline gap-x-2">
                  <span className="qf-total text-[44px] sm:text-[52px]">
                    <span className="hl">{card.price}</span>
                  </span>
                  <span className="text-lg text-ink-2">{card.unit}</span>
                </span>
                <span className="mt-1.5 text-[15px] font-semibold">{card.when}</span>
                {/* On a phone, the details open on the plan they pick. */}
                <ul
                  className={cx(
                    'mt-4 flex-col gap-2 border-t border-line pt-4 text-[15px]',
                    on ? 'flex' : 'hidden md:flex',
                  )}
                >
                  {card.points.map((point) => (
                    <li key={point} className="flex gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-go" aria-hidden />
                      {point}
                    </li>
                  ))}
                </ul>
              </button>
              {choice === 'subscription' && (
                // Monthly or yearly, and what yearly saves. Picking either picks the subscription.
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
                  <Segmented
                    label="Pay monthly or yearly"
                    value={yearly ? 'yearly' : 'monthly'}
                    onChange={(value) => {
                      setYearly(value === 'yearly');
                      setPicked('subscription');
                    }}
                    options={[
                      { value: 'monthly', label: 'Monthly' },
                      { value: 'yearly', label: 'Yearly' },
                    ]}
                  />
                  {saving > 0 && (
                    <span
                      className={cx('text-sm', yearly ? 'font-semibold text-go' : 'text-muted')}
                    >
                      Save {money(saving)}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          size="lg"
          className="w-full sm:w-auto"
          disabled={Boolean(busy) || mine}
          onClick={() => {
            if (chosen) return onChoose(chosen);
            // Nothing picked yet: the button points at the plans instead of doing nothing.
            setNudged(true);
          }}
        >
          {busy && busy === chosen
            ? 'Opening…'
            : mine
              ? 'Your plan'
              : chosen
                ? action(chosen)
                : 'Pick a plan'}
        </Button>
        {nudged && !picked && (
          <p className="text-sm text-stop" role="alert">
            Tap one of the plans above first.
          </p>
        )}
      </div>

      {/* Under every plan alike, so it doesn't favor one. */}
      {billing.code ? (
        <p className="text-[15px] text-ink-2">
          {billing.code.endsAt
            ? `With code ${billing.code.code}, quotes are free until ${shortDate(billing.code.endsAt)}, whichever plan you’re on.`
            : `With code ${billing.code.code}, your first ${billing.code.days} days are free, whichever plan you pick.`}
        </p>
      ) : billing.firstMonth && pricing.firstMonthMaxCents ? (
        <p className="text-[15px] text-ink-2">
          Whichever you pick, your quote fees stop at {money(pricing.firstMonthMaxCents)} for the
          first 30 days. Quotes past that still go out, and you don’t pay for them.
        </p>
      ) : null}
    </div>
  );
}
