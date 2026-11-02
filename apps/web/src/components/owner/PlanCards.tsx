'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button, Segmented, Tag } from '@/components/ui';
import type { Billing } from '@/lib/owner';
import { choiceOf, type Plan, type PlanChoice } from '@/lib/plans';
import { cx, money, shortDate } from '@/lib/util';

type Card = {
  label: string;
  price: string;
  unit: string;
  line: string;
  points: string[];
};

/**
 * The three ways to pay, as cards side by side, in the order this business is shown them. Each has
 * its own button. None is marked as the one to pick, so what owners choose says what they'd pay.
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
  /** The words on a plan's button. */
  action: (plan: Plan) => string;
}) {
  const { pricing, freeWeek } = billing;
  const { subscription, accepted } = pricing;
  const [yearly, setYearly] = useState(current === 'yearly');
  const saving = subscription.monthlyCents * 12 - subscription.yearlyCents;

  const cards: Record<PlanChoice, Card> = {
    per_quote: {
      label: 'Pay per quote',
      price: money(pricing.perQuoteCents),
      unit: 'per quote',
      line: 'Each time a customer gets a quote from you.',
      points: ['Nothing up front', 'No monthly fee', 'Stop any time'],
    },
    per_accepted: {
      label: 'Pay when you win',
      price: `${accepted.basisPoints / 100}%`,
      unit: 'of the job',
      line: 'Only when a customer accepts your quote.',
      points: [
        'Nothing up front',
        `At least ${money(accepted.minimumFeeCents)}, never more than ${money(accepted.maximumFeeCents)}`,
        'Nothing if they say no',
      ],
    },
    subscription: {
      label: 'Subscription',
      price: money(yearly ? subscription.yearlyCents : subscription.monthlyCents),
      unit: yearly ? 'a year' : 'a month',
      line: '',
      points: [
        // With a code every plan starts free, as the line under them says.
        ...(freeWeek && !billing.code ? ['First week free'] : []),
        `${subscription.includedQuotes} quotes a month included`,
        `${money(subscription.overageCents)} a quote after that`,
      ],
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3" role="list" aria-label="Plans">
        {billing.planOrder.map((choice) => {
          const card = cards[choice];
          const plan: Plan = choice === 'subscription' ? (yearly ? 'yearly' : 'monthly') : choice;
          const mine = current !== null && current === plan;
          const onIt = current !== null && choiceOf(current) === choice;
          return (
            <article
              key={choice}
              role="listitem"
              aria-label={card.label}
              className={cx(
                'flex flex-col rounded-lg border bg-surface p-6 shadow-1 transition-colors',
                onIt ? 'border-ink' : 'border-line hover:border-line-strong',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="t-label text-muted">{card.label}</h3>
                {onIt && <Tag tone="go">Current</Tag>}
              </div>
              <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
                <span className="qf-total text-[56px]">
                  <span className="hl">{card.price}</span>
                </span>
                <span className="text-lg text-ink-2">{card.unit}</span>
              </p>
              {choice === 'subscription' ? (
                // Where the others say when you pay: monthly or yearly, and what yearly saves.
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Segmented
                    label="Pay monthly or yearly"
                    value={yearly ? 'yearly' : 'monthly'}
                    onChange={(value) => setYearly(value === 'yearly')}
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
              ) : (
                <p className="mt-2 text-[15px] text-ink-2">{card.line}</p>
              )}
              <ul className="mt-5 flex flex-col gap-2.5 border-t border-line pt-5 text-[15px]">
                {card.points.map((point) => (
                  <li key={point} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-go" aria-hidden />
                    {point}
                  </li>
                ))}
              </ul>
              {/* Buttons line up along the bottom, however much each card says. */}
              <div className="mt-auto pt-7">
                <Button
                  size="lg"
                  variant={mine ? 'secondary' : 'primary'}
                  className="w-full"
                  disabled={mine || Boolean(busy)}
                  onClick={() => onChoose(plan)}
                >
                  {busy === plan ? 'Opening…' : mine ? 'Your plan' : action(plan)}
                </Button>
              </div>
            </article>
          );
        })}
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
