import Link from 'next/link';
import { Logo } from '../Logo';
import { ButtonLink } from '../ui';

/** Header for the public pages: landing, pricing, privacy and terms. */
export function SiteHeader({ howItWorks = false }: { howItWorks?: boolean }) {
  return (
    <header className="gutter mx-auto flex h-18 max-w-6xl items-center justify-between gap-4">
      <Logo href="/" />
      <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
        {howItWorks && (
          <a
            href="#how"
            className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline"
          >
            How it works
          </a>
        )}
        <Link
          href="/pricing"
          className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline"
        >
          Pricing
        </Link>
        <ButtonLink href="/login" variant="ghost">
          Sign in
        </ButtonLink>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="gutter mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted">
      <span>© {new Date().getFullYear()} Quotefolk</span>
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
