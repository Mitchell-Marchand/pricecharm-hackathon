'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useOwner } from '@/components/owner/OwnerShell';
import { PracticeSession } from '@/components/practice/PracticeSession';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { buttonClass } from '@/components/button-class';
import { errorMessage } from '@/lib/api';
import { loadPractice, morePractice, withRun, type PracticeState } from '@/lib/practice';

/**
 * Practice after setup, from the Train page: one customer at a time, as many as the owner likes,
 * and all for one service if they came here to practice that one.
 */
export function MorePractice({
  runId: requested,
  service,
}: {
  runId: string | null;
  service: string | null;
}) {
  const { me } = useOwner();
  const notify = useToast();
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [runId, setRunId] = useState(requested);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  // The run stays in the address, so a reload comes back to the same customer.
  const start = useCallback(
    async (another = false) => {
      setStarting(true);
      try {
        const added = await morePractice(service);
        setPractice(added.state);
        setRunId(added.runId);
        const focus = service ? `&service=${encodeURIComponent(service)}` : '';
        window.history.replaceState(null, '', `/app/train/practice?run=${added.runId}${focus}`);
        window.scrollTo({ top: 0 });
      } catch (startError) {
        // Asking for another happens at the bottom of the page, so say so there.
        if (another) notify(errorMessage(startError));
        else setError(errorMessage(startError));
      } finally {
        setStarting(false);
      }
    },
    [notify, service],
  );

  useEffect(() => {
    if (!requested) {
      void start();
      return;
    }
    loadPractice()
      .then((state) => {
        if (state.runs.some((item) => item.id === requested)) setPractice(state);
        else void start();
      })
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [requested, start]);

  const run = practice?.runs.find((item) => item.id === runId) ?? null;
  const fresh = (run?.messages.length ?? 0) <= 1;
  const finished = practice?.finished ?? 0;

  return (
    <div className="-mb-24 flex min-h-[calc(100dvh-8.75rem)] flex-col sm:min-h-[calc(100dvh-6.5rem)]">
      <PracticeSession
        key={run?.id ?? 'loading'}
        business={me.business.name || 'Your business'}
        run={run}
        onRun={(changed) => setPractice((current) => current && withRun(current, changed))}
        onState={setPractice}
        as="div"
        gutter={false}
        className="pb-10"
        intro={
          <div className="mb-8">
            <Link
              href="/app/train"
              className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
            >
              <ArrowLeft className="size-4" aria-hidden /> Train
            </Link>
            {fresh && (
              <>
                <h1 className="t-h1 mt-4">
                  {run?.focus ? `Practice a ${run.focus} job` : 'Practice with a customer'}
                </h1>
                <p className="mt-3 text-lg text-ink-2">
                  Same as in setup. Answer like it&apos;s a real lead, then quote it or ask to see
                  it first. Your AI picks up how you handle it.
                </p>
              </>
            )}
            {error && (
              <p className="mt-4 text-stop" role="alert">
                {error}
              </p>
            )}
          </div>
        }
        done={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {finished} practice {finished === 1 ? 'customer' : 'customers'} so far.
            </p>
            <div className="flex items-center gap-2">
              <Link href="/app/train" className={buttonClass('ghost', 'lg')}>
                Back to Train
              </Link>
              <Button size="lg" disabled={starting} onClick={() => void start(true)}>
                Practice another <ArrowRight aria-hidden />
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
