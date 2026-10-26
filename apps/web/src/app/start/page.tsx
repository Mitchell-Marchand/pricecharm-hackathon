'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { SetupLoading } from '@/components/SetupLoading';
import { useOnboarding } from '@/lib/onboarding';

/** Opens the step this setup was last on. */
export default function StartPage() {
  const router = useRouter();
  const { state } = useOnboarding();
  useEffect(() => {
    if (state) router.replace(`/start/${state.step}`);
  }, [state, router]);
  return <SetupLoading />;
}
