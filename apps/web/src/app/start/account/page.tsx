'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SetupLoading } from '@/components/SetupLoading';
import { Button, Field, TextInput } from '@/components/ui';
import { register } from '@/lib/account';
import { ApiError, errorMessage } from '@/lib/api';
import { useHumanCheck } from '@/lib/human-check';
import { pixelEvent } from '@/lib/meta-pixel';
import { useOnboarding } from '@/lib/onboarding';
import { tradeName } from '@/lib/trades';

const MIN_PASSWORD = 10;

export default function AccountStep() {
  const router = useRouter();
  const { state, goTo, reload } = useOnboarding();
  const human = useHumanCheck('signup');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<{ message: string; exists?: boolean } | null>(null);
  // Signed up already: trying the Charm, then the plans, is what's left.
  useEffect(() => {
    if (state && !state.draft) router.replace('/start/try');
  }, [state, router]);

  if (!state || !state.draft) return <SetupLoading />;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordOk = password.length >= MIN_PASSWORD;
  const business = state.business.name || 'Your business';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!firstName.trim() || !lastName.trim() || !emailOk || !passwordOk || !agreed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await register(
        {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          password,
        },
        await human.headers(),
      );
      pixelEvent('CompleteRegistration');
      // The try page needs the account's quote link, so wait for it.
      await reload();
      await goTo('try');
    } catch (registerError) {
      setError({
        message: errorMessage(registerError),
        exists: registerError instanceof ApiError && registerError.code === 'ACCOUNT_EXISTS',
      });
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto max-w-[460px] pt-6 pb-20">
        <button
          type="button"
          onClick={() => void goTo('ready')}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back
        </button>
        <h1 className="t-h1 mt-5">Create your free account</h1>
        <p className="mt-3 text-lg text-ink-2">Save your Charm, then try it as a customer would.</p>

        <div className="mt-6 rounded-md border border-line bg-surface px-4 py-3">
          <p className="font-semibold">{business}</p>
          <p className="text-sm text-muted">
            {tradeName(state.business.tradeId, state.business.customTrade)}
          </p>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 flex flex-col gap-5"
          noValidate
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="First name"
              htmlFor="account-first-name"
              error={tried && !firstName.trim() ? 'Add your first name.' : undefined}
            >
              <TextInput
                id="account-first-name"
                autoComplete="given-name"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Field>
            <Field
              label="Last name"
              htmlFor="account-last-name"
              error={tried && !lastName.trim() ? 'Add your last name.' : undefined}
            >
              <TextInput
                id="account-last-name"
                autoComplete="family-name"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Email"
            htmlFor="account-email"
            error={tried && !emailOk ? 'Enter an email like you@yourbusiness.com.' : undefined}
          >
            <TextInput
              id="account-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field
            label="Password"
            htmlFor="account-password"
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={tried && !passwordOk ? `Use at least ${MIN_PASSWORD} characters.` : undefined}
          >
            <div className="relative">
              <TextInput
                id="account-password"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                className="pr-12"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                onClick={() => setShow((value) => !value)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-sm text-muted hover:text-ink"
              >
                {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </div>
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-3">
              <input
                id="account-terms"
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
                aria-describedby="account-terms-note"
                className="mt-0.5 size-5 shrink-0 accent-accent"
              />
              <label htmlFor="account-terms" className="text-sm text-ink">
                I agree to the{' '}
                <Link
                  href="/terms"
                  target="_blank"
                  className="font-semibold underline underline-offset-4"
                >
                  Terms
                </Link>{' '}
                and{' '}
                <Link
                  href="/privacy"
                  target="_blank"
                  className="font-semibold underline underline-offset-4"
                >
                  Privacy Policy
                </Link>
                .
              </label>
            </div>
            <p id="account-terms-note" className="pl-8 text-sm text-muted">
              Other businesses never see your prices or customers. With names and contact details
              taken out, your jobs also help train PriceCharm’s AI.
            </p>
            {tried && !agreed && (
              <p className="pl-8 text-sm text-stop" data-field-error="Terms">
                Check the box to agree first.
              </p>
            )}
          </div>
          {error && (
            <p className="text-sm text-stop" role="alert">
              {error.message}{' '}
              {error.exists && (
                <Link href="/login" className="font-semibold underline underline-offset-4">
                  Sign in
                </Link>
              )}
            </p>
          )}
          <div ref={human.slot} className="human-check" />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? 'Setting up your quote link…' : 'Create account'}
          </Button>
        </form>
      </main>
    </div>
  );
}
