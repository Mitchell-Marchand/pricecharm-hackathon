'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { CustomerMessage, Typing } from '@/components/Chat';
import { PaperButton, QuoteForm } from '@/components/QuoteForm';
import { Avatar, Button, Tag } from '@/components/ui';
import { greeting } from '@/lib/chat';
import { demoQuote, type Demo, type DemoExtra, type DemoOption } from '@/lib/demos';
import { PHOTOS } from '@/lib/photos';
import type { Quote } from '@/lib/quote';
import { TRADE_DATA_BY_ID } from '@/lib/trades';
import { cx, uid } from '@/lib/util';

type Step = 'service' | 'size' | 'photo' | 'extra' | 'contact' | 'building' | 'quote' | 'done';
interface Line {
  id: string;
  from: 'bot' | 'me';
  text?: string;
  photo?: string;
  quote?: boolean;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

/**
 * What a customer sees on a business's quote link, played out with sample answers and prices.
 * It runs in the browser only: no AI, no network, and nothing is saved or sent.
 */
export function DemoChat({ demo, className }: { demo: Demo; className?: string }) {
  const services = TRADE_DATA_BY_ID[demo.tradeId]?.services ?? Object.keys(demo.prices);
  const initials = initialsOf(demo.business) || 'Q';
  const [step, setStep] = useState<Step>('service');
  const [lines, setLines] = useState<Line[]>(() => [
    { id: 'hello', from: 'bot', text: greeting(demo.business) },
  ]);
  const [typing, setTyping] = useState(false);
  const [answers, setAnswers] = useState<{
    service?: string;
    size?: DemoOption;
    extra?: DemoExtra;
  }>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [accepted, setAccepted] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  // Scroll the chat, never the page around it.
  useEffect(() => {
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [lines.length, typing, step]);

  function reply(text: string, next: Step, delay = 800, extra: Line[] = []) {
    setTyping(true);
    timers.current.push(
      window.setTimeout(() => {
        setTyping(false);
        setLines((current) => [...current, { id: uid('d'), from: 'bot', text }, ...extra]);
        setStep(next);
      }, delay),
    );
  }
  const say = (text: string, photo?: string) =>
    setLines((current) => [...current, { id: uid('d'), from: 'me', text, photo }]);

  function afterPhoto() {
    if (demo.extra) reply(demo.extra.ask, 'extra');
    else toContact();
  }
  function toContact() {
    reply(
      'Thanks, that’s everything I need. In the real chat I’d ask where to send your quote, and you’d confirm your email with a code.',
      'contact',
    );
  }

  function seeQuote() {
    if (!answers.service || !answers.size) return;
    say('See my quote');
    setStep('building');
    setQuote(
      demoQuote(demo, { service: answers.service, size: answers.size, extra: answers.extra }),
    );
    reply('Here’s your quote. A copy is on its way to your inbox.', 'quote', 1300, [
      { id: uid('d'), from: 'bot', quote: true },
    ]);
  }

  function restart() {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setTyping(false);
    setLines([{ id: uid('d'), from: 'bot', text: greeting(demo.business) }]);
    setAnswers({});
    setQuote(null);
    setAccepted(false);
    setStep('service');
  }

  const chips: { label: string; onPick: () => void }[] =
    step === 'service'
      ? services.map((service) => ({
          label: service,
          onPick: () => {
            say(service);
            setAnswers({ service });
            reply(demo.size.ask, 'size');
          },
        }))
      : step === 'size'
        ? demo.size.options.map((option) => ({
            label: option.label,
            onPick: () => {
              say(option.label);
              setAnswers((current) => ({ ...current, size: option }));
              reply('Could you send a photo or two? It helps price it right.', 'photo');
            },
          }))
        : step === 'photo'
          ? [
              ...(demo.tradeId === 'pressure-washing'
                ? [
                    {
                      label: 'Send a sample photo',
                      onPick: () => {
                        say('', PHOTOS.planters);
                        afterPhoto();
                      },
                    },
                  ]
                : []),
              {
                label: 'Skip photos',
                onPick: () => {
                  say('Skip photos');
                  afterPhoto();
                },
              },
            ]
          : step === 'extra' && demo.extra
            ? demo.extra.options.map((option) => ({
                label: option.label,
                onPick: () => {
                  say(option.label);
                  setAnswers((current) => ({ ...current, extra: option }));
                  toContact();
                },
              }))
            : [];

  return (
    <div
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-2',
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar initials={initials} tone="ink" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{demo.business}</p>
          <p className="text-xs text-muted">Usually quotes in about 2 minutes</p>
        </div>
        <Tag>Demo</Tag>
      </header>
      <p className="bg-canary-soft px-4 py-2 text-xs text-ink">
        Sample prices. Your AI asks your questions and quotes your prices.
      </p>

      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-4"
        aria-live="polite"
      >
        {lines.map((line) => {
          if (line.quote && quote)
            return (
              <div key={line.id} className="pr-3 pb-3">
                <QuoteForm
                  quote={quote}
                  business={demo.business}
                  stamp={accepted ? 'accepted' : undefined}
                  animate
                  footnote="Estimate based on the details you shared."
                  actions={
                    step === 'quote' ? (
                      <>
                        <PaperButton
                          primary
                          onClick={() => {
                            setAccepted(true);
                            reply(
                              `You’re all set. ${demo.owner} will be in touch to schedule.`,
                              'done',
                              600,
                            );
                          }}
                        >
                          <Check aria-hidden /> Accept quote
                        </PaperButton>
                        <PaperButton
                          onClick={() =>
                            reply(
                              `In the real chat, your question goes straight to ${demo.owner}.`,
                              'quote',
                              500,
                            )
                          }
                        >
                          Ask a question
                        </PaperButton>
                        <PaperButton
                          onClick={() =>
                            reply(
                              `Got it. ${demo.owner} will get in touch to set up a visit.`,
                              'done',
                              600,
                            )
                          }
                        >
                          Request a site visit
                        </PaperButton>
                      </>
                    ) : undefined
                  }
                />
              </div>
            );
          if (line.from === 'me')
            return (
              <div key={line.id} className="fade-up flex justify-end">
                <Mine photo={!!line.photo}>
                  {line.photo ? (
                    <img
                      src={line.photo}
                      alt="Your photo"
                      className="w-56 max-w-full rounded-[12px]"
                    />
                  ) : (
                    <p className="text-[15px]">{line.text}</p>
                  )}
                </Mine>
              </div>
            );
          return (
            <CustomerMessage
              key={line.id}
              name={demo.business}
              initials={initials}
              tone="blue"
              showAvatar={false}
            >
              {line.text}
            </CustomerMessage>
          );
        })}
        {typing && <Typing name={demo.business} initials={initials} tone="blue" />}
      </div>

      <footer className="flex min-h-[68px] flex-col justify-center gap-2 border-t border-line bg-surface px-3 py-3">
        {chips.length > 0 && !typing && (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={chip.onPick}
                className="inline-flex min-h-10 items-center rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent-soft"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {step === 'contact' && !typing && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={seeQuote}>See my quote</Button>
            <p className="text-xs text-muted">The demo skips the email code.</p>
          </div>
        )}
        {(step === 'quote' || step === 'done') && !typing && (
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-1.5 self-start text-sm text-accent underline underline-offset-4"
          >
            <RotateCcw className="size-4" aria-hidden /> Start over
          </button>
        )}
      </footer>
    </div>
  );
}

function Mine({ photo, children }: { photo: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        'max-w-[80%] rounded-[16px] rounded-br-[4px] bg-accent text-on-accent',
        photo ? 'p-1.5' : 'px-3.5 py-2.5',
      )}
    >
      {children}
    </div>
  );
}
