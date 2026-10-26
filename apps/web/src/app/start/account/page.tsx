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
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<{ message: string; exists?: boolean } | null>(null);

  // Already signed up: there's nothing to create here.
  useEffect(() => {
    if (state && !state.draft) router.replace('/start/live');
  }, [state, router]);

  if (!state || !state.draft) return <SetupLoading />;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordOk = password.length >= MIN_PASSWORD;
  const business = state.business.name || 'Your business';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!firstName.trim() || !lastName.trim() || !emailOk || !passwordOk || busy) return;
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
      reload();
      await goTo('live');
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
        <p className="mt-3 text-lg text-ink-2">Save your AI and get your quote link.</p>

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
          <p className="text-center text-sm text-muted">
            By creating an account you agree to the{' '}
            <Link href="/terms" className="underline underline-offset-4">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy Policy
            </Link>
            .
          </p>
        </form>
      </main>
    </div>
  );
}
