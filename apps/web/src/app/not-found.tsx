import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site/SiteHeader';
import { ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="gutter mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-16">
        <p className="t-label text-muted">404</p>
        <h1 className="t-hero mt-3 max-w-2xl">This page isn&apos;t here.</h1>
        <p className="mt-5 max-w-xl text-lg text-ink-2">
          If someone sent you a quote link, check that it came through whole, or ask them to send it
          again.
        </p>
        <div className="mt-8">
          <ButtonLink href="/" size="lg">
            Go to the home page
          </ButtonLink>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
