'use client';

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Button, TextInput } from '@/components/ui';
import { api, errorMessage, json } from '@/lib/api';
import type { Onboarding } from '@/lib/onboarding';

/** Places a business can work from, as the API allows. */
const MAX_LOCATIONS = 5;

/**
 * Where the business works from, main one first. The Charm checks a customer's area against these,
 * and practice customers live near them.
 */
export function LocationSettings() {
  const notify = useToast();
  const [places, setPlaces] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Onboarding>('/onboarding')
      .then(({ business }) => {
        const found = business.locations ?? (business.area ? [business.area] : []);
        setSaved(found);
        setPlaces(found.length ? found : ['']);
      })
      .catch(() => setPlaces(['']));
  }, []);

  if (!places) return <div className="shimmer h-24 rounded-md" />;
  const filled = places.map((place) => place.trim()).filter(Boolean);
  const changed = JSON.stringify(filled) !== JSON.stringify(saved);

  async function save() {
    const unique = [...new Map(filled.map((place) => [place.toLowerCase(), place])).values()];
    setSaving(true);
    try {
      const state = await api<Onboarding>('/onboarding/business', {
        method: 'PATCH',
        ...json({ locations: unique }),
      });
      const now = state.business.locations ?? unique;
      setSaved(now);
      setPlaces(now.length ? now : ['']);
      notify('Saved.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex max-w-md flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !saving) void save();
      }}
    >
      {places.map((place, index) => (
        <div key={index} className="flex items-center gap-2">
          <label htmlFor={`settings-place-${index}`} className="sr-only">
            {index ? `Location ${index + 1}` : 'Main location'}
          </label>
          <TextInput
            id={`settings-place-${index}`}
            placeholder={index ? 'Another city or ZIP' : 'City, neighborhood or ZIP code'}
            maxLength={120}
            value={place}
            onChange={(event) =>
              setPlaces(places.map((item, at) => (at === index ? event.target.value : item)))
            }
          />
          {places.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${place.trim() || 'this location'}`}
              onClick={() => setPlaces(places.filter((_, at) => at !== index))}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-5" aria-hidden />
            </button>
          )}
        </div>
      ))}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {places.length < MAX_LOCATIONS && (
          <Button type="button" variant="link" onClick={() => setPlaces([...places, ''])}>
            <Plus aria-hidden /> Add another location
          </Button>
        )}
        <Button type="submit" variant="secondary" disabled={!changed || saving} className="ml-auto">
          {saving ? 'Saving…' : 'Save locations'}
        </Button>
      </div>
    </form>
  );
}
