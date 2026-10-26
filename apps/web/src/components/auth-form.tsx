'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, json } from '@/lib/api';
import { useHumanCheck } from '@/lib/human-check';
import {
  approveGuestPreview,
  claimGuestPreview,
  finishGuestClaim,
  guestAuthUrl,
  readGuestApproval,
  readGuestUrlApproval,
  type GuestApproval,
} from '@/lib/guest-preview';
import type { GuestPreview, GuestPreviewState } from '@/lib/types';
import {
  ownerRequestAuthUrl,
  ownerRequestIntent,
  ownerRequestUrl,
  type OwnerRequestIntent,
} from '@/lib/owner-request';
import { GuestPreviewReceipt, guestPreviewStyles } from './guest-preview';
import { Button, Field, Logo, Notice } from './ui';

export default function AuthForm({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasJob, setHasJob] = useState(false);
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  const [claimIntent, setClaimIntent] = useState(false);
  const [checkingPreview, setCheckingPreview] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [claimFailed, setClaimFailed] = useState(false);
  const [approval, setApproval] = useState<GuestApproval | null>(null);
  const [requestIntent, setRequestIntent] = useState<OwnerRequestIntent | null>(null);
  const [registerBusinessName, setRegisterBusinessName] = useState<string | null>(null);
  const human = useHumanCheck('signup', register);

  useEffect(() => {
    let active = true;
    try {
      setHasJob(!!sessionStorage.getItem('quotient:first-job')?.trim());
    } catch {
      // Accounts can be created without browser storage or a first job.
    }
    const params = new URLSearchParams(window.location.search);
    const fromPreview = params.get('from') === 'preview';
    const requestedQuote = !fromPreview ? ownerRequestIntent(params) : null;
    if (requestedQuote) {
      setRequestIntent(requestedQuote);
      return () => {
        active = false;
      };
    }
    const savedApproval = readGuestUrlApproval() || readGuestApproval();
    if (savedApproval || fromPreview) {
      setClaimIntent(true);
      setCheckingPreview(true);
      setApproval(savedApproval);
      api<GuestPreviewState>(
        `/guest-preview${savedApproval ? `?previewId=${encodeURIComponent(savedApproval.previewId)}` : ''}`,
      )
        .then((response) => {
          if (!active) return;
          const value = response.preview;
          if (
            !value ||
            !['ready', 'claimed'].includes(value.status) ||
            (value.status === 'ready' && !value.readyToSave)
          ) {
            setError('Your preview isn’t available here. Your note is kept on the preview page.');
            return;
          }
          if (
            savedApproval &&
            (value.id !== savedApproval.previewId || value.version !== savedApproval.version)
          ) {
            setError('Your preview has changed. Review it before saving.');
            return;
          }
          setPreview(value);
        })
        .catch((cause) => {
          if (active) setError(errorMessage(cause));
        })
        .finally(() => {
          if (active) setCheckingPreview(false);
        });
      api('/auth/me')
        .then(() => {
          if (active) setSignedIn(true);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  async function savePreview() {
    const intent = approval || (preview ? approveGuestPreview(preview) : null);
    if (!intent || (!preview && !signedIn)) return false;
    setApproval(intent);
    try {
      const result = await claimGuestPreview(intent);
      router.push(finishGuestClaim(result.service.id, preview || undefined));
      router.refresh();
      return true;
    } catch (cause) {
      setClaimFailed(true);
      setError(errorMessage(cause));
      return false;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const businessName = String(form.get('businessName') || '').trim();
    try {
      if (claimIntent && !preview) return;
      if (signedIn) {
        await savePreview();
        return;
      }
      await api('/auth/' + (register ? 'register' : 'login'), {
        method: 'POST',
        headers: register ? await human.headers() : undefined,
        ...json({
          ...(register ? { businessName, name: businessName } : {}),
          email: String(form.get('email') || '').trim(),
          password: form.get('password'),
        }),
      });
      if (claimIntent) {
        setSignedIn(true);
        await savePreview();
        return;
      }
      if (requestIntent)
        router.replace(
          ownerRequestUrl(requestIntent.quoteId, requestIntent.filter, requestIntent.cursor),
        );
      else router.push('/dashboard');
      router.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function retryClaim() {
    if (loading || (!preview && !(signedIn && approval))) return;
    setLoading(true);
    setError('');
    try {
      await api('/auth/me');
      await savePreview();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setSignedIn(false);
        setClaimFailed(false);
        setError('Please sign in again to save your assistant. Your preview is still here.');
      } else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page clean-auth">
      <header className="account-entry-header">
        <Logo />
        <Link href="/pricing">Pricing</Link>
      </header>
      <section className="account-entry" aria-labelledby="account-entry-title">
        <h1 id="account-entry-title">
          {preview?.status === 'claimed'
            ? 'Your assistant is saved.'
            : claimIntent
              ? 'Save your assistant.'
              : register
                ? 'Create your account.'
                : 'Welcome back.'}
        </h1>
        <p>
          {preview?.status === 'claimed'
            ? 'Open it to try your customer questions.'
            : claimIntent
              ? !preview && !checkingPreview
                ? signedIn && approval
                  ? 'Check whether this assistant was already saved to your account.'
                  : 'Your note is kept on the preview page.'
                : signedIn
                  ? 'Keep these questions in your business’s assistant.'
                  : 'Your questions are ready. Sign up or sign in to keep them.'
              : register
                ? 'Save your job and start teaching your assistant.'
                : requestIntent
                  ? requestIntent.quoteId
                    ? 'Sign in to open this quote request.'
                    : 'Sign in to open your requests.'
                  : 'Sign in to your Quotefolk account.'}
        </p>
        {preview?.receipt && (
          <details className={guestPreviewStyles.authReceipt}>
            <summary>View your preview · {preview.questions.length} questions</summary>
            <GuestPreviewReceipt preview={preview} />
          </details>
        )}
        {!claimIntent && hasJob && (
          <div className="account-saved-job">Your job is saved for the next step.</div>
        )}
        {checkingPreview && <p role="status">Loading your preview…</p>}

        {preview?.status === 'claimed' && preview.claim ? (
          <Link
            className="button button-primary full-width"
            href={`/dashboard?service=${encodeURIComponent(preview.claim.serviceId)}&step=teach`}
          >
            Open your assistant
          </Link>
        ) : (
          <form onSubmit={submit}>
            {!signedIn && register && (
              <Field
                label="Business name"
                name="businessName"
                autoComplete="organization"
                value={
                  registerBusinessName ??
                  (preview?.status === 'ready' ? (preview.businessNameSuggestion ?? '') : '')
                }
                onChange={(event) => setRegisterBusinessName(event.currentTarget.value)}
                required
                minLength={2}
                maxLength={160}
                autoFocus
              />
            )}
            {!signedIn && (
              <>
                <Field
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  autoFocus={!register}
                />
                <Field
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={register ? 10 : undefined}
                  maxLength={128}
                  hint={register ? 'At least 10 characters.' : undefined}
                />
              </>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            {claimIntent && !checkingPreview && !preview ? (
              <>
                {signedIn && approval && (
                  <Button
                    type="button"
                    onClick={retryClaim}
                    loading={loading}
                    className="full-width"
                  >
                    Check saved assistant
                  </Button>
                )}
                <Link
                  className={
                    signedIn && approval ? 'account-forgot' : 'button button-primary full-width'
                  }
                  href="/"
                >
                  Back to your preview
                </Link>
              </>
            ) : (
              <Button
                type={claimFailed ? 'button' : 'submit'}
                onClick={claimFailed ? retryClaim : undefined}
                loading={loading}
                disabled={checkingPreview || (claimIntent && !preview)}
                className="full-width"
              >
                {claimIntent
                  ? claimFailed
                    ? 'Try saving again'
                    : signedIn
                      ? 'Save your assistant'
                      : register
                        ? 'Create account'
                        : 'Sign in and save assistant'
                  : register
                    ? 'Create account'
                    : 'Sign in'}
              </Button>
            )}
            {register && !signedIn && <div ref={human.slot} className="human-check" />}
            {claimIntent && preview && (
              <p className="account-claim-note">
                Saves the questions you reviewed. You set the final price.
              </p>
            )}
            {claimFailed && (
              <Link href="/" className="account-forgot">
                Review your preview
              </Link>
            )}
          </form>
        )}

        {!register && !signedIn && preview?.status !== 'claimed' && (
          <Link href="/forgot-password" className="account-forgot">
            Forgot your password?
          </Link>
        )}
        {!signedIn && preview?.status !== 'claimed' && (
          <p className="account-switch">
            {register ? 'Already have an account?' : 'New to Quotefolk?'}{' '}
            <Link
              href={
                requestIntent
                  ? ownerRequestAuthUrl(register ? '/login' : '/signup', requestIntent)
                  : claimIntent && approval
                    ? guestAuthUrl(register ? '/login' : '/signup', approval)
                    : (register ? '/login' : '/signup') + (claimIntent ? '?from=preview' : '')
              }
            >
              {register ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        )}
        {register && preview?.status !== 'claimed' && (
          <p className="account-terms">
            By continuing, you agree to our <Link href="/terms">Terms</Link> and{' '}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>
        )}
      </section>
      <footer className="account-entry-footer">
        <Link href="/">Quotefolk</Link>
        <div>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </footer>
    </main>
  );
}
