'use client';

import { useState } from 'react';
import { Lock, Plus, Send, Trash2 } from 'lucide-react';
import { Sheet } from '@/components/Sheet';
import { Button, Field, MoneyInput, Segmented, TextArea, TextInput } from '@/components/ui';
import type { QuoteDraft } from '@/lib/practice';
import type { Discount } from '@/lib/quote';
import { money, moneyInput, parseMoney, uid } from '@/lib/util';

/** The practice customer the quote is for. */
type Customer = { id: string; name: string; firstName: string; suggestions: string[] };
interface LineDraft {
  id: string;
  label: string;
  amount: string;
}

const START_OPTIONS = ['This week', 'Next week', 'In 2 weeks', 'Next month'];

/** The owner prices the job with real line items instead of typing a number into chat. */
export function QuoteBuilder({
  open,
  customer,
  initial,
  subtitle = 'Price it the way you normally would. Your Charm learns from every line.',
  sending,
  sendingNote,
  error,
  onClose,
  onSend,
}: {
  open: boolean;
  customer: Customer;
  /** A quote to start from, such as the AI's draft. */
  initial?: QuoteDraft;
  subtitle?: string;
  sending: boolean;
  /** What's happening while it sends, when that takes a while. */
  sendingNote?: string;
  error: string;
  onClose: () => void;
  onSend: (quote: QuoteDraft) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Quote for ${customer.name}`}
      subtitle={subtitle}
      flush
    >
      {open && (
        <BuilderForm
          key={customer.id}
          customer={customer}
          initial={initial}
          sending={sending}
          sendingNote={sendingNote}
          error={error}
          onSend={onSend}
        />
      )}
    </Sheet>
  );
}

function BuilderForm({
  customer,
  initial,
  sending,
  sendingNote,
  error,
  onSend,
}: {
  customer: Customer;
  initial?: QuoteDraft;
  sending: boolean;
  sendingNote?: string;
  error: string;
  onSend: (quote: QuoteDraft) => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>(() =>
    initial?.lines.length
      ? initial.lines.map((line) => ({
          id: line.id,
          label: line.label,
          amount: moneyInput(line.amountCents),
        }))
      : [{ id: uid('line'), label: '', amount: '' }],
  );
  const [discountOn, setDiscountOn] = useState(!!initial?.discount);
  const [discountKind, setDiscountKind] = useState<Discount['kind']>(
    initial?.discount?.kind ?? 'percent',
  );
  const [discountValue, setDiscountValue] = useState(() =>
    !initial?.discount
      ? ''
      : initial.discount.kind === 'amount'
        ? moneyInput(initial.discount.value)
        : String(initial.discount.value),
  );
  const [discountReason, setDiscountReason] = useState(initial?.discount?.reason ?? '');
  const [start, setStart] = useState(initial?.start || 'Next week');
  const [duration, setDuration] = useState(initial?.duration ?? '');
  const [included, setIncluded] = useState(initial?.included.join('\n') ?? '');
  const [excluded, setExcluded] = useState(initial?.excluded.join('\n') ?? '');
  const [validDays, setValidDays] = useState(initial?.validDays ?? 14);
  const [note, setNote] = useState(initial?.note ?? '');
  const startOptions = START_OPTIONS.includes(start) ? START_OPTIONS : [start, ...START_OPTIONS];
  const validOptions = [7, 14, 30].includes(validDays) ? [7, 14, 30] : [validDays, 7, 14, 30];

  const priced = lines
    .map((line) => ({
      id: line.id,
      label: line.label.trim(),
      amountCents: parseMoney(line.amount) ?? 0,
    }))
    .filter((line) => line.label && line.amountCents > 0);
  const subtotal = priced.reduce((sum, line) => sum + line.amountCents, 0);
  const discountNumber =
    discountKind === 'amount'
      ? (parseMoney(discountValue) ?? 0)
      : Number.parseInt(discountValue, 10) || 0;
  const discountCents = !discountOn
    ? 0
    : discountKind === 'amount'
      ? Math.min(discountNumber, subtotal)
      : Math.round((subtotal * Math.min(discountNumber, 100)) / 100);
  const totalCents = Math.max(0, subtotal - discountCents);
  const ready = priced.length > 0;

  function update(id: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function suggest(label: string) {
    if (/discount/i.test(label)) {
      setDiscountOn(true);
      setDiscountReason(label);
      return;
    }
    setLines((current) => {
      const empty = current.find((line) => !line.label.trim());
      if (empty) return current.map((line) => (line.id === empty.id ? { ...line, label } : line));
      return [...current, { id: uid('line'), label, amount: '' }];
    });
  }

  function submit() {
    if (!ready) return;
    const list = (text: string) =>
      text
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
    onSend({
      lines: priced,
      discount:
        discountOn && discountNumber > 0
          ? {
              kind: discountKind,
              value: Math.min(discountNumber, discountKind === 'percent' ? 100 : discountNumber),
              reason: discountReason.trim(),
            }
          : null,
      start,
      duration: duration.trim(),
      included: list(included),
      excluded: list(excluded),
      validDays,
      note: note.trim(),
    });
  }

  const unused = customer.suggestions.filter(
    (label) =>
      !lines.some((line) => line.label === label) && !(discountOn && discountReason === label),
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-7 px-5 py-5 sm:px-6">
        <section aria-labelledby="lines-title">
          <h3 id="lines-title" className="t-h3">
            Line items
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {lines.map((line, position) => (
              <li
                key={line.id}
                className="grid grid-cols-[minmax(0,1fr)_96px_32px] gap-2 sm:grid-cols-[minmax(0,1fr)_112px_40px]"
              >
                <label htmlFor={`${line.id}-label`} className="sr-only">
                  Item {position + 1}
                </label>
                <TextInput
                  id={`${line.id}-label`}
                  placeholder={
                    position === 0 ? (customer.suggestions[0] ?? 'What it is') : 'What it is'
                  }
                  value={line.label}
                  onChange={(event) => update(line.id, { label: event.target.value })}
                />
                <MoneyInput
                  id={`${line.id}-amount`}
                  aria-label={`Price for item ${position + 1}`}
                  placeholder="0"
                  value={line.amount}
                  onChange={(amount) => update(line.id, { amount })}
                />
                <button
                  type="button"
                  aria-label={`Remove item ${position + 1}`}
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((current) => current.filter((item) => item.id !== line.id))
                  }
                  className="inline-flex h-12 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-stop disabled:opacity-30"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 -ml-2"
            onClick={() =>
              setLines((current) => [...current, { id: uid('line'), label: '', amount: '' }])
            }
          >
            <Plus aria-hidden /> Add a line
          </Button>
          {unused.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-muted">Quick add</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unused.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => suggest(label)}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3 text-sm text-ink-2 hover:border-ink/40 hover:text-ink"
                  >
                    <Plus className="size-3.5" aria-hidden /> {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="discount-title" className="border-t border-line pt-6">
          <div className="flex items-center justify-between gap-3">
            <h3 id="discount-title" className="t-h3">
              Discount
            </h3>
            {!discountOn && (
              <Button variant="ghost" size="sm" onClick={() => setDiscountOn(true)}>
                <Plus aria-hidden /> Add a discount
              </Button>
            )}
          </div>
          {discountOn && (
            <div className="fade-up mt-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="Discount type"
                  value={discountKind}
                  onChange={(kind) => {
                    setDiscountKind(kind);
                    setDiscountValue('');
                  }}
                  options={[
                    { value: 'percent', label: '% off' },
                    { value: 'amount', label: '$ off' },
                  ]}
                />
                {discountKind === 'amount' ? (
                  <MoneyInput
                    id="quote-discount"
                    aria-label="Discount amount"
                    placeholder="25"
                    value={discountValue}
                    onChange={setDiscountValue}
                    className="w-32"
                  />
                ) : (
                  <div className="relative w-28">
                    <TextInput
                      id="quote-discount"
                      aria-label="Discount percent"
                      inputMode="numeric"
                      placeholder="10"
                      value={discountValue}
                      onChange={(event) =>
                        setDiscountValue(event.target.value.replace(/\D/g, '').slice(0, 3))
                      }
                      className="pr-8 font-mono"
                    />
                    <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-muted">
                      %
                    </span>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDiscountOn(false);
                    setDiscountValue('');
                  }}
                >
                  Remove
                </Button>
              </div>
              <label htmlFor="quote-discount-reason" className="sr-only">
                Reason for the discount
              </label>
              <TextInput
                id="quote-discount-reason"
                placeholder="Why? For example: neighbor discount"
                value={discountReason}
                onChange={(event) => setDiscountReason(event.target.value)}
              />
            </div>
          )}
        </section>

        <section
          aria-labelledby="timing-title"
          className="flex flex-col gap-4 border-t border-line pt-6"
        >
          <h3 id="timing-title" className="t-h3">
            Timing and terms
          </h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Can start" htmlFor="quote-start">
              <select
                id="quote-start"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                className="h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:outline-none"
              >
                {startOptions.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
            <Field label="Takes about" htmlFor="quote-duration">
              <TextInput
                id="quote-duration"
                placeholder="3 hours"
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </Field>
            <Field label="Good for" htmlFor="quote-valid">
              <select
                id="quote-valid"
                value={validDays}
                onChange={(event) => setValidDays(Number(event.target.value))}
                className="h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:outline-none"
              >
                {validOptions.map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What's included" htmlFor="quote-included" hint="One per line." optional>
              <TextArea
                id="quote-included"
                rows={3}
                placeholder={'Cleanup when we’re done\nMaterials'}
                value={included}
                onChange={(event) => setIncluded(event.target.value)}
              />
            </Field>
            <Field label="Not included" htmlFor="quote-excluded" hint="One per line." optional>
              <TextArea
                id="quote-excluded"
                rows={3}
                placeholder="Anything not listed above"
                value={excluded}
                onChange={(event) => setExcluded(event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="rounded-md bg-surface-2 p-4">
          <Field
            label="What drove this price?"
            htmlFor="quote-note"
            hint={
              <span className="inline-flex items-center gap-1.5">
                <Lock className="size-3.5" aria-hidden /> Other businesses never see this. It's the
                best way to teach your Charm.
              </span>
            }
          >
            <TextArea
              id="quote-note"
              rows={2}
              placeholder="Heavy staining by the door needs a second pass."
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </section>
      </div>

      <div
        className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-line bg-surface px-5 pt-4 sm:px-6"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div>
          <p className="t-label text-muted">Total</p>
          <p className="tabular font-display text-[30px] leading-none font-[820] [font-stretch:108%]">
            {money(totalCents)}
          </p>
          {discountCents > 0 && (
            <p className="mt-1 text-xs text-go">Includes {money(discountCents)} off</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="quote" size="lg" onClick={submit} disabled={!ready || sending}>
            <Send aria-hidden /> {sending ? 'Sending…' : 'Send quote'}
          </Button>
          {sending && sendingNote && (
            <p className="max-w-[240px] text-right text-xs text-muted" role="status">
              {sendingNote}
            </p>
          )}
          {error && (
            <p className="max-w-[240px] text-right text-xs text-stop" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
