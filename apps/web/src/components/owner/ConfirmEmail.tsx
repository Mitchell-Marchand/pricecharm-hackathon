'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Button, TextInput } from '@/components/ui';
import { confirmEmailCode, resendVerification } from '@/lib/account';
import { errorMessage } from '@/lib/api';

/**
 * Asks for the 6-digit code from the confirmation email, on the page the owner is already on. It
 * checks itself once all six digits are in. A band under the app's header, or a card in a page.
 */
export function ConfirmEmail({
  email,
  devCode: firstDevCode = null,
  onConfirmed,
  variant = 'card',
}: {
  email: string;
  /** Locally no email goes out, so the code comes with the response instead. */
  devCode?: string | null;
  onConfirmed: () => void;
  variant?: 'band' | 'card';
}) {
  const id = useId();
  const notify = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState(firstDevCode);
  // A code that just failed isn't sent again until it changes.
  const tried = useRef('');

  async function confirm(value: string) {
    if (busy || value.length !== 6 || tried.current === value) return;
    tried.current = value;
    setBusy(true);
    setError('');
    try {
      await confirmEmailCode(value);
      onConfirmed();
    } catch (confirmError) {
      setError(errorMessage(confirmError));
      setBusy(false);
    }
  }

  function resend() {
    resendVerification()
      .then((sent) => {
        tried.current = '';
        setCode('');
        setError('');
        if (sent.devCode) setDevCode(sent.devCode);
        notify(`New code sent to ${email}.`);
      })
      .catch((sendError) => notify(errorMessage(sendError)));
  }

  const prompt = (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-8">
      <div className="flex min-w-0 gap-3">
        <span
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
          aria-hidden
        >
          <Mail className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="font-semibold">
            Confirm your email
          </h2>
          <p className="mt-0.5 text-[15px] text-ink-2">
            Enter the code we sent to{' '}
            <span className="font-semibold break-words text-ink">{email}</span> so every quote
            reaches your inbox.{' '}
            <button
              type="button"
              onClick={resend}
              className="font-semibold whitespace-nowrap text-accent hover:underline"
            >
              Send a new code
            </button>
          </p>
          {error && (
            <p className="mt-1 text-sm text-stop" role="alert">
              {error}
            </p>
          )}
          {devCode && (
            <p className="mt-1 text-sm text-muted">
              Local test: the code is <span className="font-mono text-ink">{devCode}</span>.
            </p>
          )}
        </div>
      </div>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void confirm(code);
        }}
        className="flex shrink-0 gap-2 pl-12 md:pl-0"
        noValidate
      >
        <div className="w-36">
          <TextInput
            id={id}
            aria-label="Code from the email"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(event) => {
              const value = event.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(value);
              if (value.length === 6) void confirm(value);
            }}
            // The input is taller than buttons by default; this matches the button beside it.
            className="h-11! text-center font-mono tracking-[0.25em]"
          />
        </div>
        <Button type="submit" disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Confirm'}
        </Button>
      </form>
    </div>
  );

  return variant === 'band' ? (
    <section aria-labelledby={`${id}-title`} className="border-b border-line bg-surface">
      <div className="gutter mx-auto max-w-6xl py-4">{prompt}</div>
    </section>
  ) : (
    <section
      aria-labelledby={`${id}-title`}
      className="rounded-md border border-line bg-surface p-4 sm:p-5"
    >
      {prompt}
    </section>
  );
}
