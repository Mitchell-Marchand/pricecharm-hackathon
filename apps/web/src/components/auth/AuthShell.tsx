import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';

/** The frame around sign in, password reset and email confirmation. */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto max-w-[420px] pt-10 pb-20">
        <h1 className="t-h1">{title}</h1>
        {intro && <p className="mt-3 text-lg text-ink-2">{intro}</p>}
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}
