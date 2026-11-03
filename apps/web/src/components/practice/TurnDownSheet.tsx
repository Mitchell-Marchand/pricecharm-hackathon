'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Sheet } from '@/components/Sheet';
import { Button, Chip, Field, MoneyInput, Segmented, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { currentCurrency } from '@/lib/currency';
import {
  declinePractice,
  declinePrefill,
  type DeclineInput,
  type DeclinePrefill,
  type PracticeRun,
} from '@/lib/practice';
import {
  addTurnDown,
  changeTurnDown,
  loadTurnDowns,
  REASONS,
  saveMinimum,
  type TurnDownKind,
  type TurnDownRule,
  type TurnDowns,
} from '@/lib/turn-downs';
import { moneyInput, parseMoney } from '@/lib/util';

/**
 * What the sheet is for: turning a practice customer down, adding a rule from What it knows or
 * Settings, changing one, or changing the least the owner charges.
 */
export type TurnDownTarget =
  | { mode: 'decline'; run: PracticeRun }
  | { mode: 'add' }
  | { mode: 'edit'; rule: TurnDownRule }
  | { mode: 'minimum'; minimumCents: number | null };

type SmallLine = 'size' | 'price' | 'minimum';
type Values = {
  small: SmallLine;
  size: string;
  unit: string;
  price: string;
  minimum: string;
  text: string;
  distance: string;
  distanceUnit: 'mi' | 'km';
  days: string;
};

/** Miles where the owner prices in dollars or pounds, kilometres everywhere else. */
const usualUnit = (): 'mi' | 'km' => (['USD', 'GBP'].includes(currentCurrency()) ? 'mi' : 'km');

/** A practice customer 27 miles out suggests "about 25": a line just inside where they are. */
const roundDistance = (value: number) =>
  value >= 10 ? Math.floor(value / 5) * 5 : Math.max(1, Math.floor(value));

const number = (text: string) => {
  const value = Number(text.replace(/,/g, '').trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

function startingValues(target: TurnDownTarget | null, prefill: DeclinePrefill | null): Values {
  const values: Values = {
    small: prefill?.size ? 'size' : 'price',
    size: prefill?.size ? String(prefill.size.quantity) : '',
    unit: prefill?.size?.unit ?? '',
    price: '',
    minimum: '',
    text: prefill?.service ?? '',
    distance: '',
    distanceUnit: usualUnit(),
    days: '7',
  };
  const away =
    target?.mode === 'decline' ? (target.run.customer?.distance ?? prefill?.distance) : null;
  if (away) {
    values.distance = String(roundDistance(away.value));
    values.distanceUnit = away.unit;
  }
  if (target?.mode === 'minimum') {
    values.small = 'minimum';
    values.minimum = moneyInput(target.minimumCents);
  }
  if (target?.mode === 'edit') {
    const { rule } = target;
    values.small = rule.priceCents !== null ? 'price' : 'size';
    values.size = rule.size !== null ? String(rule.size) : '';
    values.unit = rule.sizeUnit;
    values.price = moneyInput(rule.priceCents);
    values.text = rule.text;
    values.distance = rule.distance !== null ? String(rule.distance) : '';
    values.distanceUnit = rule.distanceUnit ?? usualUnit();
    values.days = rule.days !== null ? String(rule.days) : '7';
  }
  return values;
}

/** The rule the answers make, or what's missing from them. */
function ruleFrom(kind: TurnDownKind, values: Values): DeclineInput | string {
  const size = number(values.size);
  switch (kind) {
    case 'too_small': {
      if (values.small === 'minimum') {
        const minimumCents = parseMoney(values.minimum);
        return minimumCents ? { kind: 'minimum', minimumCents } : 'Add your minimum.';
      }
      if (values.small === 'price') {
        const priceCents = parseMoney(values.price);
        return priceCents
          ? { kind, size: null, sizeUnit: null, priceCents }
          : 'Add the price it turns down.';
      }
      return size && values.unit.trim()
        ? { kind, size, sizeUnit: values.unit.trim(), priceCents: null }
        : 'Add the size and what it’s in, like 200 sq ft.';
    }
    case 'too_big':
      return size && values.unit.trim()
        ? { kind, size, sizeUnit: values.unit.trim() }
        : 'Add the size and what it’s in, like 5,000 sq ft.';
    case 'not_offered':
      return values.text.trim().length >= 2
        ? { kind, text: values.text.trim() }
        : 'Say what you don’t do.';
    case 'too_far': {
      const distance = number(values.distance);
      return distance
        ? { kind, distance, distanceUnit: values.distanceUnit }
        : 'Add how far you’ll go.';
    }
    case 'lead_time': {
      const days = number(values.days);
      return days && Number.isInteger(days) ? { kind, days } : 'Add how many days out you book.';
    }
    case 'other':
      return values.text.trim().length >= 2
        ? { kind, text: values.text.trim() }
        : 'Write a sentence about why.';
  }
}

function Choice({
  checked,
  onPick,
  children,
}: {
  checked: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-2 rounded-sm border border-line-strong px-3 py-2.5 has-checked:border-accent has-checked:bg-accent-soft">
      <input
        type="radio"
        name="turn-down-small"
        checked={checked}
        onChange={onPick}
        className="size-4 accent-[var(--accent)]"
      />
      {children}
    </label>
  );
}

/** The one follow-up for a reason, filled in from the practice customer where it can be. */
function FollowUp({
  kind,
  values,
  set,
  target,
  prefill,
  locations,
}: {
  kind: TurnDownKind;
  values: Values;
  set: (patch: Partial<Values>) => void;
  target: TurnDownTarget;
  prefill: DeclinePrefill | null;
  locations: string[];
}) {
  const sizeInputs = (prefix: string) => (
    <>
      <div className="w-22">
        <TextInput
          aria-label="Size"
          id={`${prefix}-size`}
          inputMode="decimal"
          className="font-mono"
          value={values.size}
          placeholder="200"
          onChange={(event) => set({ size: event.target.value.replace(/[^\d.,]/g, '') })}
        />
      </div>
      <div className="w-24">
        <TextInput
          aria-label="What the size is in"
          id={`${prefix}-unit`}
          value={values.unit}
          placeholder="sq ft"
          maxLength={20}
          onChange={(event) => set({ unit: event.target.value })}
        />
      </div>
    </>
  );
  if (kind === 'too_small')
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-3 font-semibold">
          {target.mode === 'minimum' ? 'The least you charge' : 'Turn down jobs this small?'}
        </legend>
        {target.mode !== 'minimum' && (
          <>
            <Choice checked={values.small === 'size'} onPick={() => set({ small: 'size' })}>
              <span>Jobs of</span>
              {sizeInputs('small')}
              <span>or less</span>
            </Choice>
            <Choice checked={values.small === 'price'} onPick={() => set({ small: 'price' })}>
              <span>Jobs that come to</span>
              <MoneyInput
                aria-label="Price"
                id="small-price"
                className="w-28"
                value={values.price}
                placeholder="100"
                onChange={(price) => set({ price, small: 'price' })}
              />
              <span>or less</span>
            </Choice>
          </>
        )}
        {target.mode !== 'edit' && (
          <Choice checked={values.small === 'minimum'} onPick={() => set({ small: 'minimum' })}>
            <span>
              {target.mode === 'minimum' ? 'Every job is at least' : 'Charge my minimum instead:'}
            </span>
            <MoneyInput
              aria-label="Your minimum"
              id="small-minimum"
              className="w-28"
              value={values.minimum}
              placeholder="150"
              onChange={(minimum) => set({ minimum, small: 'minimum' })}
            />
          </Choice>
        )}
        {values.small === 'minimum' && (
          <p className="text-sm text-muted">
            Smaller jobs get quoted at your minimum instead of turned down.
          </p>
        )}
      </fieldset>
    );
  if (kind === 'too_big')
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 font-semibold">Turn down jobs this big?</legend>
        <div className="flex flex-wrap items-center gap-2">
          <span>Jobs of</span>
          {sizeInputs('big')}
          <span>or more</span>
        </div>
      </fieldset>
    );
  if (kind === 'not_offered') {
    const picks = [prefill?.service ?? '', ...(prefill?.extras ?? [])].filter(Boolean);
    return (
      <div className="flex flex-col gap-3">
        <Field
          label="What part don’t you do?"
          htmlFor="turn-down-text"
          hint="Your Charm tells customers you don’t do it."
        >
          <TextInput
            id="turn-down-text"
            maxLength={120}
            value={values.text}
            placeholder="Gutter repair"
            onChange={(event) => set({ text: event.target.value })}
          />
        </Field>
        {picks.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {picks.map((pick) => (
              <Chip key={pick} selected={values.text === pick} onClick={() => set({ text: pick })}>
                {pick}
              </Chip>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (kind === 'too_far') {
    const where =
      locations.length === 1
        ? locations[0]
        : locations.length
          ? 'the nearest of your locations'
          : 'where you work';
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 font-semibold">Turn down jobs farther than this?</legend>
        <div className="flex flex-wrap items-center gap-2">
          <span>More than about</span>
          <div className="w-20">
            <TextInput
              aria-label="Distance"
              id="far-distance"
              inputMode="decimal"
              className="font-mono"
              value={values.distance}
              placeholder="25"
              onChange={(event) => set({ distance: event.target.value.replace(/[^\d.]/g, '') })}
            />
          </div>
          <Segmented<'mi' | 'km'>
            label="Miles or kilometres"
            value={values.distanceUnit}
            onChange={(distanceUnit) => set({ distanceUnit })}
            options={[
              { value: 'mi', label: 'mi' },
              { value: 'km', label: 'km' },
            ]}
          />
          <span>from {where}</span>
        </div>
      </fieldset>
    );
  }
  if (kind === 'lead_time')
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 font-semibold">How far out do you book?</legend>
        <div className="flex flex-wrap items-center gap-2">
          <span>At least</span>
          <div className="w-20">
            <TextInput
              aria-label="Days"
              id="lead-days"
              inputMode="numeric"
              className="font-mono"
              value={values.days}
              onChange={(event) => set({ days: event.target.value.replace(/\D/g, '').slice(0, 3) })}
            />
          </div>
          <span>days out</span>
        </div>
        <p className="text-sm text-muted">
          Customers who need it sooner are told the earliest you can start.
        </p>
      </fieldset>
    );
  return (
    <Field label="Why not? One sentence is enough." htmlFor="turn-down-text">
      <TextInput
        id="turn-down-text"
        maxLength={200}
        value={values.text}
        placeholder="We don’t work on commercial buildings."
        onChange={(event) => set({ text: event.target.value })}
      />
    </Field>
  );
}

/**
 * "Why not?": the reasons a job gets turned down, then one question for the one picked. What
 * it saves is a rule the customer chat follows.
 */
export function TurnDownSheet({
  target,
  onClose,
  onDeclined,
  onSaved,
}: {
  /** Null while it's closed. */
  target: TurnDownTarget | null;
  onClose: () => void;
  /** A practice customer was turned down. */
  onDeclined?: (run: PracticeRun) => void;
  /** A rule or the minimum was added or changed. */
  onSaved?: (turnDowns: TurnDowns) => void;
}) {
  const [kind, setKind] = useState<TurnDownKind | null>(null);
  const [prefill, setPrefill] = useState<DeclinePrefill | null>(null);
  const [locations, setLocations] = useState<string[]>([]);
  const [values, setValues] = useState<Values>(() => startingValues(null, null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Only a new target starts it over, not a newer copy of the same run.
  const opened = !target
    ? ''
    : `${target.mode}:${target.mode === 'decline' ? target.run.id : target.mode === 'edit' ? target.rule.id : ''}`;

  // Each time it opens: the reason it's about, if it's known, and what to fill in.
  useEffect(() => {
    if (!target) return;
    setError('');
    setSaving(false);
    setPrefill(null);
    setKind(
      target.mode === 'edit' ? target.rule.kind : target.mode === 'minimum' ? 'too_small' : null,
    );
    setValues(startingValues(target, null));
    loadTurnDowns()
      .then((loaded) => setLocations(loaded.locations))
      .catch(() => {});
    if (target.mode === 'decline')
      declinePrefill(target.run.id)
        .then((loaded) => {
          setPrefill(loaded);
          setValues(startingValues(target, loaded));
        })
        .catch(() => {});
  }, [opened]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!target || !kind || saving) return;
    const input = ruleFrom(kind, values);
    if (typeof input === 'string') return setError(input);
    setSaving(true);
    setError('');
    try {
      if (target.mode === 'decline') onDeclined?.(await declinePractice(target.run.id, input));
      else if (input.kind === 'minimum') onSaved?.(await saveMinimum(input.minimumCents));
      else if (target.mode === 'edit') onSaved?.(await changeTurnDown(target.rule.id, input));
      else onSaved?.(await addTurnDown(input));
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const choosing = target?.mode === 'decline' || target?.mode === 'add';
  const reason = REASONS.find((item) => item.kind === kind);
  const title =
    target?.mode === 'minimum'
      ? 'Your minimum'
      : target?.mode === 'edit'
        ? (reason?.label ?? 'Change it')
        : 'Why not?';
  return (
    <Sheet
      open={Boolean(target)}
      onClose={onClose}
      title={title}
      subtitle={
        target?.mode === 'decline'
          ? 'Your Charm will turn down jobs like this. You can change it any time.'
          : target?.mode === 'add'
            ? 'Your Charm says no to these in the customer chat, kindly, without a quote.'
            : undefined
      }
      footer={
        kind ? (
          <div className="flex flex-col items-end gap-1.5 pb-1">
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? 'Saving…' : target?.mode === 'decline' ? 'Turn it down' : 'Save'}
            </Button>
            {error && (
              <p className="text-right text-sm text-stop" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      {target && !kind && (
        <ul className="-mx-1 flex flex-col" aria-label="Why not?">
          {REASONS.map((item) => (
            <li key={item.kind}>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setKind(item.kind);
                }}
                className="flex h-14 w-full items-center justify-between gap-3 rounded-sm px-3 text-left text-[17px] font-medium hover:bg-surface-2"
              >
                {item.label}
                <ChevronRight className="size-5 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {target && kind && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
          {choosing && (
            <button
              type="button"
              onClick={() => setKind(null)}
              className="-ml-1 inline-flex items-center gap-1 self-start text-sm text-muted hover:text-ink"
            >
              <ArrowLeft className="size-4" aria-hidden /> {reason?.label}
            </button>
          )}
          <FollowUp
            kind={kind}
            values={values}
            set={(patch) => setValues((current) => ({ ...current, ...patch }))}
            target={target}
            prefill={prefill}
            locations={locations}
          />
          {/* Enter in a field saves, as the button below does. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </Sheet>
  );
}
