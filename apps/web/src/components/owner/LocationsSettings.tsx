'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Button, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { loadLocations, saveLocations } from '@/lib/turn-downs';

const MAX_LOCATIONS = 5;

/**
 * Where the owner works from, main one first: a city, neighborhood or ZIP code each. A "too far"
 * turn-down is measured from the nearest of them.
 */
export function LocationsSettings() {
  const notify = useToast();
  const [areas, setAreas] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadLocations()
      .then(({ areas: loaded }) => {
        setSaved(loaded);
        setAreas(loaded.length ? loaded : ['']);
      })
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);

  if (!areas)
    return error ? (
      <p className="text-sm text-stop" role="alert">
        {error}
      </p>
    ) : (
      <div className="shimmer h-24 rounded-md" aria-busy="true" />
    );

  const typed = areas.map((area) => area.trim()).filter(Boolean);
  const changed = typed.join('\n') !== saved.join('\n');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!typed.length) return setError('Add where you work.');
    setSaving(true);
    setError('');
    try {
      const next = await saveLocations(typed);
      setSaved(next.areas);
      setAreas(next.areas);
      notify('Saved where you work.');
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="flex max-w-md flex-col gap-2">
      {areas.map((area, index) => (
        <div key={index} className="flex items-center gap-2">
          <label htmlFor={`location-${index}`} className="sr-only">
            {index === 0 ? 'Main location' : `Location ${index + 1}`}
          </label>
          <TextInput
            id={`location-${index}`}
            maxLength={120}
            value={area}
            placeholder={index === 0 ? 'Austin, TX' : 'Another city or ZIP code'}
            onChange={(event) =>
              setAreas(areas.map((item, at) => (at === index ? event.target.value : item)))
            }
          />
          {areas.length > 1 && (
            <button
              type="button"
              onClick={() => setAreas(areas.filter((_, at) => at !== index))}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-stop"
              aria-label={`Remove ${area.trim() || 'this location'}`}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      ))}
      <p className="text-sm text-muted">The first is your main one.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {areas.length < MAX_LOCATIONS && (
          <Button variant="ghost" size="sm" onClick={() => setAreas([...areas, ''])}>
            <Plus className="size-4" aria-hidden /> Add another location
          </Button>
        )}
        <Button type="submit" size="sm" disabled={saving || !changed}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-stop" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
