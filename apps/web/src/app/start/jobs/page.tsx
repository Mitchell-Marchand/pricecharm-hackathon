'use client';

import { useCallback, useRef, useState } from 'react';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import type { PastJob } from '@/lib/jobs';
import { useOnboarding } from '@/lib/onboarding';
import { preparePractice } from '@/lib/practice';
import { TRADES_BY_ID } from '@/lib/trades';
import { cx } from '@/lib/util';

export default function JobsStep() {
  const { state, goTo } = useOnboarding();
  const [count, setCount] = useState(0);

  // Once there's a job to go on, start writing the practice customers so step 3 opens quickly.
  const preparing = useRef(false);
  const onJobsChange = useCallback((jobs: PastJob[]) => {
    setCount(jobs.length);
    if (preparing.current || !jobs.length) return;
    preparing.current = true;
    void preparePractice().catch(() => {
      preparing.current = false;
    });
  }, []);

  if (!state) return <SetupLoading />;
  const services = state.business.services.length ? state.business.services : ['General'];
  const trade = state.business.tradeId ? TRADES_BY_ID[state.business.tradeId] : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={2} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">Add a few jobs you've already done.</h1>
        <p className="mt-3 text-lg text-ink-2">
          Real jobs teach it your prices. Photos help a lot. Three is a good start.
        </p>
        <div className="mt-8">
          <PastJobsEditor
            services={services}
            jobHint={trade?.jobHint}
            onJobsChange={onJobsChange}
          />
        </div>
        {count > 0 && (
          <div
            className="mt-8 flex items-center gap-3"
            aria-label={`${count} of 3 suggested jobs added`}
          >
            <div className="flex w-28 gap-1" aria-hidden>
              {[0, 1, 2].map((slot) => (
                <span
                  key={slot}
                  className={cx('h-1.5 flex-1 rounded-full', slot < count ? 'bg-ink' : 'bg-line')}
                />
              ))}
            </div>
            <p className="text-sm text-muted">
              {count >= 3
                ? 'Nice. That gives your AI plenty to go on.'
                : `${count} added. ${3 - count} more will sharpen its quotes, or continue now.`}
            </p>
          </div>
        )}
      </main>
      <BottomBar
        onBack={() => void goTo('business')}
        onNext={() => void goTo('practice')}
        disabled={count === 0}
        hint="Add at least one job to continue."
      />
    </div>
  );
}
