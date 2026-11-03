import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Camera, Globe, Link2, MessageCircle, Receipt, Sprout } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { HeroQuotes } from '@/components/site/HeroQuotes';
import { SiteFooter } from '@/components/site/SiteHeader';
import { ButtonLink, Tag } from '@/components/ui';
import { TRADES_BY_ID } from '@/lib/trades';
import { cx } from '@/lib/util';

export const metadata: Metadata = {
  title: 'Quotes go out while you’re off',
  description:
    'Your own AI answers quote requests after hours, with your prices. Free to train, free to start.',
};

/**
 * Channels a new owner can connect, by name. Each shows as ready only once it really works for a
 * new business: NEXT_PUBLIC_LIVE_CHANNELS lists the ones that do, like "whatsapp,quickbooks".
 */
const CHANNELS = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'messenger', name: 'Messenger' },
  { id: 'quickbooks', name: 'QuickBooks' },
];
const LIVE = new Set(
  (process.env.NEXT_PUBLIC_LIVE_CHANNELS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

/**
 * Where the ads land: one story, one button. A trade's ad (/go?trade=window-cleaning) starts setup
 * on that trade, and a code on the link is kept for the plans.
 */
export default async function GoPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const trade = TRADES_BY_ID[String(query.trade ?? '')];
  const start = trade ? `/start?trade=${trade.id}` : '/start';
  const ready = CHANNELS.filter((channel) => LIVE.has(channel.id));
  const soon = CHANNELS.filter((channel) => !LIVE.has(channel.id));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="gutter mx-auto flex h-16 w-full max-w-6xl items-center justify-between">
        <Logo href="/" className="max-sm:[&>span]:text-[17px]" />
        <Link href="/login" className="rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink">
          Sign in
        </Link>
      </header>

      <main className="flex-1">
        <section className="gutter mx-auto grid max-w-6xl items-center gap-12 pt-4 pb-16 md:grid-cols-[1.1fr_1fr] md:pt-12 md:pb-24">
          <div className="max-w-[600px]">
            <Tag tone="canary" size="lg">
              After hours
            </Tag>
            <h1 className="t-hero mt-5">
              4 in 10 quote requests come in after you&apos;ve closed.
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg text-ink-2">
              Most customers hire whoever answers first.{' '}
              {trade
                ? `Your own AI answers ${trade.name.toLowerCase()} customers`
                : 'Your own AI answers them'}{' '}
              from their photos, asks what you&apos;d ask, and quotes with your prices, any hour.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink href={start} size="lg" className="w-full sm:w-auto">
                Start training free <ArrowRight aria-hidden />
              </ButtonLink>
            </div>
            <p className="mt-4 text-[15px] font-semibold">
              Free to train. Free to start. Sign up in a minute.
            </p>
            <p className="mt-1 text-sm text-muted">No card until you go live.</p>
          </div>
          <HeroQuotes afterHours />
        </section>

        <section className="border-y border-line bg-surface" aria-labelledby="how-title">
          <div className="gutter mx-auto max-w-6xl py-14 md:py-20">
            <h2 id="how-title" className="t-h1 max-w-xl">
              Trained on your prices in about 15 minutes.
            </h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-3">
              {[
                {
                  icon: Sprout,
                  title: 'Tell it what you do',
                  text: 'Your trade, your services and where you work. One screen each.',
                },
                {
                  icon: Camera,
                  title: 'Answer a few pretend customers',
                  text: 'They send photos and ask for a price. You quote them the way you would, and your Charm learns how you price.',
                },
                {
                  icon: Receipt,
                  title: 'Go live',
                  text: 'Customers get your price on your website or from a link, day or night. Anything unusual comes to you first.',
                },
              ].map(({ icon: Icon, title, text }, index) => (
                <li key={title} className="flex gap-4">
                  <span className="font-mono text-sm text-muted">{index + 1}</span>
                  <div>
                    <Icon className="size-6 text-accent" aria-hidden />
                    <h3 className="t-h3 mt-3">{title}</h3>
                    <p className="mt-1.5 text-ink-2">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="gutter mx-auto max-w-6xl py-14 md:py-20" aria-labelledby="where-title">
          <h2 id="where-title" className="t-h2">
            Where customers reach it
          </h2>
          <ul className="mt-6 flex flex-wrap gap-2">
            {[
              { icon: Globe, name: 'Your website' },
              { icon: Link2, name: 'A link or QR code' },
              ...ready.map((channel) => ({ icon: MessageCircle, name: channel.name })),
            ].map(({ icon: Icon, name }) => (
              <li
                key={name}
                className="inline-flex h-11 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-[15px] font-semibold"
              >
                <Icon className="size-4 text-accent" aria-hidden /> {name}
              </li>
            ))}
            {soon.map((channel) => (
              <li
                key={channel.id}
                className={cx(
                  'inline-flex h-11 items-center gap-2 rounded-sm border border-dashed border-line-strong px-3.5 text-[15px] text-muted',
                )}
              >
                {channel.name} <span className="text-xs">soon</span>
              </li>
            ))}
          </ul>

          <div className="mt-14 flex flex-col gap-4 rounded-lg bg-ink p-6 text-on-ink sm:p-8 md:flex-row md:items-center md:justify-between">
            <p className="t-h2 max-w-xl">
              7 in 10 homeowners want a price before they call anyone.
            </p>
            <ButtonLink href={start} size="lg" variant="quote" className="shrink-0">
              Start training free <ArrowRight aria-hidden />
            </ButtonLink>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
