'use client';

import { useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { ButtonLink } from '@/components/ui';
import { api, errorMessage, json } from '@/lib/api';
import type { Onboarding } from '@/lib/onboarding';

/** The "finish later" link. Its token sits after the # so it never reaches server logs. */
export default function ResumePage() {
  const [error, setError] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    window.history.replaceState(null, '', '/start/resume');
    api<Onboarding>('/onboarding/resume', { method: 'POST', ...json({ token }) })
      .then((state) => {
        // A full load, so setup reads the new cookie instead of any setup already in this tab.
        window.location.replace(`/start/${state.step}`);
      })
      .catch((resumeError) => setError(errorMessage(resumeError)));
  }, []);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="gutter mx-auto flex h-16 w-full max-w-6xl items-center">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10">
        {error ? (
          <div role="alert">
            <h1 className="t-h2">That link didn’t work.</h1>
            <p className="mt-3 text-ink-2">{error}</p>
            <ButtonLink href="/start" className="mt-6">
              Start setting up
            </ButtonLink>
          </div>
        ) : (
          <p className="text-ink-2" aria-busy="true">
            Opening your setup…
          </p>
        )}
      </main>
    </div>
  );
}
