'use client';

import { useRouter } from 'next/navigation';
import { Moon } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { tradeFact } from '@/lib/funnel-facts';
import { useOnboarding } from '@/lib/onboarding';
import { tradeName } from '@/lib/trades';
import { cx } from '@/lib/util';

/**
 * Between questions, a number about their trade: the requests a week a shop like theirs gets, and
 * how many come in after hours. Each request is a ticket; the after-hours ones are dark.
 */
export default function WhyStep() {
  const router = useRouter();
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  const { tradeId, customTrade } = state.business;
  const trade = tradeName(tradeId, customTrade);
  const { weekly, afterHours } = tradeFact(tradeId);

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="why" />
      <main className="gutter mx-auto flex w-full max-w-[680px] flex-1 flex-col justify-center pt-8 pb-16">
        <p className="t-label text-muted">{trade}</p>
        <p className="mt-4 flex items-baseline gap-3">
          <span className="qf-total text-[88px] sm:text-[112px]">
            <span className="hl">{afterHours}</span>
          </span>
          <span className="t-h2 max-w-[14ch]">quote requests a week come in after hours</span>
        </p>
        <ul
          className="mt-8 flex max-w-md flex-wrap gap-1.5"
          aria-label={`${weekly} requests a week, ${afterHours} after hours`}
        >
          {Array.from({ length: weekly }, (_, index) => {
            const late = index >= weekly - afterHours;
            return (
              <li
                key={index}
                className={cx(
                  'fade-up flex h-9 w-7 items-center justify-center rounded-[3px] border',
                  late ? 'border-ink bg-ink text-canary' : 'border-line-strong bg-surface',
                )}
                style={{ animationDelay: `${index * 35}ms` }}
              >
                {late && <Moon className="size-3.5" aria-hidden />}
              </li>
            );
          })}
        </ul>
        <p className="mt-8 max-w-xl text-lg text-ink-2">
          A {trade.toLowerCase()} business like yours gets about {weekly} a week. The {afterHours}{' '}
          that come in after you&apos;ve closed usually go to whoever answers first. Your Charm
          answers them with your prices, any hour.
        </p>
        <p className="mt-6 text-sm text-muted">
          Industry estimates for a shop of one to five people.
        </p>
      </main>
      <BottomBar
        onBack={() => router.push('/start/services')}
        onNext={() => router.push('/start/about')}
      />
    </div>
  );
}
