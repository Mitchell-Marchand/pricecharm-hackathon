'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { TurnDownSheet, type TurnDownTarget } from '@/components/practice/TurnDownSheet';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { loadTurnDowns, removeTurnDown, saveMinimum, type TurnDowns } from '@/lib/turn-downs';
import { money } from '@/lib/util';

/**
 * "Jobs you turn down": each rule the customer chat follows, in the same words it reads them,
 * and the least the owner charges. In What it knows and in Settings, each one changes or goes.
 */
export function TurnDownList({ intro = true }: { intro?: boolean }) {
  const notify = useToast();
  const [view, setView] = useState<TurnDowns | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<TurnDownTarget | null>(null);

  useEffect(() => {
    loadTurnDowns()
      .then(setView)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);

  const run = async (request: () => Promise<TurnDowns>, done: string) => {
    try {
      setView(await request());
      notify(done);
    } catch (removeError) {
      notify(errorMessage(removeError));
    }
  };

  if (error)
    return (
      <p className="mt-4 text-sm text-stop" role="alert">
        {error}
      </p>
    );
  if (!view) return <div className="shimmer mt-5 h-20 rounded-md" aria-busy="true" />;
  const rows = [
    ...view.rules.map((rule) => ({
      id: rule.id,
      text: rule.line,
      note: rule.reason,
      edit: { mode: 'edit', rule } as TurnDownTarget,
      remove: () =>
        run(() => removeTurnDown(rule.id), 'Removed. Your Charm won’t turn these down.'),
    })),
    ...(view.minimumCents
      ? [
          {
            id: 'minimum',
            text: `Charges at least ${money(view.minimumCents)} for any job`,
            note: 'Smaller jobs get quoted at this',
            edit: { mode: 'minimum', minimumCents: view.minimumCents } as TurnDownTarget,
            remove: () => run(() => saveMinimum(null), 'Removed. Quotes can go under it now.'),
          },
        ]
      : []),
  ];
  return (
    <>
      {intro && (
        <p className="mt-2 text-ink-2">
          Your Charm says no to these in the customer chat, kindly. They never get a quote, so
          you’re never billed for them.
        </p>
      )}
      {rows.length > 0 ? (
        <ul
          aria-label="Jobs you turn down"
          className="mt-5 divide-y divide-line border-y border-line"
        >
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-4 py-3">
              <p className="min-w-0 text-[15px] leading-snug">
                {row.text}
                <span className="mt-0.5 block text-sm text-muted">{row.note}</span>
              </p>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setTarget(row.edit)}
                  className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent"
                  aria-label={`Change “${row.text}”`}
                >
                  <Pencil className="size-3.5" aria-hidden /> Change
                </button>
                <button
                  type="button"
                  onClick={() => void row.remove()}
                  className="inline-flex size-7 items-center justify-center rounded-xs text-muted hover:bg-surface-2 hover:text-stop"
                  aria-label={`Remove “${row.text}”`}
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">
          None yet. Until you add one, it quotes every job, however far away.
        </p>
      )}
      <div className="mt-4">
        <Button variant="secondary" size="sm" onClick={() => setTarget({ mode: 'add' })}>
          <Plus className="size-4" aria-hidden /> Add one
        </Button>
      </div>
      <TurnDownSheet
        target={target}
        onClose={() => setTarget(null)}
        onSaved={(next) => {
          setView(next);
          setTarget(null);
          notify('Saved. Your Charm follows it from now on.');
        }}
      />
    </>
  );
}
