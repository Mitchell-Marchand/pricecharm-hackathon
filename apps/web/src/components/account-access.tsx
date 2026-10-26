'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Mail, ShieldCheck } from 'lucide-react';
import { api, errorMessage, json } from '@/lib/api';
import { Button, ButtonLink, Field, Logo, Notice } from './ui';

export default function AccountAccess({ mode }: { mode: 'forgot' | 'reset' | 'verify' }) {
  const [token, setToken] = useState('');
  const linkToken = useRef('');
  const [tokenFromLink, setTokenFromLink] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [devToken, setDevToken] = useState('');
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    linkToken.current ||= fragment.get('token') || parameters.get('token') || '';
    if (parameters.has('token') || fragment.has('token')) {
      const hadFragment = fragment.has('token');
      parameters.delete('token');
      fragment.delete('token');
      window.history.replaceState(
        {},
        '',
        window.location.pathname +
          (parameters.size ? '?' + parameters.toString() : '') +
          (hadFragment ? (fragment.size ? '#' + fragment.toString() : '') : window.location.hash),
      );
    }
    setToken(linkToken.current);
    setTokenFromLink(!!linkToken.current);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ ok: boolean; devToken?: string }>(
        `/auth/${mode === 'forgot' ? 'forgot-password' : mode === 'reset' ? 'reset-password' : 'verify-email'}`,
        {
          method: 'POST',
          ...json(
            mode === 'forgot'
              ? { email: form.get('email') }
              : mode === 'reset'
                ? { token, password: form.get('password') }
                : { token },
          ),
        },
      );
      setDone(true);
      setDevToken(result.devToken || '');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="account-access">
      <header>
        <Logo />
        <Link href="/login" className="back-link">
          <ArrowLeft size={16} /> Sign in
        </Link>
      </header>
      <section className="panel access-card">
        <h1>
          {mode === 'forgot'
            ? 'Recover your account.'
            : mode === 'reset'
              ? 'Choose a new password.'
              : 'Verify your email.'}
        </h1>
        {done ? (
          <>
            <Notice kind="success">
              {mode === 'forgot'
                ? 'If an account matches that address, a recovery email has been queued. Please check your inbox.'
                : mode === 'reset'
                  ? 'Your password has been reset. Sign in again with your new password.'
                  : 'Your email is verified. You can return to your workspace.'}
            </Notice>
            {devToken && (
              <Notice>
                <strong>Local development email</strong>
                <br />
                No email was sent.{' '}
                <Link
                  className="inline-button"
                  href={`/reset-password#token=${encodeURIComponent(devToken)}`}
                >
                  Open the local reset link
                </Link>
              </Notice>
            )}
            <ButtonLink href={mode === 'verify' ? '/dashboard?step=share' : '/login'}>
              {mode === 'verify' ? 'Return to your assistant' : 'Back to sign in'}
              <Check size={16} />
            </ButtonLink>
          </>
        ) : (
          <form onSubmit={submit}>
            <p>
              {mode === 'forgot'
                ? 'Enter your account email. We’ll send a link to help you set a new password.'
                : mode === 'reset'
                  ? 'Use at least 10 characters. Resetting your password signs out other sessions.'
                  : 'Confirm that you have access to this email address.'}
            </p>
            {mode === 'forgot' ? (
              <Field
                label="Account email"
                name="email"
                type="email"
                required
                autoComplete="email"
              />
            ) : (
              <>
                {!tokenFromLink && (
                  <Field
                    label="Email link token"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    required
                    autoComplete="off"
                  />
                )}
                {mode === 'reset' && (
                  <Field
                    label="New password"
                    name="password"
                    type="password"
                    minLength={10}
                    required
                    autoComplete="new-password"
                  />
                )}
              </>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            <Button type="submit" loading={loading} className="full-width">
              {mode === 'forgot'
                ? 'Send recovery link'
                : mode === 'reset'
                  ? 'Reset password'
                  : 'Verify email'}
              <Check size={16} />
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
