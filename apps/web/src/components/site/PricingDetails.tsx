'use client';

import { useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  CalendarCheck,
  Check,
  Gauge,
  Globe,
  Hand,
  Sprout,
} from 'lucide-react';
import { buttonClass } from '@/components/button-class';
import { ButtonLink, MoneyInput, Segmented, Tag } from '@/components/ui';
import { setCurrency } from '@/lib/currency';
import { freeTime, type Pricing } from '@/lib/plans';
import { cx, money, moneyInput, parseMoney } from '@/lib/util';
import { useVisitorPricing } from './UpFront';

/**
 * The pricing page below the header. Training is free; going live means picking one of three
 * plans. The numbers come from the API, in the visitor's own currency once the browser says where
 * it is, so nothing here can drift from what billing charges.
 */
export function PricingDetails({ initial }: { initial: Pricing }) {
  const pricing = useVisitorPricing(initial);
  // The calculator's money field shows this currency's symbol.
  setCurrency(pricing.currency);
  return (
    <>
      <Hero pricing={pricing} />
      <Plans pricing={pricing} />
      <Calculator pricing={pricing} />
      <EveryPlan pricing={pricing} />
      <Questions />
      <section className="bg-ink text-on-ink">
        <div className="gutter mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
          <div>
            <h2 className="t-h1 max-w-xl">Training is free. Start yours today.</h2>
            <p className="mt-3 text-on-ink/75">
              About 5 minutes to set up. No card until you go live.
            </p>
          </div>
          <ButtonLink href="/start" variant="quote" size="lg">
            Get started <ArrowRight aria-hidden />
          </ButtonLink>
        </div>
      </section>
    </>
  );
}

