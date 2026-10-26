'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { QuoteForm } from '@/components/QuoteForm';
import { Avatar } from '@/components/ui';
import { HERO_EXAMPLES, heroQuote } from '@/lib/demos';
import { PHOTOS } from '@/lib/photos';
import { TRADE_DATA_BY_ID } from '@/lib/trades';
import { cx, prefersReducedMotion } from '@/lib/util';

const EVERY_MS = 6000;

/**
 * Accepted quotes from different trades, one at a time. It moves on by itself unless the visitor
 * prefers less motion, pauses while they point at or tab into it, and stops once they pick one.
 */
export function HeroQuotes() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [moved, setMoved] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) setPlaying(false);
  }, []);
  useEffect(() => {
    if (!playing || hovering) return;
    const timer = window.setInterval(() => {
      setMoved(true);
      setIndex((current) => (current + 1) % HERO_EXAMPLES.length);
    }, EVERY_MS);
    return () => window.clearInterval(timer);
  }, [playing, hovering]);

  const demo = HERO_EXAMPLES[index];
  const { customer } = demo.hero;
  const trade = TRADE_DATA_BY_ID[demo.tradeId]?.name ?? '';

  return (
    <div
      ref={root}
      className="rise relative mx-auto w-full max-w-[460px] md:mx-0 md:justify-self-end"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setHovering(false);
      }}
    >
      {/* A fixed height, so the controls below never jump between examples. */}
      <div className="h-[470px]" aria-live={playing ? 'off' : 'polite'}>
        <div
          key={`request-${demo.tradeId}`}
          className={cx(
            'w-[88%] rounded-md border border-line bg-surface p-4 shadow-2',
            moved && 'fade-up',
          )}
        >
          <div className="flex items-center gap-2.5">
            <Avatar initials={customer.initials} tone={customer.tone} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {customer.name} · {customer.place}
              </p>
              <p className="text-xs text-muted">
                New {trade.toLowerCase()} request
                {demo.hero.photos ? ` · ${demo.hero.photos.length} photos` : ''}
              </p>
            </div>
          </div>
          <p className="mt-3 text-[15px] leading-[1.55]">{demo.hero.request}</p>
          {demo.hero.photos ? (
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {demo.hero.photos.map((photo) => (
                <img
                  key={photo}
                  src={PHOTOS[photo]}
                  alt=""
                  className="aspect-[4/3] w-full max-w-full rounded-sm object-cover"
                />
              ))}
            </div>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Details">
              {demo.hero.facts.map((fact) => (
                <li
                  key={fact}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-2"
                >
                  {fact}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div
          key={`quote-${demo.tradeId}`}
          className={cx(
            'relative mr-4 ml-auto w-[74%] rotate-[1.5deg] sm:w-[68%]',
            demo.hero.photos ? '-mt-24' : '-mt-2',
          )}
        >
          <QuoteForm
            quote={heroQuote(demo)}
            business={demo.business}
            stamp="accepted"
            animate={moved}
            compact
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-1.5">
        <span className="sr-only">Show an example from</span>
        {HERO_EXAMPLES.map((example, position) => (
          <button
            key={example.tradeId}
            type="button"
            aria-pressed={position === index}
            onClick={() => {
              setMoved(true);
              setIndex(position);
              setPlaying(false);
            }}
            className={cx(
              'h-8 rounded-full border px-3 text-xs font-medium transition-colors',
              position === index
                ? 'border-ink bg-ink text-on-ink'
                : 'border-line-strong text-ink-2 hover:text-ink',
            )}
          >
            {TRADE_DATA_BY_ID[example.tradeId]?.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? 'Pause the examples' : 'Play the examples'}
          className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
      </div>
    </div>
  );
}
