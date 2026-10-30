'use client';

import { useCallback, useRef, useState } from 'react';
import { PastJobsEditor } from '@/components/jobs/PastJobs';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import type { PastJob } from '@/lib/jobs';
import { useOnboarding } from '@/lib/onboarding';
import { preparePractice } from '@/lib/practice';
import { TRADES_BY_ID } from '@/lib/trades';

/** Past jobs to ask for: with about ten, the formula it works out holds up on new jobs. */
const PAST_JOBS = 10;

export default function JobsStep() {
  const { state, goTo } = useOnboarding();
  const [count, setCount] = useState(0);
  // Every change to the jobs moves the Charm's score, so the header fetches it again.
  const [changes, setChanges] = useState(0);

  // Once there's a job to go on, start writing the practice customers so step 3 opens quickly.
  const preparing = useRef(false);
  const onJobsChange = useCallback((jobs: PastJob[]) => {
    setCount(jobs.length);
    setChanges((current) => current + 1);
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
      <WizardHeader step={2} charm={changes} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">Add about ten jobs you&apos;ve already done.</h1>
        <p className="mt-3 text-lg text-ink-2">
          Start with a small, a medium and a large one for your main service, then the rest of your
          recent jobs, with how big each was and what you charged. Your Charm works out how you
          price from these, so the more it has, the closer it comes. Old invoices work too: upload
          them and it reads them for you.
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
          <p className="mt-6 text-sm text-muted">
            {count >= PAST_JOBS
              ? `${count} jobs. That's plenty to start, and you can add more later.`
              : `${count} of about ${PAST_JOBS}. You can continue now and add more later.`}
          </p>
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
