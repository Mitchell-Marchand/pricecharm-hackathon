'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Camera, Check, Pencil, ScanEye } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Avatar, Button, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import type { ReadingProgress } from '@/lib/chat';
import { fixPhotoReading, type PhotoReading, type PracticeRun, type Tone } from '@/lib/practice';
import { cx } from '@/lib/util';

type Read = Extract<PhotoReading, { status: 'read' }>;

const list = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
const number = (value: number) => value.toLocaleString('en-US');
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Under a customer's bubble, lined up with it past the avatar. */
const UNDER = 'ml-[46px] max-w-[420px]';

/**
 * The owner watching their Charm read the customer's photos: each step as it happens and what
 * it's seen so far, from the reading itself. About how long photos take, from real readings.
 */
const STEPS = [
  { step: 'watching', done: 60, seconds: 12 },
  { step: 'counting', done: 95, seconds: 8 },
] as const;

function stepLabel(step: 'watching' | 'counting', progress: ReadingProgress | null) {
  const counting = progress?.counting ?? [];
  if (step === 'watching') return 'Looking over the photos';
  if (counting.length) return `Counting the ${list(counting)}`;
  return progress?.seen !== undefined ? 'Checking the details' : 'Counting what sets the price';
}

export function PhotoReadingStatus({ progress }: { progress: ReadingProgress | null }) {
  const at = progress?.step === 'counting' || progress?.step === 'checking' ? 1 : 0;
  const from = at ? STEPS[0].done : 0;
  const bar = {
    '--from': `${from}%`,
    '--to': `${from + (STEPS[at].done - from) * 0.9}%`,
    animationDuration: `${STEPS[at].seconds}s`,
  } as CSSProperties;
  const seen = progress?.seen?.trim();
  const found = progress?.found ?? [];
  return (
    <div
      className={cx(UNDER, 'fade-up rounded-md border border-line bg-surface px-4 py-3.5 shadow-1')}
      role="status"
      aria-live="polite"
    >
      <p className="flex items-center gap-2 text-[15px] font-semibold">
        <ScanEye className="size-4 text-accent" aria-hidden /> Your Charm is looking at the photos
      </p>
      <ol className="mt-3 flex flex-col gap-2">
        {STEPS.map((item, index) => (
          <li
            key={item.step}
            className={cx(
              'flex items-center gap-2.5 text-[14.5px] leading-snug',
              index < at ? 'text-ink-2' : index === at ? 'font-medium text-ink' : 'text-muted',
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              {index < at ? (
                <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Check className="size-3" strokeWidth={3} aria-hidden />
                </span>
              ) : index === at ? (
                <span
                  className="size-4 animate-spin rounded-full border-2 border-accent-soft border-t-accent"
                  aria-hidden
                />
              ) : (
                <span className="size-2 rounded-full bg-line-strong" aria-hidden />
              )}
            </span>
            {stepLabel(item.step, progress)}
          </li>
        ))}
      </ol>
      <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div key={at} className="reading-bar h-full rounded-full bg-accent" style={bar} />
      </div>
      {(seen || found.length > 0) && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-[13.5px] leading-[1.5] text-ink-2">
          {found.length > 0 && (
            <p>
              <span className="font-medium text-ink">Found so far:</span> {found.join(', ')}
            </p>
          )}
          {seen && <p>{seen}</p>}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Customers&apos; photos get read like this too. It usually takes under half a minute.
      </p>
    </div>
  );
}

/** "About 18 windows", "At least 30 windows", "20 windows" once the owner has counted. */
function countLine(item: Read['counts'][number]) {
  const amount = `${number(item.count)} ${item.count === 1 ? item.label.replace(/s$/, '') : item.label}`;
  if (item.fixed) return upper(amount);
  return item.atLeast ? `At least ${amount}` : `About ${amount}`;
}

function areaLine(area: NonNullable<Read['area']>) {
  const size =
    area.low === area.high
      ? `${number(area.low)} ${area.unit}`
      : `about ${number(area.low)}–${number(area.high)} ${area.unit}`;
  return `${upper(area.surface)}, ${size}`;
}

/**
 * What the Charm saw in the photos, under them: what they show, what it counted and sized, and
 * the state of it. This is what its guess on the job reads. While the customer is open, the owner
 * can fix a count or the size or add a note, and the guess goes on that instead.
 */
export function PhotoReadingCard({
  run,
  reading,
  canFix,
  onChange,
  onShowDrawn,
}: {
  run: PracticeRun;
  reading: Read;
  canFix: boolean;
  onChange: (run: PracticeRun) => void;
  onShowDrawn?: () => void;
}) {
  const notify = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [area, setArea] = useState('');
  const [note, setNote] = useState('');

  function open() {
    setCounts(Object.fromEntries(reading.counts.map((item) => [item.label, String(item.count)])));
    setArea(
      reading.area
        ? String(
            reading.area.fixed
              ? reading.area.low
              : Math.round((reading.area.low + reading.area.high) / 2),
          )
        : '',
    );
    setNote(reading.note);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const fixes: { counts: Record<string, number>; area?: number | null; note: string } = {
      counts: {},
      note: note.trim(),
    };
    for (const item of reading.counts) {
      const value = Number(counts[item.label]);
      if (Number.isInteger(value) && value >= 0 && value !== item.count)
        fixes.counts[item.label] = value;
    }
    const sized = Number(area);
    if (reading.area && sized > 0) {
      const shown = reading.area.fixed
        ? reading.area.low
        : Math.round((reading.area.low + reading.area.high) / 2);
      if (sized !== shown) fixes.area = sized;
    }
    setSaving(true);
    try {
      onChange(await fixPhotoReading(run.id, fixes));
      setEditing(false);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const seen = [
    ...reading.counts.map((item) =>
      item.kinds.length
        ? `${countLine(item)}: ${item.kinds.map((kind) => `${kind.count} ${kind.kind}`).join(', ')}`
        : countLine(item),
    ),
    ...(reading.area ? [areaLine(reading.area)] : []),
  ];
  const fixed = reading.counts.some((item) => item.fixed) || reading.area?.fixed || reading.note;

  return (
    <section
      className={cx(UNDER, 'fade-up rounded-md border border-line bg-surface px-4 py-3.5 shadow-1')}
      aria-labelledby={`saw-${run.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={`saw-${run.id}`} className="t-label flex items-center gap-1.5 text-muted">
          <ScanEye className="size-3.5" aria-hidden /> What your Charm saw
        </h3>
        {canFix && !editing && (
          <button
            type="button"
            onClick={open}
            className="-my-1 inline-flex shrink-0 items-center gap-1 py-1 text-sm text-muted hover:text-accent"
          >
            <Pencil className="size-3.5" aria-hidden /> Fix
          </button>
        )}
      </div>

      {editing ? (
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => void save(event)}>
          {reading.counts.map((item) => (
            <label key={item.label} className="flex items-center justify-between gap-3 text-[15px]">
              <span className="min-w-0">{upper(item.label)}</span>
              <TextInput
                className="h-10 w-24 text-right"
                inputMode="numeric"
                value={counts[item.label] ?? ''}
                onChange={(event) =>
                  setCounts({ ...counts, [item.label]: event.target.value.replace(/\D/g, '') })
                }
              />
            </label>
          ))}
          {reading.area && (
            <label className="flex items-center justify-between gap-3 text-[15px]">
              <span className="min-w-0">
                {upper(reading.area.surface)}, in {reading.area.unit}
              </span>
              <TextInput
                className="h-10 w-24 text-right"
                inputMode="numeric"
                value={area}
                onChange={(event) => setArea(event.target.value.replace(/\D/g, ''))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-[15px]">
            Anything else it got wrong or missed?
            <TextInput
              className="h-10"
              maxLength={300}
              value={note}
              placeholder="Like: the screens are off"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-10" disabled={saving}>
              Save fix
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-10"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {reading.summary && <p className="mt-2 text-[15px] text-ink">{reading.summary}</p>}
          {seen.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-[15px] text-ink">
              {seen.map((line) => (
                <li key={line} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          )}
          {reading.details.length > 0 && (
            <p className="mt-2 text-sm text-ink-2">{upper(reading.details.join(' · '))}</p>
          )}
          {reading.note && (
            <p className="mt-2 text-sm text-ink-2">
              <span className="font-medium text-ink">You added:</span> {reading.note}
            </p>
          )}
          <p className="mt-2.5 text-xs text-muted">
            {fixed
              ? 'It goes on your fix for this job.'
              : canFix
                ? 'This is how it reads a customer’s photos. Fix anything it got wrong.'
                : 'This is how it read the photos.'}
          </p>
          {onShowDrawn && reading.drawn.length > 0 && (
            <button
              type="button"
              onClick={onShowDrawn}
              className="mt-2 text-sm font-medium text-accent hover:underline"
            >
              See what it counted
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Couldn't read them: the chat goes on, and its guess goes on what the customer says. */
export function PhotoReadingFailed() {
  return (
    <p className={cx(UNDER, 'text-sm text-muted')} role="status">
      Your Charm couldn&apos;t read these photos. Its guess goes on the chat instead.
    </p>
  );
}

/** The customer off taking the photo the owner asked for. */
export function TakingPhoto({
  name,
  initials,
  tone,
}: {
  name: string;
  initials: string;
  tone: Tone;
}) {
  return (
    <div className="fade-up flex items-end gap-2.5" role="status">
      <div className="w-9 shrink-0">
        <Avatar initials={initials} tone={tone} />
      </div>
      <div className="flex h-11 items-center gap-2 rounded-[16px] rounded-bl-[4px] border border-line bg-surface px-4 text-[15px] text-muted shadow-1">
        <Camera className="size-4 animate-pulse" aria-hidden />
        Taking a photo…<span className="sr-only"> {name} will send it in a moment.</span>
      </div>
    </div>
  );
}
