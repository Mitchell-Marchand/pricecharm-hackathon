import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Logo } from '../components/Logo';
import { PrototypeMenu } from '../components/PrototypeMenu';
import { Button, Field, TextInput } from '../components/ui';
import { tradeName } from '../data/trades';
import { useStore } from '../lib/store';

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function Account() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.account?.name ?? '');
  const [email, setEmail] = useState(state.account?.email ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordOk = password.length >= 8;
  const business = state.business.name || 'Your business';
  const practiced = state.runs.filter((run) => run.finished).length;

  function finish(account: { name: string; email: string; google: boolean }) {
    setBusy(true);
    window.setTimeout(() => {
      dispatch({ type: 'account', account });
      dispatch({ type: 'go', screen: 'live' });
    }, 900);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!name.trim() || !emailOk || !passwordOk) return;
    finish({ name: name.trim(), email: email.trim(), google: false });
  }

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo onClick={() => dispatch({ type: 'go', screen: 'landing' })} />
        <PrototypeMenu />
      </header>
      <main className="gutter mx-auto max-w-[460px] pt-6 pb-20">
        <button
          type="button"
          onClick={() => dispatch({ type: 'go', screen: 'ready' })}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back
        </button>
        <h1 className="t-h1 mt-5">Create your free account</h1>
        <p className="mt-3 text-lg text-ink-2">Save your AI and get your quote link.</p>

        <div className="mt-6 rounded-md border border-line bg-surface px-4 py-3">
          <p className="font-semibold">{business}</p>
          <p className="text-sm text-muted">
            {tradeName(state.business.tradeId, state.business.customTrade)} · Trained on {state.jobs.length}{' '}
            {state.jobs.length === 1 ? 'job' : 'jobs'} and {practiced} practice quotes
          </p>
        </div>

        <Button
          variant="secondary"
          size="lg"
          className="mt-6 w-full"
          disabled={busy}
          onClick={() => finish({ name: 'Maya Lopez', email: 'maya@gmail.com', google: true })}
        >
          <GoogleMark /> Continue with Google
        </Button>

        <div className="my-6 flex items-center gap-3 text-sm text-muted" aria-hidden>
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <Field label="Your name" htmlFor="account-name" error={tried && !name.trim() ? 'Add your name.' : undefined}>
            <TextInput id="account-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
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
            hint="At least 8 characters. This is a prototype, so don't use a real password."
            error={tried && !passwordOk ? 'Use at least 8 characters.' : undefined}
          >
            <div className="relative">
              <TextInput
                id="account-password"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="pr-12"
              />
              <button
                type="button"
                onClick={() => setShow((value) => !value)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-1.5 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-sm text-muted hover:text-ink"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? 'Setting up your quote link…' : 'Create account'}
          </Button>
          <p className="text-sm text-muted">
            By creating an account you agree to the Terms and Privacy Policy. Prototype: nothing is stored on a server.
          </p>
        </form>
      </main>
    </div>
  );
}
