'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { SetupLoading } from '@/components/SetupLoading';
import { useOnboarding } from '@/lib/onboarding';
import { TRADES_BY_ID } from '@/lib/trades';

/**
 * Opens the step this setup was last on. From a demo's "Create my agent" or a trade's ad
 * (/start?trade=painting), a setup that hasn't picked a trade yet starts on that one's services.
 */
export default function StartPage() {
  const router = useRouter();
  const { state, updateBusiness } = useOnboarding();
  const opened = useRef(false);
  useEffect(() => {
    if (!state || opened.current) return;
    opened.current = true;
    const trade = TRADES_BY_ID[new URLSearchParams(window.location.search).get('trade') ?? ''];
    const { business } = state;
    const pick =
      trade && state.step === 'trade' && !business.tradeId && !business.customTrade.trim();
    if (pick)
      updateBusiness({
        tradeId: trade.id,
        customTrade: '',
        services: trade.services.slice(0, trade.preselect),
        customServices: [],
      });
    router.replace(pick ? '/start/services' : `/start/${state.step}`);
  }, [state, router, updateBusiness]);
  return <SetupLoading />;
}
