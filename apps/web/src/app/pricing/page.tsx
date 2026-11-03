import type { Metadata } from 'next';
import { PricingDetails } from '@/components/site/PricingDetails';
import { SiteFooter, SiteHeader } from '@/components/site/SiteHeader';
import { publicPricing } from '@/lib/server-api';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Training your Charm is free. When you’re ready for real customers, pick the one plan that suits your business.',
};

export default async function PricingPage() {
  const pricing = await publicPricing();
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main>
        <PricingDetails initial={pricing} />
      </main>
      <SiteFooter />
    </div>
  );
}
