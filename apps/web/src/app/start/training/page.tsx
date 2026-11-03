'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, Receipt, TrendingUp } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Avatar } from '@/components/ui';
import { useOnboarding } from '@/lib/onboarding';

/** What practice is, before the first pretend customer. That customer is written meanwhile. */
export default function TrainingStep() {
  const router = useRouter();
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="training" />
      <main className="gutter mx-auto w-full max-w-[600px] flex-1 pt-8 pb-16 sm:pt-14">
        <p className="t-label text-muted">Training</p>
        <h1 className="t-h1 mt-3">Ready to start training?</h1>
        <p className="mt-4 text-lg text-ink-2">
          You&apos;ll get some pretend customers with quote requests. Ask the questions you normally
          would, and when you&apos;re ready, send the quote.
        </p>

        <div className="mt-8 flex flex-col gap-3 rounded-md bg-surface-2 p-4 sm:p-5" aria-hidden>
          <div className="flex items-end gap-2">
            <Avatar initials="DR" tone="pink" size="sm" />
            <p className="rounded-[12px] rounded-bl-[4px] border border-line bg-surface px-3 py-2 text-[15px]">
              Hi! Pics attached. How much would this be?
            </p>
          </div>
          <p className="ml-auto max-w-[80%] rounded-[12px] rounded-br-[4px] bg-ink px-3 py-2 text-[15px] text-on-ink">
            Thanks! Is it one story or two?
          </p>
          <span className="inline-flex h-9 items-center gap-1.5 self-start rounded-sm bg-canary px-2.5 text-[13px] font-semibold whitespace-nowrap text-on-canary">
            <Receipt className="size-4" /> I have enough to quote
          </span>
        </div>

        <ul className="mt-8 flex flex-col gap-4 text-[15px] text-ink-2">
          <li className="flex gap-3">
            <Camera className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            Each one sends photos of the job, the way real customers do.
          </li>
          <li className="flex gap-3">
            <TrendingUp className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            After your first three, your Charm guesses your price before you send, so you can watch
            it learn.
          </li>
          <li className="flex gap-3">
            <Receipt className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            About 2 minutes each. Most owners can try their Charm after about 6.
          </li>
        </ul>
      </main>
      <BottomBar
        onBack={() => router.push('/start/about')}
        onNext={() => router.push('/start/practice')}
        nextLabel="Start practice"
        note={
          <>
            By starting, you agree to our{' '}
            <Link href="/terms" target="_blank" className="underline underline-offset-4">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" target="_blank" className="underline underline-offset-4">
              Privacy Policy
            </Link>
            .
          </>
        }
      />
    </div>
  );
}
