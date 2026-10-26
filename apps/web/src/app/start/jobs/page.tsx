'use client';

import { BottomBar, WizardHeader } from '@/components/Wizard';
import { useOnboarding } from '@/lib/onboarding';

// Step 2 is built next. This placeholder keeps step 1's Continue button working meanwhile.
export default function JobsStep() {
  const { goTo } = useOnboarding();
  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={2} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">Add a few jobs you’ve done</h1>
      </main>
      <BottomBar
        onBack={() => void goTo('business')}
        onNext={() => {}}
        disabled
        hint="Coming next."
      />
    </div>
  );
}
