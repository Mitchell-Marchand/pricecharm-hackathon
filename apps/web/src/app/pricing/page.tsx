import type { Metadata } from 'next';
import { PricingDetails } from '@/components/site/PricingDetails';
import { SiteFooter, SiteHeader } from '@/components/site/SiteHeader';
import { ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Pricing' };

export default function PricingPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="gutter mx-auto max-w-3xl pt-8 pb-20">
        <h1 className="t-h1">Pay for the quotes your customers get. Nothing else.</h1>
        <p className="mt-5 text-lg text-ink-2">
          Training your AI is free. So are practice quotes, trying it as a customer and any request
          that never turns into a quote. No monthly fee, and no card until you’re ready for real
          customers.
        </p>
        <PricingDetails />
        <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ButtonLink href="/start" size="lg">
            Get started
          </ButtonLink>
          <p className="text-sm text-muted">About 5 minutes · Free to set up · No card to start</p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
