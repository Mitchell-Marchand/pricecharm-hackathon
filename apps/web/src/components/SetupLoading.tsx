'use client';

import { Logo } from './Logo';
import { Button } from './ui';
import { useOnboarding } from '@/lib/onboarding';

/** Shown while setup loads, or when it couldn't. */
export function SetupLoading() {
  const { loadError, reload } = useOnboarding();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="gutter mx-auto flex h-16 w-full max-w-6xl items-center">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto flex w-full max-w-[680px] flex-1 flex-col pt-10">
        {loadError ? (
          <div role="alert">
            <h1 className="t-h2">We couldn’t open your setup.</h1>
            <p className="mt-3 text-ink-2">{loadError}</p>
            <Button className="mt-6" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div aria-busy="true" aria-label="Loading your setup" className="flex flex-col gap-4">
            <div className="shimmer h-10 w-3/4 rounded-sm" />
            <div className="shimmer h-5 w-1/2 rounded-sm" />
            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="shimmer h-[72px] rounded-md" />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
