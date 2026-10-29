'use client';

import { useEffect, useState } from 'react';
import { QuoteForm } from '@/components/QuoteForm';
import { Avatar } from '@/components/ui';
import { HERO_EXAMPLES, heroQuote } from '@/lib/demos';
import { PHOTOS } from '@/lib/photos';
import { cx, prefersReducedMotion } from '@/lib/util';

const EVERY_MS = 4000;
/** When each request came in, and from where: the owner was out working, not at a desk. */
const ARRIVED = [
  '11:20 am · from your website',
  '2:45 pm · from your link',
  '8:40 pm · from your website',
  '7:05 am · from your link',
];

/**
 * Accepted quotes from different trades, one after another. It holds still while the visitor
 * points at it, and doesn't move at all for people who prefer less motion.
 */
export function HeroQuotes() {
  const [index, setIndex] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [still, setStill] = useState(false);
  const [moved, setMoved] = useState(false);

  useEffect(() => setStill(prefersReducedMotion()), []);
  useEffect(() => {
    if (still || hovering) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setMoved(true);
      setIndex((current) => (current + 1) % HERO_EXAMPLES.length);
    }, EVERY_MS);
    return () => window.clearInterval(timer);
  }, [still, hovering]);

  const demo = HERO_EXAMPLES[index];
  const { customer } = demo.hero;

  return (
    <div
      className="rise relative mx-auto h-[470px] w-full max-w-[460px] md:mx-0 md:justify-self-end"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
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
            <p className="text-xs text-muted">New request · {ARRIVED[index % ARRIVED.length]}</p>
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
  );
}
