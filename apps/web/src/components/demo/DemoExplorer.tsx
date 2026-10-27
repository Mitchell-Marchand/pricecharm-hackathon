'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { buttonClass } from '@/components/button-class';
import { ButtonLink } from '@/components/ui';
import { DEMOS_BY_TRADE } from '@/lib/demos';
import { TRADES, TRADES_BY_ID } from '@/lib/trades';
import { cx } from '@/lib/util';
import { DemoChat } from './DemoChat';

const DEMO_TRADES = TRADES.filter((trade) => DEMOS_BY_TRADE[trade.id]);

/** "pressure washing", but "HVAC" stays as it is. */
const tradeWords = (name: string) => (name === name.toUpperCase() ? name : name.toLowerCase());

/**
 * The demo chat with a way to switch industries, beside `intro`. On the home page it's a compact
 * picker, with the intro and a link to the full demo on the left. On /demo it lists every trade,
 * keeps the choice in the address so the link can be shared, and offers to set one up for the
 * trade being tried.
 */
export function DemoExplorer({
  intro,
  full = false,
  initialTrade = 'pressure-washing',
}: {
  intro: ReactNode;
  full?: boolean;
  initialTrade?: string;
}) {
  const selectId = useId();
  const [tradeId, setTradeId] = useState(initialTrade);

  function choose(id: string) {
    setTradeId(id);
    if (full) window.history.replaceState(null, '', `/demo?trade=${encodeURIComponent(id)}`);
  }

  const demo = DEMOS_BY_TRADE[tradeId] ?? DEMOS_BY_TRADE['pressure-washing'];
  const setUp = `/start?trade=${encodeURIComponent(demo.tradeId)}`;
  const picker = (
    <div className={cx('flex flex-col gap-1.5', full && 'md:hidden')}>
      <label htmlFor={selectId} className="text-sm font-semibold">
        Pick an industry
      </label>
      <select
        id={selectId}
        value={demo.tradeId}
        onChange={(event) => choose(event.target.value)}
        className="h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:outline-none"
      >
        {DEMO_TRADES.map((trade) => (
          <option key={trade.id} value={trade.id}>
            {trade.name}
          </option>
        ))}
      </select>
    </div>
  );
  const chat = <DemoChat key={demo.tradeId} demo={demo} className="h-[620px] max-h-[80dvh]" />;

  if (!full)
    return (
      <>
        <div className="max-w-md md:sticky md:top-10">
          {intro}
          <Link
            href={`/demo?trade=${demo.tradeId}`}
            className={buttonClass('secondary', 'lg', 'mt-8')}
          >
            Open the full demo
          </Link>
        </div>
        <div className="mx-auto flex w-full max-w-[460px] flex-col gap-4">
          {picker}
          {chat}
        </div>
      </>
    );

  return (
    <>
      <div className="max-w-2xl">
        {intro}
        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ButtonLink href={setUp} size="lg">
            Create my agent <ArrowRight aria-hidden />
          </ButtonLink>
          <p className="text-sm text-muted">About 5 minutes · Free to set up · No card to start</p>
        </div>
      </div>
      <div className="mt-10 grid items-start gap-6 md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,460px)] lg:gap-10">
        {picker}
        <nav aria-label="Industries" className="hidden md:block">
          <ul className="flex flex-col gap-1">
            {DEMO_TRADES.map(({ id, name, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  aria-current={id === demo.tradeId ? 'true' : undefined}
                  onClick={() => choose(id)}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-[15px] transition-colors',
                    id === demo.tradeId
                      ? 'bg-ink font-semibold text-on-ink'
                      : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden /> {name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-col gap-4 md:sticky md:top-6">
          {chat}
          {/* Stays beside the chat as it scrolls, for whoever likes what they just saw. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="text-[15px] text-ink-2">
              Want this for your {tradeWords(TRADES_BY_ID[demo.tradeId]?.name ?? 'own')} business?
            </p>
            <ButtonLink href={setUp}>Create my agent</ButtonLink>
          </div>
        </div>
      </div>
    </>
  );
}
