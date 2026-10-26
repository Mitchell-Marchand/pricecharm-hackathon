import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import { BottomBar, WizardHeader } from '../components/Wizard';
import { Button, Chip, Field, TextInput } from '../components/ui';
import { TRADES, TRADES_BY_ID } from '../data/trades';
import { useStore } from '../lib/store';
import { cx, prefersReducedMotion } from '../lib/util';

export function Business() {
  const { state, dispatch } = useStore();
  const business = state.business;
  const trade = business.tradeId ? TRADES_BY_ID[business.tradeId] : null;
  const [query, setQuery] = useState('');
  const [otherOpen, setOtherOpen] = useState(Boolean(business.customTrade));
  const [newService, setNewService] = useState('');
  const details = useRef<HTMLDivElement>(null);
  const chosen = Boolean(trade || business.customTrade.trim());
  const firstChoice = useRef(!chosen);

  useEffect(() => {
    if (chosen && firstChoice.current) {
      firstChoice.current = false;
      window.setTimeout(
        () => details.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }),
        80,
      );
    }
  }, [chosen]);

  const matches = TRADES.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const serviceOptions = [
    ...(trade?.services ?? []),
    ...business.customServices.filter((name) => !trade?.services.includes(name)),
  ];
  const canContinue = chosen && business.services.length > 0 && business.name.trim().length > 1;
  const hint = !chosen
    ? 'Pick your trade to continue.'
    : business.services.length === 0
      ? 'Choose at least one service.'
      : 'Add your business name to continue.';

  const addService = () => {
    dispatch({ type: 'addService', name: newService });
    setNewService('');
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={1} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">What kind of business do you run?</h1>
        <p className="mt-3 text-lg text-ink-2">Pick the closest match. You'll choose your services next.</p>

        <div className="relative mt-8">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="trade-search" className="sr-only">
            Search trades
          </label>
          <TextInput
            id="trade-search"
            className="pl-11"
            placeholder="Search trades"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div role="radiogroup" aria-label="Trades" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {matches.map((item) => {
            const selected = business.tradeId === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  dispatch({ type: 'pickTrade', tradeId: item.id });
                  dispatch({ type: 'business', patch: { customTrade: '' } });
                  setOtherOpen(false);
                }}
                className={cx(
                  'relative flex min-h-[72px] items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-[border-color,background-color] duration-150 sm:px-4',
                  selected
                    ? 'border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]'
                    : 'border-line bg-surface hover:border-line-strong',
                )}
              >
                <Icon className={cx('size-6 shrink-0', selected ? 'text-accent' : 'text-ink-2')} aria-hidden />
                <span className="text-[15px] leading-tight font-semibold">{item.name}</span>
                {selected && (
                  <span className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
                    <Check className="size-3.5" aria-hidden />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {matches.length === 0 && (
          <p className="mt-4 text-ink-2">No trade matches “{query}”. Type yours in below.</p>
        )}

        <div className="mt-5">
          {otherOpen || matches.length === 0 ? (
            <Field label="Something else? Type your trade" htmlFor="custom-trade">
              <TextInput
                id="custom-trade"
                placeholder="For example: Holiday lighting"
                value={business.customTrade}
                onChange={(event) => {
                  if (business.tradeId) dispatch({ type: 'pickTrade', tradeId: null });
                  dispatch({ type: 'business', patch: { customTrade: event.target.value } });
                }}
              />
            </Field>
          ) : (
            <Button variant="link" onClick={() => setOtherOpen(true)}>
              Something else? Type it in
            </Button>
          )}
        </div>

        {chosen && (
          <div ref={details} className="fade-up mt-12 flex scroll-mt-28 flex-col gap-10 border-t border-line pt-10">
            <section aria-labelledby="services-title">
              <h2 id="services-title" className="t-h2">
                Which of these do you offer?
              </h2>
              <p className="mt-2 text-ink-2">
                {trade ? 'We picked the usual ones. Tap to turn them on or off.' : 'Add the services you quote for.'}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {serviceOptions.map((name) => (
                  <Chip
                    key={name}
                    selected={business.services.includes(name)}
                    onClick={() => dispatch({ type: 'toggleService', name })}
                  >
                    {name}
                  </Chip>
                ))}
              </div>
              <form
                className="mt-3 flex max-w-sm gap-2"
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
                  className="h-10"
                  placeholder="Add a service"
                  value={newService}
                  onChange={(event) => setNewService(event.target.value)}
                />
                <Button type="submit" variant="secondary" disabled={!newService.trim()} className="h-10">
                  <Plus aria-hidden /> Add
                </Button>
              </form>
            </section>

            <section aria-labelledby="about-title" className="flex flex-col gap-5">
              <h2 id="about-title" className="t-h2">
                About your business
              </h2>
              <Field label="Business name" htmlFor="business-name" hint="Customers see this on every quote.">
                <TextInput
                  id="business-name"
                  autoComplete="organization"
                  placeholder="Moss & Stone Exterior Care"
                  value={business.name}
                  onChange={(event) => dispatch({ type: 'business', patch: { name: event.target.value } })}
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_170px]">
                <Field label="Where do you work?" htmlFor="business-area" optional>
                  <TextInput
                    id="business-area"
                    autoComplete="address-level2"
                    placeholder="City or ZIP code"
                    value={business.area}
                    onChange={(event) => dispatch({ type: 'business', patch: { area: event.target.value } })}
                  />
                </Field>
                <Field label="How far you'll travel" htmlFor="business-radius">
                  <select
                    id="business-radius"
                    value={business.radius}
                    onChange={(event) => dispatch({ type: 'business', patch: { radius: event.target.value } })}
                    className="h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
                  >
                    {['10', '15', '25', '50'].map((miles) => (
                      <option key={miles} value={miles}>
                        {miles} miles
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </section>
          </div>
        )}
      </main>
      <BottomBar
        onBack={() => dispatch({ type: 'go', screen: 'landing' })}
        onNext={() => dispatch({ type: 'go', screen: 'jobs' })}
        disabled={!canContinue}
        hint={hint}
      />
    </div>
  );
}
