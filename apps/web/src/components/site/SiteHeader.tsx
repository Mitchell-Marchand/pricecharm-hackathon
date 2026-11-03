import Link from 'next/link';
import { Logo } from '../Logo';
import { ButtonLink } from '../ui';

/**
 * Header for the public pages: landing, pricing, privacy and terms. The ads' page (/go) keeps to
 * its one button: no other links, and on a phone the button gets the room Sign in would take.
 */
export function SiteHeader({
  howItWorks = false,
  start = { href: '/start', label: 'Get started' },
  focused = false,
}: {
  howItWorks?: boolean;
  /** The main button: where it goes and what it says. */
  start?: { href: string; label: string };
  /** Only the main button, as on the ads' page. */
  focused?: boolean;
}) {
  return (
    <header className="gutter mx-auto flex h-18 max-w-6xl items-center justify-between gap-3 sm:gap-4">
      {/* A smaller wordmark on phones leaves room for both buttons. */}
      <Logo href="/" className="max-sm:[&>span]:text-[17px]" />
      <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
        {howItWorks && (
          <a
            href="#how"
            className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline"
          >
            How it works
          </a>
        )}
        {!focused && (
          <>
            <Link
              href="/demo"
              className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline"
            >
              Demo
            </Link>
            <Link
              href="/pricing"
              className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline"
            >
              Pricing
            </Link>
          </>
        )}
        <ButtonLink
          href="/login"
          variant="ghost"
          className={focused ? 'max-sm:hidden' : 'max-sm:px-2'}
        >
          Sign in
        </ButtonLink>
        <ButtonLink href={start.href} size="sm" className="max-sm:px-2.5">
          {start.label}
        </ButtonLink>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="gutter mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted">
      <span>© {new Date().getFullYear()} PriceCharm</span>
      <nav aria-label="Footer" className="flex gap-5">
        <Link href="/pricing" className="hover:text-ink">
          Pricing
        </Link>
        <Link href="/privacy" className="hover:text-ink">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-ink">
          Terms
        </Link>
      </nav>
    </footer>
  );
}
