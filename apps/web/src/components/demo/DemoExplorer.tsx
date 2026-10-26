'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { DEMOS_BY_TRADE } from '@/lib/demos';
import { TRADES } from '@/lib/trades';
import { cx } from '@/lib/util';
import { DemoChat } from './DemoChat';

const DEMO_TRADES = TRADES.filter((trade) => DEMOS_BY_TRADE[trade.id]);

/**
 * The demo chat with a way to switch industries. On the home page it's a compact picker; on
 * /demo it lists every trade and keeps the choice in the address, so the link can be shared.
 */
export function DemoExplorer({
  full = false,
  initialTrade = 'pressure-washing',
}: {
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
      <div className="flex flex-col gap-4">
        {picker}
        {chat}
        <Link
          href={`/demo?trade=${demo.tradeId}`}
          className="inline-flex items-center gap-1.5 self-start text-[15px] font-semibold text-accent hover:underline"
        >
          Open the full demo <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    );

  return (
    <div className="grid items-start gap-6 md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,460px)] lg:gap-10">
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
      <div className="md:sticky md:top-6">{chat}</div>
    </div>
  );
}
