'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SetupLoading } from '@/components/SetupLoading';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useOnboarding, type BusinessDraft, type Onboarding } from '@/lib/onboarding';
import { TRADES_BY_ID } from '@/lib/trades';

/** "your roofing Charm", keeping a name like HVAC as it's written. */
function charmName(business: BusinessDraft) {
  const listed = TRADES_BY_ID[business.tradeId ?? '']?.name ?? '';
  const trade = listed === listed.toUpperCase() ? listed : listed.toLowerCase();
  const name = trade || business.customTrade.trim();
  return name ? `your ${name} Charm` : 'your Charm';
}

/**
 * Where every link into setup lands. A new setup opens on its first step, or from a demo's "Create
 * my agent" or a trade's ad (/start?trade=painting) on that trade's services. A setup that's
 * already under way asks before going back to it, so nobody lands mid-setup with no idea why, and
 * a signed-in owner goes to their account.
 */
export default function StartPage() {
  const router = useRouter();
  const { state, updateBusiness, startOver } = useOnboarding();
  const opened = useRef(false);
  const [returning, setReturning] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const open = useCallback(
    ({ step, business }: Onboarding) => {
      const trade = TRADES_BY_ID[new URLSearchParams(window.location.search).get('trade') ?? ''];
      const pick = trade && step === 'trade' && !business.tradeId && !business.customTrade.trim();
      if (pick)
        updateBusiness({
          tradeId: trade.id,
          customTrade: '',
          services: trade.services.slice(0, trade.preselect),
          customServices: [],
        });
      router.replace(pick ? '/start/services' : `/start/${step}`);
    },
    [router, updateBusiness],
  );

  useEffect(() => {
    if (!state || opened.current) return;
    opened.current = true;
    if (!state.draft) router.replace('/app');
    else if (state.step === 'trade') open(state);
    else setReturning(true);
  }, [state, router, open]);

  async function restart() {
    setRestarting(true);
    setError('');
    try {
      open(await startOver());
    } catch (restartError) {
      setError(errorMessage(restartError));
      setRestarting(false);
    }
  }

  if (!state || !returning) return <SetupLoading />;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="gutter mx-auto flex h-16 w-full max-w-6xl items-center">
        <Logo href="/" />
      </header>
      <main className="gutter mx-auto w-full max-w-[600px] flex-1 pt-8 sm:pt-14">
        <h1 className="t-h1">Welcome back.</h1>
        <p className="mt-3 text-lg text-ink-2">
          Keep going with {charmName(state.business)}, or start over.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button size="lg" disabled={restarting} onClick={() => open(state)}>
            Keep going <ArrowRight aria-hidden />
          </Button>
          <Button
            size="lg"
            variant="secondary"
            disabled={restarting}
            onClick={() => void restart()}
          >
            {restarting ? 'Starting over…' : 'Start over'}
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted">Starting over leaves this setup behind.</p>
        {error && (
          <p className="mt-4 text-stop" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
