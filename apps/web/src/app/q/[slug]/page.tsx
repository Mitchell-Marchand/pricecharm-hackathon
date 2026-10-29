import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LoadedChat } from '@/components/customer/LoadedChat';
import { publicBusiness } from '@/lib/server-api';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const business = await publicBusiness((await params).slug);
  if (!business) return { title: 'Get a quote', robots: { index: false } };
  return {
    title: `Get a quote from ${business.name}`,
    description: `Tell ${business.name} about the job and get a price in about 2 minutes.`,
    robots: { index: false },
    openGraph: {
      type: 'website',
      siteName: 'PriceCharm',
      title: `Get a quote from ${business.name}`,
      description: 'Tell us about the job and add a photo. Your quote takes about 2 minutes.',
    },
  };
}

/**
 * The quote link an owner shares: their quote chat, full screen on a phone. While the keyboard is
 * up it fits the part of the screen above it (see useVisualViewport).
 */
export default async function QuoteLinkPage({ params }: Props) {
  const { slug } = await params;
  const business = await publicBusiness(slug);
  if (business === null) notFound();
  return (
    <div className="fixed inset-x-0 top-[var(--vv-top,0px)] flex h-[var(--vv-height,100dvh)] flex-col sm:items-center sm:justify-center sm:gap-4 sm:py-6">
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface sm:max-h-[820px] sm:max-w-[460px] sm:rounded-lg sm:border sm:border-line sm:shadow-2">
        <LoadedChat slug={slug} profile={business} source="link" />
      </main>
      <p className="hidden text-xs text-muted sm:block">
        Quotes by{' '}
        <a href="/" className="font-semibold text-ink-2 hover:text-ink">
          PriceCharm
        </a>
      </p>
    </div>
  );
}
