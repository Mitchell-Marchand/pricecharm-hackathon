'use client';

import { useRouter } from 'next/navigation';
import { Check, Moon, Receipt, Timer, User } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { SHOPPING } from '@/lib/funnel-facts';
import { useOnboarding } from '@/lib/onboarding';
import { tradeName } from '@/lib/trades';
import { cx } from '@/lib/util';

/**
 * Between questions, how customers shop: most want a price before they call, so a business that
 * doesn't give one misses them. Ten customers, the ones who want a price first marked.
 */
export default function WhyStep() {
  const router = useRouter();
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  const { tradeId, customTrade } = state.business;
  const trade = tradeId || customTrade.trim() ? tradeName(tradeId, customTrade) : null;
  const wants = SHOPPING.priceFirst;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="why" />
      <main className="gutter mx-auto w-full max-w-[560px] flex-1 pt-8 pb-16 sm:pt-14">
        <p className="t-label text-muted">{trade ? `${trade} customers` : 'Customers'}</p>
        <h1 className="mt-4">
          <span className="qf-total block text-[84px] sm:text-[104px]">
            <span className="hl">{wants} in 10</span>
          </span>
          <span className="t-h1 mt-3 block">want a price before they call anyone.</span>
        </h1>

        <ul className="mt-8 grid grid-cols-10 gap-1.5" aria-hidden>
          {Array.from({ length: 10 }, (_, index) => (
            <li
              key={index}
              className={cx(
                'fade-up flex aspect-[3/4] items-center justify-center rounded-[4px] border',
                index < wants
                  ? 'border-ink bg-ink text-canary'
                  : 'border-line-strong bg-surface text-muted',
              )}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              {index < wants ? (
                <Receipt className="size-4 sm:size-5" />
              ) : (
                <User className="size-4 sm:size-5" />
              )}
            </li>
          ))}
        </ul>

        <p className="mt-8 text-lg text-ink-2">
          Without one, you never hear from them. They go to the business that showed a price.
        </p>

        <ul className="mt-8 flex flex-col divide-y divide-line border-y border-line text-[15px]">
          {[
            { icon: Moon, text: SHOPPING.afterHours },
            { icon: Timer, text: SHOPPING.firstAnswer },
          ].map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 py-3.5">
              <Icon className="size-5 shrink-0 text-ink-2" aria-hidden />
              {text}
            </li>
          ))}
        </ul>

        <p className="mt-8 flex gap-3 text-[17px] font-semibold">
          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-go text-surface">
            <Check className="size-4" aria-hidden />
          </span>
          Your Charm gives every one your price in about 2 minutes, any hour.
        </p>
        <p className="mt-6 text-sm text-muted">From homeowner and contractor surveys.</p>
      </main>
      <BottomBar
        onBack={() => router.push('/start/services')}
        onNext={() => router.push('/start/about')}
      />
    </div>
  );
}
