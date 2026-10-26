import { ArrowRight, Camera, Check, Hand, MessageSquareText, Receipt, ShieldCheck } from 'lucide-react';
import { PHOTOS } from '../assets/photos';
import { Logo } from '../components/Logo';
import { PrototypeMenu } from '../components/PrototypeMenu';
import { PaperButton, QuoteForm } from '../components/QuoteForm';
import { useToast } from '../components/Toast';
import { Avatar, Button, Chip, Tag } from '../components/ui';
import { useStore } from '../lib/store';
import type { Quote } from '../lib/types';

const today = new Date().toISOString();

const HERO_QUOTE: Quote = {
  number: 1038,
  customer: 'Dana R.',
  place: 'Eastgate',
  lines: [
    { id: 'h1', label: 'Patio wash, about 550 sq ft', amountCents: 28000 },
    { id: 'h2', label: 'Stain pre-treatment', amountCents: 4500 },
  ],
  discount: null,
  start: 'Next week',
  duration: '3 hours',
  included: [],
  excluded: [],
  validDays: 14,
  note: '',
  issuedAt: today,
};

const CUSTOMER_QUOTE: Quote = {
  number: 1052,
  customer: 'Sam K.',
  place: 'Westmoreland',
  lines: [
    { id: 'c1', label: 'Driveway wash, about 640 sq ft', amountCents: 26000 },
    { id: 'c2', label: 'Oil stain treatment, 2 spots', amountCents: 4000 },
    { id: 'c3', label: 'Front walk and steps', amountCents: 6500 },
  ],
  discount: { kind: 'amount', value: 2500, reason: 'Booked with a neighbor' },
  start: 'This week',
  duration: '4 hours',
  included: ['Hot-water surface clean', 'Rinse of nearby siding'],
  excluded: ['Sealing', 'Crack repair'],
  validDays: 14,
  note: '',
  issuedAt: today,
};

