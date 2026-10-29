import { ArrowRight, Camera, Hand, MessageSquareText, Receipt, ShieldCheck } from 'lucide-react';
import { DemoExplorer } from '@/components/demo/DemoExplorer';
import { HeroQuotes } from '@/components/site/HeroQuotes';
import { SiteFooter, SiteHeader } from '@/components/site/SiteHeader';
import { TradeMarquee } from '@/components/site/TradeMarquee';
import { buttonClass } from '@/components/button-class';
import { Avatar, ButtonLink, Tag } from '@/components/ui';
import { PHOTOS } from '@/lib/photos';
import { publicPricing } from '@/lib/server-api';
import { money } from '@/lib/util';

export default async function LandingPage() {
  const pricing = await publicPricing();
  return (
    <div className="min-h-dvh">
      <SiteHeader howItWorks />

      <main>
        <section className="gutter mx-auto grid max-w-6xl items-center gap-12 pt-6 pb-20 md:grid-cols-[1.15fr_1fr] md:gap-10 md:pt-14 md:pb-28">
          <div className="max-w-[600px]">
            <Tag tone="canary" size="lg">
              Quote More, Book More
            </Tag>
            <h1 className="t-hero mt-5">Quotes your new customers while you're on the job.</h1>
            <p className="mt-6 max-w-[34rem] text-lg text-ink-2">
              Show it a few jobs you've done. It learns your prices and the questions you ask, then
              quotes new customers on your website or through a link you send.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/start" size="lg">
                Get started <ArrowRight aria-hidden />
              </ButtonLink>
              <a href="#demo" className={buttonClass('secondary', 'lg')}>
                Try the demo
              </a>
            </div>
            <p className="mt-4 text-sm text-muted">
              About 5 minutes · Free to set up · No card to start
            </p>
          </div>

          <HeroQuotes />
        </section>

        <section id="how" className="border-y border-line bg-surface">
          <div className="gutter mx-auto max-w-6xl py-20">
            <h2 className="t-h1 max-w-xl">Three steps. Then it's quoting.</h2>
            <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
              <li className="flex min-w-0 flex-col gap-5">
                <TradeMarquee />
                <div>
                  <p className="font-mono text-sm text-muted">Step 1</p>
                  <h3 className="t-h2 mt-1">Pick your trade</h3>
                  <p className="mt-2 text-ink-2">
                    Choose what you do and which services you offer. We set up the basics for your
                    trade.
                  </p>
                </div>
              </li>
              <li className="flex flex-col gap-5">
                <div className="flex h-44 items-center rounded-md bg-surface-2 p-5" aria-hidden>
                  <div className="flex w-full items-center gap-3 rounded-sm border border-line bg-surface p-3 shadow-1">
                    <img
                      src={PHOTOS['table-stains']}
                      alt=""
                      className="size-14 rounded-xs object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">Back patio and walkway</p>
                      <p className="text-xs text-muted">600 sq ft · 3 hours · June</p>
                    </div>
                    <p className="font-mono text-sm font-semibold">$275</p>
                  </div>
                </div>
                <div>
                  <p className="font-mono text-sm text-muted">Step 2</p>
                  <h3 className="t-h2 mt-1">Add jobs you've done</h3>
                  <p className="mt-2 text-ink-2">
                    Photos, what you charged, how long it took, any discounts. Or upload an old
                    invoice and we'll fill it in.
                  </p>
                </div>
              </li>
              <li className="flex flex-col gap-5">
                <div
                  className="flex h-44 flex-col justify-center gap-3 rounded-md bg-surface-2 p-5"
                  aria-hidden
                >
                  <div className="flex gap-1 md:max-lg:hidden">
                    <span className="h-1.5 flex-1 rounded-full bg-canary" />
                    <span className="h-1.5 flex-1 rounded-full bg-canary" />
                    <span className="h-1.5 flex-1 rounded-full bg-line-strong" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Avatar initials="MT" tone="pink" size="sm" />
                    <p className="rounded-[12px] rounded-bl-[4px] border border-line bg-surface px-3 py-2 text-sm">
                      Pics attached. Is the neighbor discount still a thing?
                    </p>
                  </div>
                  <span className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-sm bg-canary px-2.5 text-[13px] font-semibold whitespace-nowrap text-on-canary">
                    <Receipt className="size-4" /> I have enough to quote
                  </span>
                </div>
                <div>
                  <p className="font-mono text-sm text-muted">Step 3</p>
                  <h3 className="t-h2 mt-1">Practice with a customer</h3>
                  <p className="mt-2 text-ink-2">
                    A pretend customer sends a real-looking request with photos. You ask questions
                    and send a quote. Train it as much as you want.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section
          id="demo"
          className="gutter mx-auto grid max-w-6xl scroll-mt-6 items-start gap-14 py-20 md:grid-cols-2"
        >
          <DemoExplorer
            intro={
              <>
                <h2 className="t-h1">Your customers get a real quote in about two minutes.</h2>
                <p className="mt-5 text-lg text-ink-2">
                  Try it as a customer. Pick an industry, answer a few questions and see the quote
                  they get. The prices are samples; yours come from your own jobs.
                </p>
                <ul className="mt-8 flex flex-col gap-4 text-ink-2">
                  {[
                    {
                      icon: MessageSquareText,
                      text: 'Asks the questions you would ask, one at a time',
                    },
                    { icon: Camera, text: 'Asks for photos on every job' },
                    { icon: Receipt, text: 'Prices it the way you do, line by line' },
                    { icon: Hand, text: 'Sends anything unusual to you first' },
                  ].map(({ icon: Icon, text }) => (
                    <li key={text} className="flex gap-3">
                      <Icon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
                      {text}
                    </li>
                  ))}
                </ul>
              </>
            }
          />
        </section>

        <section className="border-t border-line bg-surface">
          <div className="gutter mx-auto grid max-w-6xl gap-10 py-16 md:grid-cols-3">
            {[
              {
                icon: ShieldCheck,
                title: 'Your prices, nobody else’s',
                text: 'It quotes from your jobs and your practice quotes. It never pulls prices from the internet.',
              },
              {
                icon: Hand,
                title: 'Odd jobs come to you',
                text: 'Anything outside your usual range waits for your OK. Approve it with one tap.',
              },
              {
                icon: Receipt,
                title: '$0 up front',
                text: `Pay ${money(pricing.perQuoteCents)} a quote, or ${pricing.accepted.basisPoints / 100}% of the quotes customers accept. Or ${money(pricing.subscription.monthlyCents)} a month with the first week free. Setting up and practice are free.`,
              },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title}>
                <Icon className="size-6 text-accent" aria-hidden />
                <h3 className="t-h3 mt-4">{title}</h3>
                <p className="mt-2 text-ink-2">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-ink text-on-ink">
          <div className="gutter mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
            <h2 className="t-h1 max-w-xl">Train yours in about 5 minutes.</h2>
            <ButtonLink href="/start" variant="quote" size="lg">
              Get started <ArrowRight aria-hidden />
            </ButtonLink>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
