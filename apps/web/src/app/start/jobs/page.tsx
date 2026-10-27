'use client';

import { useCallback, useRef, useState } from 'react';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import type { PastJob } from '@/lib/jobs';
import { useOnboarding } from '@/lib/onboarding';
import { preparePractice } from '@/lib/practice';
import { TRADES_BY_ID } from '@/lib/trades';

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
          Start with three of different sizes for your main service, with what you charged. Photos
          help a lot.
        </p>
        <div className="mt-8">
          <PastJobsEditor
            services={services}
            jobHint={trade?.jobHint}
            sizeHint={trade?.sizeHint}
            onJobsChange={onJobsChange}
          />
        </div>
        {count > 0 && (
          <p className="mt-6 text-sm text-muted">You can continue now and add more later.</p>
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
