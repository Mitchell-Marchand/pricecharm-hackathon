'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { MessageSquareText, Pencil, Plus, Receipt, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Button, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  addNote,
  addQuestion,
  editNote,
  editQuestion,
  removeNote,
  removeQuestion,
  type Knows,
  type ServiceRate,
} from '@/lib/knows';

type Row = { id: string; text: string; locked?: boolean; note?: string };

/** One line being written: a new one, or a change to an existing one. */
function LineForm({
  id,
  label,
  initial,
  placeholder,
  maxLength,
  onSave,
  onCancel,
}: {
  id: string;
  label: string;
  initial: string;
  placeholder?: string;
  maxLength: number;
  onSave: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    const saved = await onSave(value.trim());
    setSaving(false);
    if (saved) onCancel();
  };
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={submit}
      onKeyDown={(event) => event.key === 'Escape' && onCancel()}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <TextInput
        id={id}
        autoFocus
        className="h-11"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex shrink-0 gap-2">
        <Button type="submit" size="sm" className="h-11" disabled={saving || !value.trim()}>
          Save
        </Button>
        <Button variant="ghost" size="sm" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Lines the owner can change, remove and add to, saved one at a time. */
function EditableList({
  name,
  rows,
  noun,
  placeholder,
  maxLength,
  removed,
  onAdd,
  onEdit,
  onRemove,
}: {
  name: string;
  rows: Row[];
  noun: 'question' | 'note';
  placeholder: string;
  maxLength: number;
  /** What the toast says once one is gone. */
  removed: string;
  onAdd: (text: string) => Promise<Knows>;
  onEdit: (id: string, text: string) => Promise<Knows>;
  onRemove: (id: string) => Promise<Knows>;
}) {
  const notify = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const run = async (request: () => Promise<Knows>, done?: string) => {
    try {
      await request();
      if (done) notify(done);
      return true;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    }
  };
  return (
    <>
      {rows.length > 0 && (
        <ul aria-label={name} className="mt-5 divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <li key={row.id} className="py-3">
              {editing === row.id ? (
                <LineForm
                  id={`${noun}-${row.id}`}
                  label={`Change this ${noun}`}
                  initial={row.text}
                  maxLength={maxLength}
                  onSave={(text) => run(() => onEdit(row.id, text))}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 text-[15px] leading-snug">
                    {row.text}
                    {row.note && (
                      <span className="mt-0.5 block text-sm text-muted">{row.note}</span>
                    )}
                  </p>
                  {!row.locked && (
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setEditing(row.id)}
                        className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent"
                        aria-label={`Change “${row.text}”`}
                      >
                        <Pencil className="size-3.5" aria-hidden /> Change
                      </button>
                      <button
                        type="button"
                        onClick={() => void run(() => onRemove(row.id), removed)}
                        className="inline-flex size-7 items-center justify-center rounded-xs text-muted hover:bg-surface-2 hover:text-stop"
                        aria-label={`Remove “${row.text}”`}
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        {editing === 'new' ? (
          <LineForm
            id={`${noun}-new`}
            label={`New ${noun}`}
            initial=""
            placeholder={placeholder}
            maxLength={maxLength}
            onSave={(text) => run(() => onAdd(text))}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-4" aria-hidden /> Add a {noun}
          </Button>
        )}
      </div>
    </>
  );
}

/** "About $25 per window, lowest $100", with what it comes from, or that it has no rate yet. */
function RateLine({ rate }: { rate: ServiceRate }) {
  return (
    <>
      <p className="font-medium text-ink">{rate.service}</p>
      {rate.price ? (
        <>
          <p className="mt-0.5 text-[15px]">{rate.price}</p>
          <p className="mt-0.5 text-sm text-muted">{rate.basis}.</p>
        </>
      ) : (
        <p className="mt-0.5 text-sm text-muted">
          No rate yet. Add past jobs with their size and it works one out.
        </p>
      )}
    </>
  );
}

/** Everything the Charm knows, for the owner to change. Each change is saved as it's made. */
export function KnowsEditor({
  knows,
  onChange,
}: {
  knows: Knows;
  onChange: (knows: Knows) => void;
}) {
  // Each request comes back with the whole picture, which goes straight on screen.
  const saved = (request: Promise<Knows>) =>
    request.then((next) => {
      onChange(next);
      return next;
    });
  return (
    <div className="flex max-w-[680px] flex-col gap-14">
      <section aria-labelledby="questions-title">
        <h2 id="questions-title" className="t-h2">
          Questions it asks
        </h2>
        <p className="mt-2 text-ink-2">
          In this order. It skips any the customer already answered or the photos show.
        </p>
        <EditableList
          name="Questions it asks"
          noun="question"
          placeholder="Any pets or a locked gate?"
          maxLength={160}
          removed="Removed. It won’t ask that anymore."
          rows={knows.questions.map((question) => ({
            id: question.id,
            text: question.text,
            locked: question.source === 'photos',
            note:
              question.source === 'photos'
                ? 'Always first. Customers can skip it.'
                : question.source === 'practice'
                  ? 'From your practice customers'
                  : undefined,
          }))}
          onAdd={(text) => saved(addQuestion(text))}
          onEdit={(id, text) => saved(editQuestion(id, text))}
          onRemove={(id) => saved(removeQuestion(id))}
        />
      </section>

      <section aria-labelledby="rates-title">
        <h2 id="rates-title" className="t-h2">
          How it prices
        </h2>
        <p className="mt-2 text-ink-2">
          Each service’s rate comes from what you charged. To change one, add or edit{' '}
          <Link href="/app/train#jobs-title" className="text-accent underline underline-offset-2">
            past jobs
          </Link>
          .
        </p>
        <ul aria-label="Your rates" className="mt-5 divide-y divide-line border-y border-line">
          {knows.rates.map((rate) => (
            <li key={rate.service} className="py-3">
              <RateLine rate={rate} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="notes-title">
        <h2 id="notes-title" className="t-h2">
          Notes on your prices
        </h2>
        <p className="mt-2 text-ink-2">
          Anything your past jobs don’t show, in your own words, like “$150 minimum” or “Second
          story is 20% more”. Every quote it drafts follows these.
        </p>
        <EditableList
          name="Notes on your prices"
          noun="note"
          placeholder="$150 minimum for any job"
          maxLength={200}
          removed="Removed. Quotes won’t follow it anymore."
          rows={knows.notes.map((note) => ({
            id: note.id,
            text: note.text,
            note: note.source === 'practice' ? 'Your correction after practice' : undefined,
          }))}
          onAdd={(text) => saved(addNote(text))}
          onEdit={(id, text) => saved(editNote(id, text))}
          onRemove={(id) => saved(removeNote(id))}
        />
      </section>
    </div>
  );
}

/** The same, to read: what it asks and how it prices, at the end of setup. */
export function KnowsSummary({ knows, className }: { knows: Knows; className?: string }) {
  return (
    <div className={className}>
      <div className="grid gap-10 md:grid-cols-2 md:gap-8">
        <section>
          <h2 className="t-h3 flex items-center gap-2">
            <MessageSquareText className="size-5 text-accent" aria-hidden /> It will ask
          </h2>
          <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
            {knows.questions.map((question) => (
              <li key={question.id}>{question.text}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="t-h3 flex items-center gap-2">
            <Receipt className="size-5 text-accent" aria-hidden /> How it prices
          </h2>
          <ul className="mt-4 flex flex-col gap-4 text-ink-2">
            {knows.rates.map((rate) => (
              <li key={rate.service}>
                <RateLine rate={rate} />
              </li>
            ))}
            {/* Corrections are on each practice result. Here, only what the owner wrote. */}
            {knows.notes
              .filter((note) => note.source === 'owner')
              .map((note) => (
                <li key={note.id}>{note.text}</li>
              ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
