'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowUp } from 'lucide-react';
import { Button, Chip, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  endPriceChange,
  loadPriceChange,
  readPriceChange,
  setPriceChange,
  type PriceChange,
  type Until,
} from '@/lib/price-change';
import { cx } from '@/lib/util';

type Line = { from: 'owner' | 'charm'; text: string; knows?: boolean };
/** What the Charm is waiting to hear. */
type Asking =
  | { about: 'direction'; percent: number | null }
  | { about: 'percent'; up: boolean }
  | { about: 'until'; percent: number; soonest: 'week' | 'month' | null };

const PERCENTS = [5, 10, 15, 20];
const LENGTHS: { until: Until; label: string }[] = [
  { until: 'week', label: 'This week' },
  { until: 'month', label: 'This month' },
  { until: 'open', label: 'Until I turn it off' },
];

const howLong = (percent: number) =>
  percent > 0
    ? 'How long should we keep the increase for?'
    : 'How long should we keep the lower prices for?';

/**
 * Where the owner tells their Charm something about their prices right now, like "we're super busy
 * this month, increase quotes by 20%". It asks what it needs to know, then every quote follows it
 * until the end date. The server does the math, so it's exact.
 */
export function TellCharm({ className }: { className?: string }) {
  const [change, setChange] = useState<PriceChange | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [picksDate, setPicksDate] = useState(false);
  const [date, setDate] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const said = useRef('');

  useEffect(() => {
    loadPriceChange()
      .then((view) => setChange(view.change))
      .catch(() => {});
  }, []);

  const hears = (line: Line) => setLines((shown) => [...shown, line]);
  const askUntil = (percent: number, soonest: 'week' | 'month' | null) => {
    hears({ from: 'charm', text: howLong(percent) });
    setAsking({ about: 'until', percent, soonest });
  };
  const askPercent = (up: boolean) => {
    hears({ from: 'charm', text: `How much ${up ? 'higher' : 'lower'} should quotes be?` });
    setAsking({ about: 'percent', up });
  };

  async function tell(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setError('');
    setAsking(null);
    setPicksDate(false);
    hears({ from: 'owner', text });
    said.current = text;
    setBusy(true);
    try {
      const read = await readPriceChange(text);
      if (!read.changesPrices)
        hears({
          from: 'charm',
          text: 'I can raise or lower all your quotes for a while. Anything else about your prices goes in',
          knows: true,
        });
      else if (!read.direction) {
        hears({ from: 'charm', text: 'Should quotes go up or down?' });
        setAsking({ about: 'direction', percent: read.percent });
      } else if (!read.percent) askPercent(read.direction === 'up');
      else askUntil(read.direction === 'up' ? read.percent : -read.percent, read.lasts);
    } catch (readError) {
      setDraft(text);
      setLines((shown) => shown.slice(0, -1));
      setError(errorMessage(readError));
    } finally {
      setBusy(false);
    }
  }

  async function keep(percent: number, until: Until, label: string) {
    setError('');
    setBusy(true);
    try {
      const { change: saved } = await setPriceChange({ percent, until, words: said.current });
      hears({ from: 'owner', text: label });
      hears({ from: 'charm', text: `Done. ${saved?.words ?? ''}` });
      setChange(saved);
      setAsking(null);
      setPicksDate(false);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setError('');
    setBusy(true);
    try {
      await endPriceChange();
      setChange(null);
      hears({ from: 'charm', text: 'Done. Quotes are back to your normal prices.' });
    } catch (offError) {
      setError(errorMessage(offError));
    } finally {
      setBusy(false);
    }
  }

  const lengths =
    asking?.about === 'until' && asking.soonest
      ? [...LENGTHS].sort(
          (a, b) => Number(b.until === asking.soonest) - Number(a.until === asking.soonest),
        )
      : LENGTHS;

  return (
    <section className={cx('rounded-lg border border-line bg-surface p-5', className)}>
      <h2 className="t-h3">Tell your Charm</h2>
      <p className="mt-1 text-sm text-ink-2">
        Busy or slow? Tell it, and every quote changes until you say.
      </p>
      {change && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md bg-canary-soft px-4 py-3">
          <p className="font-medium">{change.words}</p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void turnOff()}>
            Turn off
          </Button>
        </div>
      )}
      {lines.length > 0 && (
        <div className="mt-4 flex flex-col gap-2" aria-live="polite">
          {lines.map((line, index) => (
            <p
              key={index}
              className={cx(
                'max-w-[85%] rounded-[16px] px-3.5 py-2.5 text-[15px]',
                line.from === 'owner'
                  ? 'self-end rounded-br-[4px] bg-accent text-on-accent'
                  : 'self-start rounded-bl-[4px] border border-line bg-surface shadow-1',
              )}
            >
              {line.text}
              {line.knows && (
                <>
                  {' '}
                  <Link
                    href="/app/train/knows"
                    className="font-semibold text-accent underline underline-offset-4"
                  >
                    What your Charm knows
                  </Link>
                  .
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {asking && (
        <div className="mt-3 flex flex-wrap gap-2">
          {asking.about === 'direction' && (
            <>
              <Chip
                onClick={() => {
                  hears({ from: 'owner', text: 'Up' });
                  if (asking.percent) askUntil(asking.percent, null);
                  else askPercent(true);
                }}
              >
                Up
              </Chip>
              <Chip
                onClick={() => {
                  hears({ from: 'owner', text: 'Down' });
                  if (asking.percent) askUntil(-asking.percent, null);
                  else askPercent(false);
                }}
              >
                Down
              </Chip>
            </>
          )}
          {asking.about === 'percent' &&
            PERCENTS.map((percent) => (
              <Chip
                key={percent}
                onClick={() => {
                  hears({ from: 'owner', text: `${percent}%` });
                  askUntil(asking.up ? percent : -percent, null);
                }}
              >
                {percent}%
              </Chip>
            ))}
          {asking.about === 'until' && (
            <>
              {lengths.map((length) => (
                <Chip
                  key={length.until}
                  onClick={() => void keep(asking.percent, length.until, length.label)}
                >
                  {length.label}
                </Chip>
              ))}
              <Chip selected={picksDate} onClick={() => setPicksDate(true)}>
                Pick a date
              </Chip>
            </>
          )}
        </div>
      )}
      {asking?.about === 'until' && picksDate && (
        <div className="mt-3 flex items-center gap-2">
          <TextInput
            type="date"
            aria-label="Keep it through"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <Button
            disabled={!date || busy}
            onClick={() => void keep(asking.percent, date, `Through ${date}`)}
          >
            Set
          </Button>
        </div>
      )}
      {error && (
        <p className="mt-3 text-sm text-stop" role="alert">
          {error}
        </p>
      )}
      <form className="mt-4 flex items-center gap-2" onSubmit={tell}>
        <label htmlFor="tell-charm" className="sr-only">
          Tell your Charm
        </label>
        <TextInput
          id="tell-charm"
          autoComplete="off"
          enterKeyHint="send"
          maxLength={300}
          placeholder="We're super busy this month, increase quotes by 20%"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          aria-label="Send"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink hover:opacity-90 disabled:opacity-30"
        >
          <ArrowUp className="size-5" />
        </button>
      </form>
    </section>
  );
}
