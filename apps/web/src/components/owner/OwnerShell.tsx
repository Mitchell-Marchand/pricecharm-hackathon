'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Mail } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { ToastProvider, useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { loadMe, resendVerification, type Me } from '@/lib/account';
import { ApiError, errorMessage } from '@/lib/api';
import { cx } from '@/lib/util';

const NAV = [
  { href: '/app', label: 'Quotes' },
  { href: '/app/train', label: 'Train' },
  { href: '/app/share', label: 'Share' },
  { href: '/app/settings', label: 'Settings' },
];

const OwnerContext = createContext<{ me: Me; reload: () => void } | null>(null);

/** The signed-in owner and their business. Only inside the owner app. */
export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner is only for pages inside /app.');
  return value;
}

export function OwnerShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <SignedIn>{children}</SignedIn>
    </ToastProvider>
  );
}

function SignedIn({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    loadMe()
      .then(setMe)
      .catch((loadError) => {
        if (loadError instanceof ApiError && loadError.status === 401)
          router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        else setError(errorMessage(loadError));
      });
  }, [router]);
  useEffect(reload, [reload]);

  if (!me)
    return (
      <div className="min-h-dvh">
        <header className="gutter mx-auto flex h-16 max-w-6xl items-center">
          <Logo href="/app" />
        </header>
        {error ? (
          <div className="gutter mx-auto max-w-xl py-24 text-center" role="alert">
            <p className="text-ink-2">{error}</p>
            <Button className="mt-6" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="gutter mx-auto max-w-6xl pt-10" aria-busy="true" aria-label="Loading">
            <div className="shimmer h-10 w-2/3 max-w-md rounded-sm" />
            <div className="shimmer mt-4 h-5 w-1/2 max-w-sm rounded-sm" />
            <div className="shimmer mt-10 h-48 rounded-md" />
          </div>
        )}
      </div>
    );

  const active = (href: string) =>
    href === '/app'
      ? pathname === '/app' || pathname.startsWith('/app/quotes')
      : pathname.startsWith(href);

  return (
    <OwnerContext.Provider value={{ me, reload }}>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-40 border-b border-line bg-bg/92 backdrop-blur-md">
          <div className="gutter mx-auto flex h-16 max-w-6xl items-center gap-6">
            <Logo href="/app" />
            <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
              {NAV.map((item) => (
                <NavLink key={item.href} {...item} active={active(item.href)} />
              ))}
            </nav>
            <p className="ml-auto hidden truncate text-sm text-muted md:block">
              {me.business.name}
            </p>
          </div>
          <nav aria-label="Main" className="gutter flex gap-1 overflow-x-auto pb-2 sm:hidden">
            {NAV.map((item) => (
              <NavLink key={item.href} {...item} active={active(item.href)} />
            ))}
          </nav>
        </header>
        {!me.user.emailVerified && <VerifyBanner email={me.user.email} />}
        <main className="gutter mx-auto max-w-6xl pt-8 pb-24 sm:pt-10">{children}</main>
      </div>
    </OwnerContext.Provider>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-[15px] font-medium transition-colors',
        active ? 'bg-ink text-on-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
      )}
    >
      {label}
    </Link>
  );
}

function VerifyBanner({ email }: { email: string }) {
  const notify = useToast();
  const [localLink, setLocalLink] = useState('');
  return (
    <div className="border-b border-line bg-canary-soft">
      <div className="gutter mx-auto flex max-w-6xl flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex gap-2.5 text-[15px]">
          <Mail className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            Confirm <span className="font-semibold">{email}</span> so we can email you when a quote
            needs you.
          </span>
        </p>
        {localLink ? (
          <a href={localLink} className="text-sm font-semibold text-accent underline">
            Local test: confirm it now
          </a>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 self-start sm:ml-0 sm:self-auto"
            onClick={() =>
              resendVerification()
                .then((sent) => {
                  if (sent.devToken) setLocalLink(`/verify-email#token=${sent.devToken}`);
                  else notify(`Sent. Check ${email}.`);
                })
                .catch((sendError) => notify(errorMessage(sendError)))
            }
          >
            Send the link again
          </Button>
        )}
      </div>
    </div>
  );
}
