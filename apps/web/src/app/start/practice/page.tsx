'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Meter, useCharm } from '@/components/Charm';
import { PracticeSession } from '@/components/practice/PracticeSession';
import { SetupLoading } from '@/components/SetupLoading';
import { useToast } from '@/components/Toast';
import { SaveLater, WizardHeader } from '@/components/Wizard';
import { Button } from '@/components/ui';
import type { CharmView } from '@/lib/account';
import { ApiError, errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import {
  finishPractice,
  loadPractice,
  morePractice,
  preparePractice,
  withRun,
  type PracticeState,
} from '@/lib/practice';
import { article } from '@/lib/util';

/** The score setup points toward, as the API counts it (WELL_TRAINED in pricing/readiness.ts). */
const WELL_TRAINED = 85;

/** How trained the Charm is, under the header for the whole of practice. */
function TrainingMeter({ charm }: { charm: CharmView | null }) {
  const score = charm?.readiness.score ?? null;
  const last = useRef<number | null>(null);
  const [gain, setGain] = useState(0);
  useEffect(() => {
    if (score === null) return;
    const before = last.current;
    last.current = score;
    if (before === null || score <= before) return;
    setGain(score - before);
    const timer = window.setTimeout(() => setGain(0), 2400);
    return () => window.clearTimeout(timer);
  }, [score]);
  const more = charm?.readiness.toWellTrained;
  return (
    <div className="gutter mx-auto flex max-w-[760px] items-center gap-3 pb-3" aria-live="polite">
      <p className="shrink-0 text-sm">
        <span className="font-semibold">Your Charm</span>{' '}
        <span className="tabular">
          {score === null ? '…' : `${score}%`} trained
          {gain > 0 && <span className="ml-1.5 font-semibold text-go">+{gain}</span>}
        </span>
      </p>
      <div className="min-w-0 flex-1">
        <Meter score={score ?? 0} mark={charm?.settings.trainedPercent ?? 60} />
      </div>
      {more !== undefined && (
        <p className="hidden shrink-0 text-sm text-muted sm:block">
          {more > 0 ? `About ${more} more to ${WELL_TRAINED}%` : 'Well trained'}
        </p>
      )}
    </div>
  );
}

export default function PracticeStep() {
  const router = useRouter();
  const { state: onboarding, goTo } = useOnboarding();
  const notify = useToast();
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const finishedCount = practice?.finished ?? 0;
  const [charm] = useCharm(finishedCount);

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
  const score = charm?.readiness.score ?? 0;
  const readyToTry = Boolean(charm) && score >= (charm?.settings.trainedPercent ?? 60);
  const more = charm?.readiness.toWellTrained;
  const draft = onboarding.draft;

  // The next customer: one already written, or a new one once setup's first ones are done.
  async function next() {
    if (!practice || index === null) return;
    setMoving(true);
    try {
      if (index < practice.runs.length - 1) {
        setIndex(index + 1);
        setPractice(await loadPractice());
      } else {
        const { runId, state } = await morePractice();
        setPractice(state);
        setIndex(
          Math.max(
            0,
            state.runs.findIndex((item) => item.id === runId),
          ),
        );
      }
      window.scrollTo({ top: 0 });
    } catch (error) {
      // A setup that's practiced plenty goes on to its account, where practice keeps going.
      if (error instanceof ApiError && error.code === 'PRACTICE_LIMIT') {
        notify(errorMessage(error));
        await seeCharm();
      } else notify(errorMessage(error));
    } finally {
      setMoving(false);
    }
  }

  async function seeCharm() {
    try {
      await finishPractice();
      await goTo('ready');
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  const later = () => (draft ? setSaving(true) : router.push('/app/train'));
  const first = index === 0 && (run?.messages.length ?? 0) <= 1;

  return (
    // The tilted copies behind a quote reach past the edge on a phone. The page doesn't slide.
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <WizardHeader screen="practice">
        <TrainingMeter charm={charm} />
      </WizardHeader>

      <PracticeSession
        key={run?.id ?? 'loading'}
        business={business}
        run={run}
        onRun={(changed) => setPractice((current) => current && withRun(current, changed))}
        onState={apply}
        closePercent={practice?.closePercent}
        className="pt-8 pb-10"
        intro={
          <>
            {first && (
              <div className="mb-8">
                <button
                  type="button"
                  onClick={() => router.push('/start/training')}
                  className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
                >
                  <ArrowLeft className="size-4" aria-hidden /> Back
                </button>
                <h1 className="t-h1 mt-4">Answer it like a real lead.</h1>
                <p className="mt-3 text-lg text-ink-2">
                  Ask what you&apos;d normally ask, then send a quote. After your first three, your
                  Charm starts guessing your price before you send yours, from what you taught it.
                </p>
              </div>
            )}
            {!first && run?.focus && (run?.messages.length ?? 0) <= 1 && (
              <h1 className="t-h2 mb-6">
                Practice {article(run.focus)} {run.focus} job
              </h1>
            )}
            {loadError && (
              <p className="text-stop" role="alert">
                {loadError}
              </p>
            )}
          </>
        }
        done={
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted" aria-live="polite">
              {readyToTry ? (
                <>
                  <span className="font-semibold text-go">Your Charm is ready to try.</span>{' '}
                  {more ? `About ${more} more customers make it sharper.` : 'It’s well trained.'}
                </>
              ) : more ? (
                `About ${more} more to reach ${WELL_TRAINED}%. The next one is ready.`
              ) : (
                'The next one is ready.'
              )}
            </p>
            <div className="flex items-center justify-end gap-2">
              {readyToTry ? (
                <>
                  <Button variant="ghost" onClick={() => void next()} disabled={moving}>
                    Keep training
                  </Button>
                  <Button size="lg" onClick={() => void seeCharm()}>
                    See your Charm <ArrowRight aria-hidden />
                  </Button>
                </>
              ) : (
                <>
                  {/* After setup's first customers they can see where it stands, ready or not. */}
                  {finishedCount >= (practice?.count ?? 6) ? (
                    <Button variant="ghost" onClick={() => void seeCharm()}>
                      See your Charm
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={later}>
                      <span className="sm:hidden">Finish later</span>
                      <span className="hidden sm:inline">I&apos;ll finish this later</span>
                    </Button>
                  )}
                  <Button size="lg" onClick={() => void next()} disabled={moving}>
                    {moving ? 'Opening…' : 'Next customer'} <ArrowRight aria-hidden />
                  </Button>
                </>
              )}
            </div>
          </div>
        }
      />
      <SaveLater
        open={saving}
        onClose={() => setSaving(false)}
        title="Save your Charm"
        subtitle="Your practice is saved. We’ll email you a link to pick up where you left off, on this device or another one."
      />
    </div>
  );
}
