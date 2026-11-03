'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Plus, Search } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { TradeCard } from '@/components/setup/TradeCard';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Button, TextInput } from '@/components/ui';
import { useOnboarding, type BusinessDraft } from '@/lib/onboarding';
import { TRADES, TRADES_BY_ID } from '@/lib/trades';
import { prefersReducedMotion } from '@/lib/util';

export default function TradeStep() {
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  return <TradeForm business={state.business} />;
}

/** The first question: a tap on a trade saves it and moves on to its services. */
function TradeForm({ business }: { business: BusinessDraft }) {
  const router = useRouter();
  const { updateBusiness, goTo } = useOnboarding();
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const customTrade = business.customTrade.trim();
  const chosen = Boolean(business.tradeId || customTrade);

  const typed = query.trim();
  const matchesQuery = (name: string) => name.toLowerCase().includes(typed.toLowerCase());
  const matches = TRADES.filter((item) => matchesQuery(item.name));
  // A trade they typed in sits first, like the listed ones. When nothing fits the search, the
  // search itself becomes the choice.
  const showCustom = Boolean(customTrade) && matchesQuery(customTrade);
  const offerTyped = Boolean(typed) && !matches.length && !showCustom;

  const next = (key: string) => {
    setMoving(key);
    void goTo('services').finally(() => setMoving(null));
  };
  // Picking their trade again, as when coming back to setup, keeps the services they chose.
  const pickTrade = (tradeId: string) => {
    if (tradeId !== business.tradeId) {
      const picked = TRADES_BY_ID[tradeId];
      updateBusiness({
        tradeId,
        customTrade: '',
        services: picked.services.slice(0, picked.preselect),
        customServices: [],
      });
    }
    next(tradeId);
  };
  // Their trade's own name starts as its first service, so there's something to switch on.
  const pickCustomTrade = (name: string) => {
    if (name !== customTrade) {
      const service = name.slice(0, 60).trim();
      updateBusiness({
        tradeId: null,
        customTrade: name,
        services: [service],
        customServices: [service],
      });
    }
    next('custom');
  };
  const focusSearch = () => {
    search.current?.focus();
    search.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="trade" />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-8 pb-16 sm:pt-14">
        <h1 className="t-h1">What kind of business do you run?</h1>
        <p className="mt-3 text-lg text-ink-2">Pick the closest match.</p>

        <div className="relative mt-7">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <label htmlFor="trade-search" className="sr-only">
            Search trades
          </label>
          <TextInput
            ref={search}
            id="trade-search"
            className="pl-11"
            placeholder="Search trades or type your own"
            maxLength={80}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && offerTyped) pickCustomTrade(typed);
            }}
          />
        </div>

        <div
          role="radiogroup"
          aria-label="Trades"
          className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {showCustom && (
            <TradeCard
              icon={Briefcase}
              selected
              busy={moving === 'custom'}
              onClick={() => pickCustomTrade(customTrade)}
            >
              {customTrade}
            </TradeCard>
          )}
          {offerTyped && (
            <TradeCard
              icon={Plus}
              selected={false}
              busy={moving === 'custom'}
              onClick={() => pickCustomTrade(typed)}
              className="col-span-2"
            >
              Use “{typed}”
            </TradeCard>
          )}
          {matches.map((item) => (
            <TradeCard
              key={item.id}
              icon={item.icon}
              selected={business.tradeId === item.id}
              busy={moving === item.id}
              onClick={() => pickTrade(item.id)}
            >
              {item.name}
            </TradeCard>
          ))}
        </div>
        {tried && !chosen && (
          <p className="mt-3 text-sm text-stop" data-field-error="Trade">
            Pick your trade, or type it in the search.
          </p>
        )}
        {!typed && !customTrade && (
          <Button variant="link" className="mt-4" onClick={focusSearch}>
            Don’t see yours? Type it in the search.
          </Button>
        )}
      </main>
      <BottomBar
        onBack={() => router.push('/go')}
        onNext={() => {
          if (chosen) return next(business.tradeId ?? 'custom');
          setTried(true);
          focusSearch();
        }}
        blocked={!chosen}
        hint="Tap your trade to continue."
      />
    </div>
  );
}
