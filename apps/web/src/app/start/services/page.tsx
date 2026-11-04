'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Button, Chip, TextInput } from '@/components/ui';
import { SHOW_SHOPPING_FACTS } from '@/lib/funnel-facts';
import { useOnboarding, type BusinessDraft } from '@/lib/onboarding';
import { preparePractice } from '@/lib/practice';
import { TRADES_BY_ID } from '@/lib/trades';

export default function ServicesStep() {
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  return <ServicesForm business={state.business} />;
}

/** Which services they offer: the usual ones for their trade are already on. */
function ServicesForm({ business }: { business: BusinessDraft }) {
  const { updateBusiness, goTo, flush } = useOnboarding();
  const [newService, setNewService] = useState('');
  const [tried, setTried] = useState(false);
  const trade = business.tradeId ? TRADES_BY_ID[business.tradeId] : null;
  const options = [
    ...(trade?.services ?? []),
    ...business.customServices.filter((name) => !trade?.services.includes(name)),
  ];
  const none = business.services.length === 0;

  const addService = () => {
    const name = newService.trim();
    setNewService('');
    if (!name || business.services.some((item) => item.toLowerCase() === name.toLowerCase()))
      return;
    updateBusiness({
      services: [...business.services, name],
      customServices: [...business.customServices, name],
    });
  };
  const toggle = (name: string) =>
    updateBusiness({
      services: business.services.includes(name)
        ? business.services.filter((item) => item !== name)
        : [...business.services, name],
    });

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="services" />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-8 pb-16 sm:pt-14">
        <h1 className="t-h1">Which of these do you offer?</h1>
        <p className="mt-3 text-lg text-ink-2">
          {trade
            ? 'We turned on the usual ones. Tap to change them.'
            : 'Add the services you quote for.'}
        </p>
        <div className="mt-7 flex flex-wrap gap-2">
          {options.map((name) => (
            <Chip
              key={name}
              selected={business.services.includes(name)}
              onClick={() => toggle(name)}
            >
              {name}
            </Chip>
          ))}
        </div>
        {tried && none && (
          <p className="mt-3 text-sm text-stop" data-field-error="Services">
            Turn on at least one service.
          </p>
        )}
        <form
          className="mt-4 flex max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addService();
          }}
        >
          <label htmlFor="new-service" className="sr-only">
            Add a service
          </label>
          <TextInput
            id="new-service"
            className="h-11"
            placeholder="Add a service"
            maxLength={60}
            value={newService}
            onChange={(event) => setNewService(event.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!newService.trim()} className="h-11">
            <Plus aria-hidden /> Add
          </Button>
        </form>
      </main>
      <BottomBar
        onBack={() => void goTo('trade')}
        onNext={() => {
          if (none) return setTried(true);
          // A typed-in trade has no customer made ahead, so its first is written while they finish
          // setup. It's made from what's saved, so saving comes first.
          void goTo('about', SHOW_SHOPPING_FACTS ? '/start/why' : undefined).then(async () => {
            if (!business.tradeId && (await flush())) void preparePractice(true).catch(() => {});
          });
        }}
        blocked={none}
        hint="Turn on at least one service."
      />
    </div>
  );
}
