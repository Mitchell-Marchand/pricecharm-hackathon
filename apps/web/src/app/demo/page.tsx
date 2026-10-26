import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { DemoExplorer } from '@/components/demo/DemoExplorer';
import { SiteFooter, SiteHeader } from '@/components/site/SiteHeader';
import { ButtonLink } from '@/components/ui';
import { DEMOS_BY_TRADE } from '@/lib/demos';

export const metadata: Metadata = {
  title: 'Try it as a customer',
  description:
    'See what your customers get: a short chat, a real quote in about two minutes, and one tap to accept. Pick any trade.',
};

type Props = { searchParams: Promise<{ trade?: string | string[] }> };

/** /demo?trade=painting opens on that trade, so a link can show someone their own industry. */
export default async function DemoPage({ searchParams }: Props) {
  const { trade } = await searchParams;
  const initialTrade = typeof trade === 'string' && DEMOS_BY_TRADE[trade] ? trade : undefined;
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="gutter mx-auto max-w-6xl pt-8 pb-20">
        <h1 className="t-h1 max-w-2xl">Try it as a customer.</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-2">
          This is what your customers see on your quote link or your website. Pick a trade, answer a
          few questions and get a quote. The prices here are samples; yours come from your own jobs.
        </p>
        <div className="mt-10">
          <DemoExplorer full initialTrade={initialTrade} />
        </div>
        <div className="mt-14 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-8">
          <ButtonLink href="/start" size="lg">
            Set up yours <ArrowRight aria-hidden />
          </ButtonLink>
          <p className="text-sm text-muted">About 5 minutes · Free to set up · No card to start</p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
