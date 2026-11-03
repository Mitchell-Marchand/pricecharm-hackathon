'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Briefcase, Check, Plus, Search, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Button, Chip, Field, TextInput } from '@/components/ui';
import { useOnboarding, type BusinessDraft } from '@/lib/onboarding';
import { TRADES, TRADES_BY_ID } from '@/lib/trades';
import { CURRENCIES, currencySymbol, type Currency } from '@/lib/currency';
import { cx, prefersReducedMotion } from '@/lib/util';

const selectClass =
  'h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none';

/** Scrolls to a part of the page once it's there, as the services are right after a first pick. */
function scrollSoon(target: RefObject<HTMLElement | null>, block: ScrollLogicalPosition = 'start') {
  window.setTimeout(
    () =>
      target.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block,
      }),
    80,
  );
}

export default function BusinessStep() {
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  return <BusinessForm business={state.business} />;
}

function BusinessForm({ business }: { business: BusinessDraft }) {
  const router = useRouter();
  const { updateBusiness, goTo } = useOnboarding();
  const trade = business.tradeId ? TRADES_BY_ID[business.tradeId] : null;
  const [query, setQuery] = useState('');
  const [newService, setNewService] = useState('');
  const [tried, setTried] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const servicesSection = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const customTrade = business.customTrade.trim();
  const chosen = Boolean(trade || customTrade);

  // Arriving with a trade picked on a demo (/start/business#services) opens on the services. The
  // address is read once the page is up, when it has the #.
  useEffect(() => {
    window.setTimeout(() => {
      if (window.location.hash === '#services')
        details.current?.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start',
        });
    }, 80);
  }, []);

  const typed = query.trim();
  const matchesQuery = (name: string) => name.toLowerCase().includes(typed.toLowerCase());
  const matches = TRADES.filter((item) => matchesQuery(item.name));
  // A trade they typed in sits first, like the listed ones. When nothing fits the search, the
  // search itself becomes the choice.
  const showCustom = Boolean(customTrade) && matchesQuery(customTrade);
  const offerTyped = Boolean(typed) && !matches.length && !showCustom;
  const serviceOptions = [
    ...(trade?.services ?? []),
    ...business.customServices.filter((name) => !trade?.services.includes(name)),
  ];
  const named = business.name.trim().length > 1;
  const canContinue = chosen && business.services.length > 0 && named;
  const hint = !chosen
    ? 'Pick your trade to continue.'
    : business.services.length === 0
      ? 'Choose at least one service.'
      : 'Add your business name to continue.';

  // Continue always answers: it moves on, or it takes them to what's missing and says so.
  const next = () => {
    if (canContinue) return void goTo('jobs');
    setTried(true);
    if (!chosen) scrollSoon(search, 'center');
    else if (!business.services.length) scrollSoon(servicesSection);
    else {
      scrollSoon(nameInput, 'center');
      nameInput.current?.focus({ preventScroll: true });
    }
  };

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
  // Picking a trade moves on to the services. Tapping the one already picked, as when coming back
  // to setup, goes there too and keeps the services they chose.
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
    scrollSoon(details);
  };
  // Their trade's own name starts as its first service, so there's something to switch on.
  const pickCustomTrade = (name: string) => {
    const service = name.slice(0, 60).trim();
    updateBusiness({
      tradeId: null,
      customTrade: name,
      services: [service],
      customServices: [service],
    });
    scrollSoon(details);
  };
  const toggleService = (name: string) =>
    updateBusiness({
      services: business.services.includes(name)
        ? business.services.filter((item) => item !== name)
        : [...business.services, name],
    });

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={1} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">What kind of business do you run?</h1>
        <p className="mt-3 text-lg text-ink-2">
          Pick the closest match. You'll choose your services next.
        </p>

        <div className="relative mt-8">
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
            <TradeCard icon={Briefcase} selected onClick={() => scrollSoon(details)}>
              {customTrade}
            </TradeCard>
          )}
          {offerTyped && (
            <TradeCard
              icon={Plus}
              selected={false}
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
          <Button
            variant="link"
            className="mt-4"
            onClick={() => {
              search.current?.focus();
              search.current?.scrollIntoView({
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                block: 'center',
              });
            }}
          >
            Don’t see yours? Type it in the search.
          </Button>
        )}

        {chosen && (
          <div
            ref={details}
            className="fade-up mt-12 flex scroll-mt-28 flex-col gap-10 border-t border-line pt-10"
          >
            <section
              ref={servicesSection}
              aria-labelledby="services-title"
              className="scroll-mt-28"
            >
              <h2 id="services-title" className="t-h2">
                Which of these do you offer?
              </h2>
              <p className="mt-2 text-ink-2">
                {trade
                  ? 'We picked the usual ones. Tap to turn them on or off.'
                  : 'Add the services you quote for.'}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {serviceOptions.map((name) => (
                  <Chip
                    key={name}
                    selected={business.services.includes(name)}
                    onClick={() => toggleService(name)}
                  >
                    {name}
                  </Chip>
                ))}
              </div>
              {tried && !business.services.length && (
                <p className="mt-3 text-sm text-stop" data-field-error="Services">
                  Turn on at least one service.
                </p>
              )}
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
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!newService.trim()}
                  className="h-10"
                >
                  <Plus aria-hidden /> Add
                </Button>
              </form>
            </section>

            <section aria-labelledby="about-title" className="flex flex-col gap-5">
              <h2 id="about-title" className="t-h2">
                About your business
              </h2>
              <Field
                label="Business name"
                htmlFor="business-name"
                hint="Customers see this on every quote."
                error={tried && !named ? 'Add your business name.' : undefined}
              >
                <TextInput
                  ref={nameInput}
                  id="business-name"
                  aria-invalid={tried && !named}
                  autoComplete="organization"
                  placeholder="Moss & Stone Exterior Care"
                  value={business.name}
                  onChange={(event) => updateBusiness({ name: event.target.value })}
                />
              </Field>
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_170px]">
                <Field label="Where do you work?" htmlFor="business-area" optional>
                  <TextInput
                    id="business-area"
                    autoComplete="address-level2"
                    placeholder="City or ZIP code"
                    value={business.area}
                    onChange={(event) => updateBusiness({ area: event.target.value })}
                  />
                </Field>
                <Field label="How far you'll travel" htmlFor="business-radius">
                  <select
                    id="business-radius"
                    value={business.radius}
                    onChange={(event) => updateBusiness({ radius: event.target.value })}
                    className={selectClass}
                  >
                    {['10', '15', '25', '50'].map((miles) => (
                      <option key={miles} value={miles}>
                        {miles} miles
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="Currency"
                htmlFor="business-currency"
                hint="Your quotes and your PriceCharm plan are in it."
              >
                <select
                  id="business-currency"
                  value={business.currency ?? 'USD'}
                  onChange={(event) => updateBusiness({ currency: event.target.value as Currency })}
                  className={cx(selectClass, 'sm:max-w-xs')}
                >
                  {CURRENCIES.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name} ({currencySymbol(item.code)})
                    </option>
                  ))}
                </select>
              </Field>
            </section>
          </div>
        )}
      </main>
      <BottomBar onBack={() => router.push('/')} onNext={next} blocked={!canContinue} hint={hint} />
    </div>
  );
}

function TradeCard({
  icon: Icon,
  selected,
  onClick,
  className,
  children,
}: {
  icon: LucideIcon;
  selected: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'relative flex min-h-[72px] min-w-0 items-center gap-2.5 rounded-md border px-3 py-3 text-left transition-[border-color,background-color] duration-150 sm:gap-3 sm:px-4',
        selected
          ? 'border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]'
          : 'border-line bg-surface hover:border-line-strong',
        className,
      )}
    >
      <Icon
        className={cx('size-6 shrink-0', selected ? 'text-accent' : 'text-ink-2')}
        aria-hidden
      />
      {/* Whole words on a phone: "Landscaping" fits a card 360px wide. Narrower ones hyphenate. */}
      <span className="min-w-0 pr-3 text-[15px] leading-tight font-semibold break-words hyphens-auto max-[379px]:text-[14px]">
        {children}
      </span>
      {selected && (
        <span className="absolute top-1.5 right-1.5 inline-flex size-4 items-center justify-center rounded-full bg-accent text-on-accent">
          <Check className="size-3" aria-hidden />
        </span>
      )}
    </button>
  );
}