function Hero({ pricing }: { pricing: Pricing }) {
  const zero = money(0, pricing.currency);
  const lines = [
    'Setting up your trade and services',
    'Practice quotes, as many as you like',
    'Trying it yourself as a customer',
    'Adding past jobs and old invoices',
    ...(pricing.trialQuotes > 0 ? [`Your first ${pricing.trialQuotes} customer quotes`] : []),
  ];
  return (
    <section className="gutter mx-auto grid max-w-6xl items-center gap-14 pt-6 pb-20 md:grid-cols-[1.15fr_1fr] md:gap-10 md:pt-14 md:pb-24">
      <div className="max-w-[600px]">
        <Tag tone="canary" size="lg">
          Pricing
        </Tag>
        <h1 className="t-hero mt-5">Free to train. Then pick how you pay.</h1>
        <p className="mt-6 max-w-[34rem] text-lg text-ink-2">
          Set up your Charm, practice on pretend customers and try it yourself for as long as you
          like, with no card. When you’re ready for real customers, choose the one plan that suits
          your business. You can switch whenever you want.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <ButtonLink href="/start" size="lg">
            Start training free <ArrowRight aria-hidden />
          </ButtonLink>
          <a href="#plans" className={buttonClass('secondary', 'lg')}>
            See the plans
          </a>
        </div>
        <p className="mt-4 text-sm text-muted">About 5 minutes · No card to start</p>
      </div>

      {/* What training costs, on the same estimate pad customers' quotes are written on. */}
      {/* The copies sit a little right of the sheet; the padding keeps them on the screen. */}
      <div className="rise mx-auto w-full max-w-[436px] rotate-[1.2deg] pr-4 md:mx-0 md:justify-self-end">
        <div className="qf-stack">
          <div className="qf-copy is-pink" aria-hidden />
          <div className="qf-copy is-canary" aria-hidden />
          <article className="qf pb-6" aria-label={`What training costs: ${zero}`}>
            <header className="flex items-start justify-between gap-4 px-6 pt-7">
              <div>
                <p className="t-label text-paper-muted">Your Charm</p>
                <p className="mt-1.5 font-display text-[28px] leading-none font-[820] tracking-[-0.02em] [font-stretch:112%]">
                  Training
                </p>
              </div>
              <p className="qf-no shrink-0 text-sm">No. 0001</p>
            </header>
            <table className="mt-5 w-full text-[15px]">
              <thead className="sr-only">
                <tr>
                  <th>Item</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line} className="qf-rule">
                    <td className="py-2.5 pr-3 pl-6 align-top">{line}</td>
                    <td className="tabular py-2.5 pr-6 text-right align-top font-mono">{zero}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
              <span className="t-label text-paper-muted">Total</span>
              <div className="ml-auto flex items-center gap-3">
                <span className="qf-stamp is-free is-animated">Free</span>
                <span className="qf-total text-[42px]">
                  <span className="hl">{zero}</span>
                </span>
              </div>
            </div>
            <p className="mt-4 px-6 text-sm text-paper-muted">No card needed until you go live.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

type PlanCard = {
  label: string;
  price: string;
  unit: string;
  perk?: string;
  fit: string;
  points: string[];
};

function Plans({ pricing }: { pricing: Pricing }) {
  const c = pricing.currency;
  const { subscription: sub, accepted } = pricing;
  // Below this many quotes a month, paying per quote costs less than the subscription.
  const cheaperUpTo = Math.ceil(sub.monthlyCents / pricing.perQuoteCents) - 1;
  const yearSaves = sub.monthlyCents * 12 - sub.yearlyCents;
  const nothingUpFront = `${money(0, c)} up front`;
  const cards: PlanCard[] = [
    {
      label: 'Per quote',
      price: money(pricing.perQuoteCents, c),
      unit: 'per quote',
      perk: nothingUpFront,
      fit: 'Best for a few quotes a week.',
      points: [
        'You pay each time a customer is shown a quote',
        'No monthly fee',
        `Costs less than the subscription up to ${cheaperUpTo} quotes a month`,
      ],
    },
    {
      label: 'When they say yes',
      price: `${accepted.basisPoints / 100}%`,
      unit: 'of accepted quotes',
      perk: nothingUpFront,
      fit: 'Best if you only want to pay for work you win.',
      points: [
        'Nothing when they say no',
        `At least ${money(accepted.minimumFeeCents, c)}, never more than ${money(accepted.maximumFeeCents, c)} a quote`,
        'No monthly fee',
      ],
    },
    {
      label: 'Subscription',
      price: money(sub.monthlyCents, c),
      unit: 'a month',
      perk: sub.trialDays > 0 ? `First ${freeTime(sub.trialDays)} free` : undefined,
      fit: 'Best if you quote a lot.',
      points: [
        `${sub.includedQuotes} quotes a month included, then ${money(sub.overageCents, c)} each`,
        yearSaves > 0
          ? `Or ${money(sub.yearlyCents, c)} a year, which saves ${money(yearSaves, c)}`
          : `Or ${money(sub.yearlyCents, c)} a year`,
        'Cancel any time',
      ],
    },
  ];
  return (
    <section
      id="plans"
      aria-labelledby="plans-title"
      className="gutter mx-auto max-w-6xl scroll-mt-6 pb-20"
    >
      <p className="t-label text-muted">When you go live</p>
      <h2 id="plans-title" className="t-h1 mt-2">
        Pick one way to pay.
      </h2>
      <p className="mt-4 max-w-2xl text-lg text-ink-2">
        You choose when you’re ready for real customers, not before. Every plan gets the same Charm
        with everything in it. Only the bill works differently.
      </p>
      {/* One choice, not a sum: an "or" sits on the seam between each pair of plans. */}
      <div className="mt-10 grid gap-y-3 lg:grid-cols-[minmax(0,1fr)_0_minmax(0,1fr)_0_minmax(0,1fr)] lg:gap-x-3">
        {cards.map((card, index) => (
          <PlanCardView key={card.label} card={card} or={index > 0} />
        ))}
      </div>
    </section>
  );
}

function PlanCardView({ card, or }: { card: PlanCard; or: boolean }) {
  return (
    <>
      {or && (
        <div
          aria-hidden
          className="relative z-10 flex h-0 items-center justify-center lg:h-auto lg:w-0"
        >
          <span className="t-label flex size-11 shrink-0 items-center justify-center rounded-full border border-line-strong bg-bg text-ink">
            or
          </span>
        </div>
      )}
      <article className="flex flex-col rounded-lg border border-line bg-surface p-6 shadow-1 sm:p-7">
        <h3 className="t-label text-muted">{card.label}</h3>
        {/* The unit sits under the price on every card, so the three line up side by side. */}
        <p className="mt-4 flex flex-col gap-1.5">
          <span className="qf-total text-[52px]">{card.price}</span>{' '}
          <span className="text-lg text-ink-2">{card.unit}</span>
        </p>
        {card.perk && (
          <p className="mt-3 self-start rounded-xs bg-canary px-2 py-1 text-sm font-semibold text-on-canary">
            {card.perk}
          </p>
        )}
        <p className="t-h3 mt-5">{card.fit}</p>
        <ul className="mt-4 flex flex-col gap-2.5 border-t border-line pt-5 text-ink-2">
          {card.points.map((point) => (
            <li key={point} className="flex gap-2.5">
              <Check className="mt-0.5 size-5 shrink-0 text-go" aria-hidden />
              {point}
            </li>
          ))}
        </ul>
      </article>
    </>
  );
}

/** What an accepted quote costs on the 1% plan, as billing works it out. */
function acceptedFee(jobCents: number, { accepted }: Pricing) {
  const fee = Math.round((jobCents * accepted.basisPoints) / 10000);
  return Math.min(accepted.maximumFeeCents, Math.max(accepted.minimumFeeCents, fee));
}

const ODDS = [
  { value: '4', label: '1 in 4' },
  { value: '3', label: '1 in 3' },
  { value: '2', label: '1 in 2' },
];

function Calculator({ pricing }: { pricing: Pricing }) {
  const c = pricing.currency;
  const [quotes, setQuotes] = useState(30);
  // Untouched, the typical job follows the currency, so a visitor abroad sees a local amount.
  const [jobTyped, setJobTyped] = useState<string | null>(null);
  const [oneIn, setOneIn] = useState('3');
  const job = jobTyped ?? moneyInput(pricing.perQuoteCents * 200);
  const jobCents = parseMoney(job) ?? 0;

  const { subscription: sub } = pricing;
  const yeses = Math.round(quotes / Number(oneIn));
  const fee = acceptedFee(jobCents, pricing);
  const extra = Math.max(0, quotes - sub.includedQuotes);
  const results = [
    {
      label: 'Per quote',
      cents: quotes * pricing.perQuoteCents,
      how: `${quotes} ${quotes === 1 ? 'quote' : 'quotes'} × ${money(pricing.perQuoteCents, c)}`,
    },
    {
      label: 'When they say yes',
      cents: yeses * fee,
      how: `${yeses} accepted × ${money(fee, c)}`,
    },
    {
      label: 'Subscription',
      cents: sub.monthlyCents + extra * sub.overageCents,
      how: extra
        ? `${money(sub.monthlyCents, c)} + ${extra} extra × ${money(sub.overageCents, c)}`
        : `${sub.includedQuotes} quotes included`,
    },
  ];
  const lowest = Math.min(...results.map((result) => result.cents));
  const highest = Math.max(...results.map((result) => result.cents), 1);

  return (
    <section aria-labelledby="fit-title" className="border-y border-line bg-surface">
      <div className="gutter mx-auto grid max-w-6xl gap-10 py-20 md:grid-cols-2 md:gap-14">
        <div>
          <h2 id="fit-title" className="t-h1">
            Not sure which? Try your numbers.
          </h2>
          <p className="mt-4 text-lg text-ink-2">
            See what each plan would cost you in a normal month.
          </p>
          <div className="mt-8 flex flex-col gap-7">
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <label htmlFor="fit-quotes" className="text-sm font-semibold">
                  Quotes a month
                </label>
                <output htmlFor="fit-quotes" className="qf-total text-[28px]">
                  {quotes}
                </output>
              </div>
              <input
                id="fit-quotes"
                type="range"
                min={1}
                max={200}
                value={quotes}
                onChange={(event) => setQuotes(Number(event.target.value))}
                className="mt-3 h-2 w-full accent-ink"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fit-job" className="text-sm font-semibold">
                A typical job
              </label>
              <MoneyInput id="fit-job" value={job} onChange={setJobTyped} className="max-w-48" />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold" aria-hidden>
                How many say yes
              </p>
              <div>
                <Segmented
                  label="How many say yes"
                  value={oneIn}
                  options={ODDS}
                  onChange={setOneIn}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="self-start rounded-lg border border-line bg-bg p-6 sm:p-7">
          <p className="t-label text-muted">Your month</p>
          <ul className="mt-5 flex flex-col gap-6" aria-label="Your month" aria-live="polite">
            {results.map((result) => {
              const best = result.cents === lowest;
              return (
                <li key={result.label}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 font-semibold">{result.label}</span>
                    <span className="qf-total text-[28px]">{money(result.cents, c)}</span>
                  </div>
                  <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={cx(
                        'h-full rounded-r-xs transition-[width] duration-300',
                        best ? 'bg-canary' : 'bg-line-strong',
                      )}
                      style={{ width: `${Math.max(2, (result.cents / highest) * 100)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm text-muted">{result.how}</p>
                    {best && <Tag tone="canary">Lowest for you</Tag>}
                  </div>
                </li>
              );
            })}
          </ul>
          {pricing.firstMonthMaxCents ? (
            <p className="mt-6 border-t border-line pt-5 text-sm text-ink-2">
              In your first 30 days, quote fees stop at {money(pricing.firstMonthMaxCents, c)} on
              any plan.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function EveryPlan({ pricing }: { pricing: Pricing }) {
  const c = pricing.currency;
  const items: { icon: typeof Sprout; title: string; text: string }[] = [
    {
      icon: Sprout,
      title: 'Training stays free',
      text: 'Add jobs, practice and test it yourself whenever you like, on any plan.',
    },
    {
      icon: Globe,
      title: 'Your website, a link, a QR code',
      text: 'Customers get your price wherever they find you, day or night.',
    },
    {
      icon: Hand,
      title: 'Big jobs wait for you',
      text: 'Set a price limit. Anything above it waits for your OK before it goes out.',
    },
    ...(pricing.spendingCapCents
      ? [
          {
            icon: Gauge,
            title: 'A limit on monthly fees',
            text: `It starts at ${money(pricing.spendingCapCents, c)} and you can change it. Past it, new requests wait for you.`,
          },
        ]
      : []),
    {
      icon: ArrowLeftRight,
      title: 'Switch whenever you like',
      text: 'A new plan starts right away. There’s no contract.',
    },
    ...(pricing.firstMonthMaxCents
      ? [
          {
            icon: CalendarCheck,
            title: `First 30 days stop at ${money(pricing.firstMonthMaxCents, c)}`,
            text: 'Counted from the day you add a card. Quotes past that still go out, free.',
          },
        ]
      : []),
  ];
  return (
    <section aria-labelledby="every-title" className="gutter mx-auto max-w-6xl py-20">
      <h2 id="every-title" className="t-h1 max-w-xl">
        On every plan
      </h2>
      <ul className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <Icon className="size-6 text-accent" aria-hidden />
            <h3 className="t-h3 mt-4">{title}</h3>
            <p className="mt-2 text-ink-2">{text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Questions() {
  const questions: { q: string; a: ReactNode }[] = [
    {
      q: 'What counts as a quote?',
      a: 'A quote counts when a customer is shown it, whether it went out on its own or you approved it first. On the plan that charges when they say yes, it counts once they accept it in the chat.',
    },
    {
      q: 'What’s never charged?',
      a: 'Practice quotes, your own tests, requests that never get to a price and sending the same quote again.',
    },
    {
      q: 'When do I add a card?',
      a: 'When you go live with real customers. That’s also when you pick your plan. Setting up and practice don’t need one.',
    },
    {
      q: 'Can I change my plan later?',
      a: 'Yes, any time from Settings, and the new plan starts right away. You can cancel the subscription whenever you like.',
    },
  ];
  return (
    <section aria-labelledby="questions-title" className="border-t border-line">
      <div className="gutter mx-auto max-w-6xl py-20">
        <h2 id="questions-title" className="t-h1">
          Questions
        </h2>
        <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {questions.map(({ q, a }) => (
            <div key={q}>
              <dt className="t-h3">{q}</dt>
              <dd className="mt-2 text-ink-2">{a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
