'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, ButtonLink, Field } from '@/components/ui';
import { resetPassword, tokenFromLink } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { AuthShell } from './AuthShell';
import { PasswordInput } from './PasswordInput';

const MIN_PASSWORD = 10;

export function ResetPasswordForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => setToken(tokenFromLink()), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!token || password.length < MIN_PASSWORD || busy) return;
    setBusy(true);
    setError('');
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (resetError) {
      setError(errorMessage(resetError));
      setBusy(false);
    }
  }

  if (token === undefined) return <AuthShell title="Choose a new password">{null}</AuthShell>;
  if (done)
    return (
      <AuthShell
        title="Password changed"
        intro="Sign in with your new password. Any other devices were signed out."
      >
        <ButtonLink href="/login" size="lg">
          Sign in
        </ButtonLink>
      </AuthShell>
    );
  if (!token)
    return (
      <AuthShell
        title="This link isn't complete"
        intro="Open the link from your email again, or ask for a new one."
      >
        <ButtonLink href="/forgot-password" size="lg">
          Send me a new link
        </ButtonLink>
      </AuthShell>
    );

  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5" noValidate>
        <Field
          label="New password"
          htmlFor="reset-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          error={
            tried && password.length < MIN_PASSWORD
              ? `Use at least ${MIN_PASSWORD} characters.`
              : undefined
          }
        >
          <PasswordInput
            id="reset-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <div className="text-sm text-stop" role="alert">
            <p>{error}</p>
            <Link
              href="/forgot-password"
              className="mt-1 inline-block underline underline-offset-4"
            >
              Send me a new link
            </Link>
          </div>
        )}
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthShell>
  );
}