export function Landing() {
  const { dispatch } = useStore();
  const notify = useToast();
  const start = () => dispatch({ type: 'go', screen: 'business' });
  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Logo />
          <PrototypeMenu />
        </div>
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
          <a href="#how" className="hidden rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:text-ink sm:inline">
            How it works
          </a>
          <Button variant="ghost" onClick={() => notify('Prototype: sign-in is not part of this flow.')}>
            Sign in
          </Button>
        </nav>
      </header>

      <main>
        <section className="gutter mx-auto grid max-w-6xl items-center gap-12 pt-6 pb-20 md:grid-cols-[1.15fr_1fr] md:gap-10 md:pt-14 md:pb-28">
          <div className="max-w-[600px]">
            <Tag tone="canary">For service businesses</Tag>
            <h1 className="t-hero mt-5">Train an AI to produce real quotes for you in 3 easy steps.</h1>
            <p className="mt-6 max-w-[34rem] text-lg text-ink-2">
              Show it a few jobs you've done. Answer a couple of practice customers. Then it quotes your real ones,
              with your prices and your questions.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button size="lg" onClick={start}>
                Get started <ArrowRight aria-hidden />
              </Button>
              <p className="text-sm text-muted">About 15 minutes · Free · No card needed</p>
            </div>
          </div>

          <div className="rise relative mx-auto w-full max-w-[460px] pb-40 md:mx-0 md:justify-self-end">
            <div className="w-[88%] rounded-md border border-line bg-surface p-4 shadow-2">
              <div className="flex items-center gap-2.5">
                <Avatar initials="DR" tone="canary" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Dana R. · Eastgate</p>
                  <p className="text-xs text-muted">New quote request · 2 photos</p>
                </div>
              </div>
              <p className="mt-3 text-[15px] leading-[1.55]">
                Hi! We're listing the house soon. Could you give me a price to pressure wash the back patio?
              </p>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                <img src={PHOTOS['patio-overview']} alt="Stained concrete patio with a flagstone inlay" className="aspect-[4/3] w-full max-w-full rounded-sm object-cover" />
                <img src={PHOTOS['patio-stains']} alt="Close-up of dark stains on the concrete" className="aspect-[4/3] w-full max-w-full rounded-sm object-cover" />
              </div>
            </div>
            <div className="absolute right-4 bottom-2 w-[74%] rotate-[1.5deg] sm:w-[68%]">
              <QuoteForm quote={HERO_QUOTE} business="Moss & Stone Exterior Care" stamp="sent" compact />
            </div>
          </div>
        </section>

        <section id="how" className="border-y border-line bg-surface">
          <div className="gutter mx-auto max-w-6xl py-20">
            <h2 className="t-h1 max-w-xl">Three steps. Then it's quoting.</h2>
            <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
              <li className="flex flex-col gap-5">
                <div className="flex h-44 flex-wrap content-center gap-2 rounded-md bg-surface-2 p-5" aria-hidden>
                  <Chip selected>Pressure washing</Chip>
                  <Chip>Window cleaning</Chip>
                  <Chip>Lawn care</Chip>
                  <Chip>Painting</Chip>
                </div>
                <div>
                  <p className="font-mono text-sm text-muted">Step 1</p>
                  <h3 className="t-h2 mt-1">Pick your trade</h3>
                  <p className="mt-2 text-ink-2">Choose what you do and which services you offer. We set up the basics for your trade.</p>
                </div>
              </li>
              <li className="flex flex-col gap-5">
                <div className="flex h-44 items-center rounded-md bg-surface-2 p-5" aria-hidden>
                  <div className="flex w-full items-center gap-3 rounded-sm border border-line bg-surface p-3 shadow-1">
                    <img src={PHOTOS['table-stains']} alt="" className="size-14 rounded-xs object-cover" />
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
                    Photos, what you charged, how long it took, any discounts. Or upload an old invoice and we'll fill it in.
                  </p>
                </div>
              </li>
              <li className="flex flex-col gap-5">
                <div className="flex h-44 flex-col justify-center gap-3 rounded-md bg-surface-2 p-5" aria-hidden>
                  <div className="flex items-center gap-2">
                    <Avatar initials="MT" tone="pink" size="sm" />
                    <p className="rounded-[12px] rounded-bl-[4px] border border-line bg-surface px-3 py-2 text-sm">
                      Pics attached. Is the neighbor discount still a thing?
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex h-9 items-center gap-1.5 rounded-sm bg-canary px-3 text-sm font-semibold text-on-canary">
                      <Receipt className="size-4" /> Create quote
                    </span>
                    <div className="flex w-24 gap-1">
                      <span className="h-1.5 flex-1 rounded-full bg-canary" />
                      <span className="h-1.5 flex-1 rounded-full bg-canary" />
                      <span className="h-1.5 flex-1 rounded-full bg-line-strong" />
                    </div>
                  </div>
                </div>
                <div>
                  <p className="font-mono text-sm text-muted">Step 3</p>
                  <h3 className="t-h2 mt-1">Practice with a customer</h3>
                  <p className="mt-2 text-ink-2">
                    A pretend customer sends a real-looking request with photos. You ask questions and send a quote. Three of
                    these and it's trained.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="gutter mx-auto grid max-w-6xl items-center gap-14 py-20 md:grid-cols-2">
          <div className="max-w-md">
            <h2 className="t-h1">Your customers get a real quote in about two minutes.</h2>
            <ul className="mt-8 flex flex-col gap-4 text-ink-2">
              {[
                { icon: MessageSquareText, text: 'Asks the questions you would ask, one at a time' },
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
          </div>
          <div className="mx-auto w-full max-w-[460px] pr-3 pb-3">
            <QuoteForm
              quote={CUSTOMER_QUOTE}
              business="Moss & Stone Exterior Care"
              footnote="Estimate based on the photos and details you shared."
              actions={
                <>
                  <PaperButton primary onClick={() => notify('Prototype: this is what your customer sees.')}>
                    <Check aria-hidden /> Accept quote
                  </PaperButton>
                  <PaperButton onClick={() => notify('Prototype: this is what your customer sees.')}>Ask a question</PaperButton>
                </>
              }
            />
          </div>
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
                title: 'Pay per quote',
                text: 'Your first 10 quotes are free. After that you pay a small fee for each quote a customer receives.',
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
            <h2 className="t-h1 max-w-xl">Train yours in about 15 minutes.</h2>
            <button
              type="button"
              onClick={start}
              className="inline-flex h-13 items-center gap-2.5 rounded-sm bg-canary px-6 font-semibold text-on-canary shadow-[inset_0_-2px_0_rgb(16_22_51/0.18)] hover:brightness-[1.03]"
            >
              Get started <ArrowRight className="size-[1.1em]" aria-hidden />
            </button>
          </div>
        </section>
      </main>

      <footer className="gutter mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted">
        <span>© 2026 Quotefolk</span>
        <span className="flex gap-5">
          <span>Privacy</span>
          <span>Terms</span>
        </span>
      </footer>
    </div>
  );
}
