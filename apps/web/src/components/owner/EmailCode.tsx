'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useToast } from '@/components/Toast';
import { Button, TextInput } from '@/components/ui';
import { confirmEmailCode, resendVerification } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { cx } from '@/lib/util';

/**
 * The 6-digit code from the confirmation email, typed on the page the owner is already on. It
 * checks itself once all six digits are in.
 */
export function EmailCode({
  email,
  devCode: firstDevCode = null,
  onConfirmed,
  compact = false,
}: {
  email: string;
  /** Locally no email goes out, so the code comes with the response instead. */
  devCode?: string | null;
  onConfirmed: () => void;
  compact?: boolean;
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

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void confirm(code);
      }}
      className={cx('flex flex-col gap-2', compact && 'sm:items-end')}
      noValidate
    >
      {!compact && (
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          Code from the email
        </label>
      )}
      <div className="flex gap-2">
        <TextInput
          id={id}
          aria-label={compact ? 'Code from the email' : undefined}
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
          className={cx('font-mono tracking-[0.25em]', compact ? 'h-9 w-32' : 'w-40')}
        />
        <Button type="submit" size={compact ? 'sm' : 'md'} disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Confirm'}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-stop" role="alert">
          {error}
        </p>
      )}
      <p className="text-sm text-muted">
        No email? Check spam, or{' '}
        <button
          type="button"
          onClick={resend}
          className="font-semibold text-accent hover:underline"
        >
          send a new code
        </button>
        .
      </p>
      {devCode && (
        <p className="text-sm text-muted">
          Local test: the code is <span className="font-mono text-ink">{devCode}</span>.
        </p>
      )}
    </form>
  );
}
