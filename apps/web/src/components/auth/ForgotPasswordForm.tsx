'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, Field, TextInput } from '@/components/ui';
import { forgotPassword } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { AuthShell } from './AuthShell';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ email: string; devToken?: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await forgotPassword(email.trim());
      setSent({ email: email.trim(), devToken: result.devToken });
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <AuthShell title="Check your email">
        <p className="text-lg text-ink-2">
          If there&apos;s an account for{' '}
          <span className="font-semibold text-ink">{sent.email}</span>, we sent it a link to reset
          your password. The link works for 30 minutes.
        </p>
        {sent.devToken && (
          <p className="mt-4 text-sm text-muted">
            Local test:{' '}
            <a href={`/reset-password#token=${sent.devToken}`} className="text-accent underline">
              open the reset link
            </a>
          </p>
        )}
        <Link href="/login" className="mt-8 inline-block text-accent underline underline-offset-4">
          Back to sign in
        </Link>
      </AuthShell>
    );

  return (
    <AuthShell title="Reset your password" intro="We'll email you a link to choose a new one.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <Field label="Email" htmlFor="forgot-email">
          <TextInput
            id="forgot-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Sending…' : 'Send me a link'}
        </Button>
        <Link href="/login" className="self-start text-sm text-accent underline underline-offset-4">
          Back to sign in
        </Link>
      </form>
    </AuthShell>
  );
}
