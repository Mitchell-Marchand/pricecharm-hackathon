'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { PracticeSession } from '@/components/practice/PracticeSession';
import { SetupLoading } from '@/components/SetupLoading';
import { useToast } from '@/components/Toast';
import { WizardHeader } from '@/components/Wizard';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import {
  finishPractice,
  loadPractice,
  preparePractice,
  withRun,
  type PracticeState,
} from '@/lib/practice';
import { cx } from '@/lib/util';

function PracticeProgress({
  index,
  finished,
  count,
}: {
  index: number;
  finished: number;
  count: number;
}) {
  return (
    <div className="gutter mx-auto flex max-w-[760px] items-center gap-4 pb-3">
      <p className="shrink-0 text-sm font-semibold">
        Practice quote {Math.min(index + 1, count)} of {count}
      </p>
      <div
        className="flex flex-1 gap-1.5"
        role="progressbar"
        aria-label="Practice quotes finished"
        aria-valuemin={0}
        aria-valuemax={count}
        aria-valuenow={finished}
      >
        {Array.from({ length: count }, (_, slot) => (
          <span
            key={slot}
            className={cx(
              'relative h-2 flex-1 overflow-hidden rounded-full',
              slot === index ? 'bg-line-strong' : 'bg-line',
            )}
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-canary transition-[width] duration-700 ease-out"
              style={{ width: slot < finished ? '100%' : '0%' }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

export default function PracticeStep() {
  const { state: onboarding, goTo } = useOnboarding();
  const notify = useToast();
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState<number | null>(null);

  const apply = useCallback((next: PracticeState) => {
    setPractice(next);
    setIndex((current) => current ?? next.current);
  }, []);

  useEffect(() => {
    preparePractice()
      .then(apply)
      .catch((error) => setLoadError(errorMessage(error)));
  }, [apply]);

  if (!onboarding) return <SetupLoading />;
  const run = practice && index !== null ? practice.runs[index] : null;
  const business = onboarding.business.name || 'Your business';
  const count = practice?.count ?? 3;
  const finishedCount = practice?.finished ?? 0;
  const last = index === null || index >= count - 1;
  // One more for a single service, started from the Ready screen once setup's three are done.
  const extra = index !== null && index >= count;

  async function next() {
    if (!practice || index === null) return;
    if (index < practice.runs.length - 1) {
      setIndex(index + 1);
      window.scrollTo({ top: 0 });
      loadPractice()
        .then(setPractice)
        .catch(() => {});
      return;
    }
    try {
      await finishPractice();
      await goTo('ready');
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={3} charm={finishedCount}>
        {!extra && <PracticeProgress index={index ?? 0} finished={finishedCount} count={count} />}
      </WizardHeader>

      <PracticeSession
        key={run?.id ?? 'loading'}
        business={business}
        run={run}
        onRun={(changed) => setPractice((current) => current && withRun(current, changed))}
        onState={apply}
        className="pt-8 pb-10"
        intro={
          <>
            {extra && (
              <div className="mb-8">
                <button
                  type="button"
                  onClick={() => void goTo('ready')}
                  className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
                >
                  <ArrowLeft className="size-4" aria-hidden /> Your results
                </button>
                {(run?.messages.length ?? 0) <= 1 && (
                  <>
                    <h1 className="t-h1 mt-4">
                      {run?.focus ? `Practice a ${run.focus} job` : 'One more practice customer'}
                    </h1>
                    <p className="mt-3 text-lg text-ink-2">
                      Answer it like a real lead. If your price comes within 15% of its guess, your
                      Charm&apos;s score goes up.
                    </p>
                  </>
                )}
              </div>
            )}
            {index === 0 && (run?.messages.length ?? 0) <= 1 && (
              <div className="mb-8">
                <button
                  type="button"
                  onClick={() => void goTo('jobs')}
                  className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
                >
                  <ArrowLeft className="size-4" aria-hidden /> Past jobs
                </button>
                <h1 className="t-h1 mt-4">Answer it like a real lead.</h1>
                <p className="mt-3 text-lg text-ink-2">
                  Ask what you&apos;d normally ask, then send a quote. Your Charm learns from how
                  you handle it, and its score goes up when its guess is close to your price.
                </p>
              </div>
            )}
            {loadError && (
              <p className="text-stop" role="alert">
                {loadError}
              </p>
            )}
          </>
        }
        done={
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {extra
                ? 'Done. See where it stands now.'
                : last
                  ? `All ${count === 3 ? 'three' : count} done.`
                  : `${count - finishedCount} to go. The next one is ready.`}
            </p>
            <Button size="lg" onClick={() => void next()}>
              {last ? 'See your Charm' : 'Next practice request'} <ArrowRight aria-hidden />
            </Button>
          </div>
        }
      />
    </div>
  );
}
