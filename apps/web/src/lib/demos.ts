import {
  DEMOS,
  DEMOS_BY_TRADE,
  type Demo,
  type DemoExtra,
  type DemoOption,
  type DemoPhotos,
  type HeroExample,
} from '@pricecharm/trades/demos';
import type { Quote, QuoteLine } from './quote';
import { round5 } from './util';

/**
 * The public demo's sample businesses live in @pricecharm/trades, so the API prices demo chats
 * from the same data. This adds what the web pages need on top.
 */
export { DEMOS, DEMOS_BY_TRADE };
export type { Demo, DemoExtra, DemoOption, DemoPhotos, HeroExample };

/** The accepted quotes the home page rotates through. */
export const HERO_EXAMPLES = DEMOS.filter((demo): demo is Demo & { hero: HeroExample } =>
  Boolean(demo.hero),
);

/** The hero example as a full quote card. */
export function heroQuote(demo: Demo & { hero: HeroExample }): Quote {
  return {
    number: demo.hero.number,
    customer: demo.hero.customer.name,
    place: demo.hero.customer.place,
    lines: demo.hero.lines.map((line, index) => ({ id: `${demo.tradeId}-${index}`, ...line })),
    discount: null,
    start: demo.start,
    duration: demo.duration,
    included: demo.included,
    excluded: demo.excluded,
    validDays: 14,
    note: '',
    issuedAt: new Date().toISOString(),
  };
}

/** The quote the demo chat ends with, priced from the visitor's answers. */
export function demoQuote(
  demo: Demo,
  answers: { service: string; size: DemoOption; extra?: DemoExtra },
): Quote {
  const base = demo.prices[answers.service] ?? Object.values(demo.prices)[0];
  const lines: QuoteLine[] = [
    {
      id: 'demo-main',
      label: `${answers.service}, ${answers.size.line}`,
      amountCents: Math.max(round5(base * answers.size.factor), 2500),
    },
  ];
  if (answers.extra?.add) lines.push({ id: 'demo-extra', ...answers.extra.add });
  return {
    number: 1001,
    customer: 'You',
    place: demo.area,
    lines,
    discount: null,
    start: demo.start,
    duration: demo.duration,
    included: demo.included,
    excluded: demo.excluded,
    validDays: 14,
    note: '',
    issuedAt: new Date().toISOString(),
  };
}
