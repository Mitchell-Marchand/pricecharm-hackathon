'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { SetupLoading } from '@/components/SetupLoading';
import { BottomBar, WizardHeader } from '@/components/Wizard';
import { Button, Field, SelectInput, TextInput } from '@/components/ui';
import { CURRENCIES, currencyName, currencySymbol, type Currency } from '@/lib/currency';
import { pixelEvent } from '@/lib/meta-pixel';
import { useOnboarding, type BusinessDraft } from '@/lib/onboarding';
import { preparePractice } from '@/lib/practice';
import { prefersReducedMotion } from '@/lib/util';

/** Places a business can work from, as the API allows. */
const MAX_LOCATIONS = 5;

export default function AboutStep() {
  const { state } = useOnboarding();
  if (!state) return <SetupLoading />;
  return <AboutForm business={state.business} />;
}

/** The business's name, where it works from, and what its quotes are in. */
function AboutForm({ business }: { business: BusinessDraft }) {
  const router = useRouter();
  const { updateBusiness, goTo, flush } = useOnboarding();
  const [tried, setTried] = useState(false);
  const [moving, setMoving] = useState(false);
  const [changingCurrency, setChangingCurrency] = useState(false);
  // Typed rows, blank ones included, so "Add another location" shows a field to fill in.
  const [places, setPlaces] = useState<string[]>(() => {
    const saved = business.locations ?? (business.area ? [business.area] : []);
    return saved.length ? saved : [''];
  });
  const nameInput = useRef<HTMLInputElement>(null);
  const placeInput = useRef<HTMLInputElement>(null);
  const currency = business.currency ?? 'USD';
  const named = business.name.trim().length > 1;
  const filled = places.map((place) => place.trim()).filter(Boolean);
  const placed = filled.length > 0;

  const savePlaces = (next: string[]) => {
    setPlaces(next);
    const unique = [
      ...new Map(
        next
          .map((place) => place.trim())
          .filter(Boolean)
          .map((place) => [place.toLowerCase(), place]),
      ).values(),
    ];
    updateBusiness({ locations: unique, area: unique[0] ?? '' });
  };

  const show = (input: HTMLInputElement | null) => {
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
  };
  const next = async () => {
    if (!named || !placed) {
      setTried(true);
      return show(named ? placeInput.current : nameInput.current);
    }
    setMoving(true);
    // Saved first, so the first practice customer is written for this business, while they read
    // what's coming.
    const saved = await flush();
    setMoving(false);
    if (!saved) return;
    pixelEvent('Lead');
    void preparePractice().catch(() => {});
    void goTo('practice', '/start/training');
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader screen="about" />
      <main className="gutter mx-auto w-full max-w-[560px] flex-1 pt-8 pb-16 sm:pt-14">
        <h1 className="t-h1">About your business</h1>
        <p className="mt-3 text-lg text-ink-2">Customers see this on every quote.</p>

        <form
          className="mt-8 flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void next();
          }}
        >
          <Field
            label="Business name"
            htmlFor="business-name"
            error={tried && !named ? 'Add your business name.' : undefined}
          >
            <TextInput
              ref={nameInput}
              id="business-name"
              autoComplete="organization"
              placeholder="Moss & Stone Exterior Care"
              maxLength={120}
              aria-invalid={tried && !named}
              value={business.name}
              onChange={(event) => updateBusiness({ name: event.target.value })}
            />
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-semibold text-ink">Where do you work?</legend>
            {places.map((place, index) => (
              <div key={index} className="flex items-center gap-2">
                <label htmlFor={`business-place-${index}`} className="sr-only">
                  {index ? `Location ${index + 1}` : 'Main location'}
                </label>
                <TextInput
                  ref={index === 0 ? placeInput : undefined}
                  id={`business-place-${index}`}
                  autoComplete={index ? 'off' : 'address-level2'}
                  placeholder={index ? 'Another city or ZIP' : 'City, neighborhood or ZIP code'}
                  maxLength={120}
                  aria-invalid={tried && !placed && index === 0}
                  autoFocus={index > 0 && !place}
                  value={place}
                  onChange={(event) =>
                    savePlaces(places.map((item, at) => (at === index ? event.target.value : item)))
                  }
                />
                {places.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove ${place.trim() || 'this location'}`}
                    onClick={() => savePlaces(places.filter((_, at) => at !== index))}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-ink"
                  >
                    <X className="size-5" aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {tried && !placed && (
              <p className="text-sm text-stop" data-field-error="Location">
                Add where you work, so customers outside it know.
              </p>
            )}
            {places.length < MAX_LOCATIONS && (
              <Button
                type="button"
                variant="link"
                className="self-start"
                onClick={() => setPlaces([...places, ''])}
              >
                <Plus aria-hidden /> Add another location
              </Button>
            )}
          </fieldset>

          {changingCurrency ? (
            <Field
              label="Currency"
              htmlFor="business-currency"
              hint="Your quotes and your PriceCharm plan are in it."
            >
              <SelectInput
                id="business-currency"
                value={currency}
                onChange={(event) => updateBusiness({ currency: event.target.value as Currency })}
                className="sm:max-w-xs"
              >
                {CURRENCIES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name} ({currencySymbol(item.code)})
                  </option>
                ))}
              </SelectInput>
            </Field>
          ) : (
            <p className="text-[15px] text-ink-2">
              Currency: {currencyName(currency)} ({currencySymbol(currency)}).{' '}
              <button
                type="button"
                onClick={() => setChangingCurrency(true)}
                className="font-semibold text-accent underline underline-offset-4"
              >
                Change
              </button>
            </p>
          )}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </main>
      <BottomBar
        onBack={() => router.push('/start/why')}
        onNext={() => void next()}
        nextLabel={moving ? 'Saving…' : 'Continue'}
        blocked={!named || !placed}
        hint={!named ? 'Add your business name to continue.' : 'Add where you work to continue.'}
      />
    </div>
  );
}
