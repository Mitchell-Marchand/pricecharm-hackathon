'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, TextInput } from '@/components/ui';
import { loadMe, login } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { AuthShell } from './AuthShell';
import { PasswordInput } from './PasswordInput';

/** Only paths inside the app, so a link can't send someone elsewhere after they sign in. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next') || '';
  return /^\/(app|start)(\/|$)/.test(next) ? next : '/app';
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Already signed in: go straight to the app.
  useEffect(() => {
    loadMe()
      .then(() => router.replace(nextPath()))
      .catch(() => {});
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
      router.replace(nextPath());
    } catch (loginError) {
      setError(errorMessage(loginError));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <Field label="Email" htmlFor="login-email">
          <TextInput
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Link
          href="/forgot-password"
          className="self-start text-sm text-accent underline underline-offset-4"
        >
          Forgot your password?
        </Link>
      </form>
      <p className="mt-10 border-t border-line pt-6 text-ink-2">
        New to PriceCharm?{' '}
        <Link href="/start" className="font-semibold text-accent underline underline-offset-4">
          Set up your Charm
        </Link>
      </p>
    </AuthShell>
  );
}
