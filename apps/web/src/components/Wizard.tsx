'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CloudAlert, CloudCheck, LoaderCircle } from 'lucide-react';
import { api, errorMessage, json } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import { cx } from '@/lib/util';
import { Logo } from './Logo';
import { CharmMeter } from './Charm';
import { AccountMenu } from './owner/AccountMenu';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { Button, Field, TextInput } from './ui';

const STEPS = ['Your business', 'Past jobs', 'Practice'];

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol className="hidden items-center gap-3 md:flex" aria-label="Setup steps">
      {STEPS.map((label, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <li
            key={label}
            className="flex items-center gap-3"
            aria-current={current ? 'step' : undefined}
          >
            {index > 0 && (
              <span
                className={cx('h-px w-8', done || current ? 'bg-ink' : 'bg-line-strong')}
                aria-hidden
              />
            )}
            <span className="flex items-center gap-2">
              <span
                className={cx(
                  'inline-flex size-6 items-center justify-center rounded-full font-mono text-xs font-semibold',
                  done && 'bg-ink text-on-ink',
                  current && 'bg-canary text-on-canary',
                  !done && !current && 'border border-line-strong text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-label="Done" /> : number}
              </span>
              <span className={cx('text-sm', current ? 'font-semibold text-ink' : 'text-muted')}>
                {label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function WizardHeader({
  step,
  charm,
  children,
}: {
  step: 1 | 2 | 3;
  /** Shows the Charm's score, fetched again whenever this changes. */
  charm?: unknown;
  children?: ReactNode;
}) {
  const { state, save, flush } = useOnboarding();
  const [saveOpen, setSaveOpen] = useState(false);
  // Before signup there's nothing to sign out of, and "Finish later" emails a link back instead.
  const signedIn = state ? !state.draft : false;
  return (
    <header
      className="sticky z-40 border-b border-line bg-bg/92 backdrop-blur-md"
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="gutter mx-auto flex h-16 max-w-6xl items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Logo href="/" />
        </div>
        <Stepper step={step} />
        <div className="flex items-center gap-1">
          {charm !== undefined && (
            <div className="mr-3 hidden lg:block">
              <CharmMeter refreshKey={charm} />
            </div>
          )}
          {save === 'failed' ? (
            <button
              type="button"
              onClick={() => void flush()}
              className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm text-stop hover:bg-stop-soft"
            >
              <CloudAlert className="size-4" aria-hidden /> Not saved.{' '}
              <span className="underline underline-offset-4">Try again</span>
            </button>
          ) : signedIn ? (
            <p className="inline-flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted">
              {save === 'saving' ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <CloudCheck className="size-4" aria-hidden />
              )}
              <span className="hidden sm:inline" aria-live="polite">
                {save === 'saving' ? 'Saving…' : 'Saved.'}
              </span>
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-ink"
            >
              {save === 'saving' ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <CloudCheck className="size-4" aria-hidden />
              )}
              <span className="hidden sm:inline" aria-live="polite">
                {save === 'saving' ? 'Saving…' : 'Saved.'}
              </span>{' '}
              <span className="underline underline-offset-4">
                <span className="sm:hidden">Later</span>
                <span className="hidden sm:inline">Finish later</span>
              </span>
            </button>
          )}
          {signedIn && state && <AccountMenu business={state.business.name || 'Your business'} />}
        </div>
      </div>
      <div
        className={cx(
          'gutter mx-auto flex max-w-6xl items-center gap-3 pb-3',
          charm !== undefined ? 'md:justify-end lg:hidden' : 'md:hidden',
          children ? 'hidden' : undefined,
        )}
      >
        <p className="shrink-0 text-sm text-muted md:hidden">
          Step {step} of 3 · <span className="font-semibold text-ink">{STEPS[step - 1]}</span>
        </p>
        {charm !== undefined && (
          <div className="ml-auto lg:hidden">
            <CharmMeter refreshKey={charm} />
          </div>
        )}
        <div
          className={cx('flex flex-1 gap-1 md:hidden', charm !== undefined && 'hidden')}
          aria-hidden
        >
          {STEPS.map((label, index) => (
            <span
              key={label}
              className={cx(
                'h-1 flex-1 rounded-full',
                index + 1 < step ? 'bg-ink' : index + 1 === step ? 'bg-canary' : 'bg-line',
              )}
            />
          ))}
        </div>
      </div>
      {children}
      <SaveLater open={saveOpen} onClose={() => setSaveOpen(false)} />
    </header>
  );
}

function SaveLater({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notify = useToast();
  const { flush } = useOnboarding();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const send = async () => {
    setSending(true);
    setError('');
    try {
      await flush();
      await api('/onboarding/resume-link', { method: 'POST', ...json({ email: email.trim() }) });
      notify(`Sent. Check ${email.trim()} for your link.`);
      onClose();
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Finish later"
      subtitle="Your answers are saved. We’ll email you a link to pick up where you left off, on this device or another one."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || sending} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Email me a link'}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !sending) void send();
        }}
      >
        <Field label="Email" htmlFor="save-later-email" error={error || undefined}>
          <TextInput
            id="save-later-email"
            type="email"
            autoComplete="email"
            placeholder="you@yourbusiness.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
      </form>
    </Sheet>
  );
}

export function BottomBar({
  onBack,
  onNext,
  nextLabel = 'Continue',
  disabled,
  blocked,
  hint,
  width = 'max-w-[680px]',
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  disabled?: boolean;
  /** Something's missing, but the button still works: onNext takes them to it. The hint says what. */
  blocked?: boolean;
  hint?: string;
  width?: string;
}) {
  const waiting = (disabled || blocked) && hint;
  return (
    <div
      className="sticky bottom-0 z-30 border-t border-line bg-bg/92 backdrop-blur-md"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className={cx('gutter mx-auto flex items-center justify-between gap-3 py-3', width)}>
        {onBack ? (
          <Button variant="ghost" onClick={onBack} className="-ml-3">
            <ArrowLeft aria-hidden /> Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex min-w-0 items-center gap-3">
          {waiting && <p className="hidden truncate text-sm text-muted sm:block">{hint}</p>}
          <Button size="lg" onClick={onNext} disabled={disabled}>
            {nextLabel} <ArrowRight aria-hidden />
          </Button>
        </div>
      </div>
      {waiting && <p className="gutter -mt-1 pb-3 text-sm text-muted sm:hidden">{hint}</p>}
    </div>
  );
}
