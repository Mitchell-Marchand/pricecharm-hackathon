'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { forgetCode, keptCode } from '@/lib/code';
import { addCode, type Billing } from '@/lib/owner';

/**
 * A link to enter a code, for owners who haven't added a card yet. A code from the link they
 * came in on goes on by itself. Once it's on, the box is gone and the plans say what it gives.
 */
export function CodeBox({
  billing,
  onChange,
}: {
  billing: Billing;
  onChange: (billing: Billing) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // The field takes the cursor when they open it, not when a link's code is being put on.
  const [typing, setTyping] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fromLink = useRef(false);

  async function apply(value: string) {
    setBusy(true);
    setError('');
    try {
      onChange(await addCode(value));
    } catch (codeError) {
      setError(errorMessage(codeError));
    } finally {
      // Tried once either way, so a bad code from a link doesn't come back on every visit.
      forgetCode();
      setBusy(false);
    }
  }

  useEffect(() => {
    if (fromLink.current) return;
    fromLink.current = true;
    const kept = keptCode();
    if (!kept) return;
    if (!billing.canAddCode) return forgetCode();
    setCode(kept);
    setOpen(true);
    void apply(kept);
    // Once, on the first billing it's shown with.
  }, []);

  if (!billing.canAddCode) return null;
  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTyping(true);
        }}
        className="self-start text-sm text-muted underline underline-offset-4 hover:text-ink"
      >
        Have a code?
      </button>
    );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (code.trim() && !busy) void apply(code);
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-1.5">
      <label htmlFor={`${id}-code`} className="text-sm font-semibold text-ink">
        Code
      </label>
      <div className="flex gap-2">
        <TextInput
          id={`${id}-code`}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={60}
          className="min-w-0 flex-1 uppercase"
          autoFocus={typing}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <Button type="submit" variant="secondary" size="lg" disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Apply'}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="text-sm text-stop" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
