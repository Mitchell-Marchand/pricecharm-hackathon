import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { useStore } from '../lib/store';
import type { Screen } from '../lib/types';
import { cx } from '../lib/util';

const LABELS: { screen: Screen; label: string }[] = [
  { screen: 'landing', label: 'Landing page' },
  { screen: 'business', label: 'Step 1 · Your business' },
  { screen: 'jobs', label: 'Step 2 · Past jobs' },
  { screen: 'practice', label: 'Step 3 · Practice quotes' },
  { screen: 'ready', label: 'Your AI is ready' },
  { screen: 'account', label: 'Create account' },
  { screen: 'live', label: "You're live" },
];

/** Lets reviewers jump to any screen. Missing answers are filled with sample data. */
export function PrototypeMenu() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className="t-label inline-flex h-7 items-center gap-1 rounded-xs border border-dashed border-line-strong px-2 text-[10.5px]! text-muted hover:border-ink/40 hover:text-ink"
      >
        Prototype <ChevronDown className="size-3" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="fade-up absolute top-9 left-0 z-[90] w-64 rounded-md border border-line bg-surface p-1.5 shadow-2"
        >
          <p className="px-2.5 pt-1.5 pb-2 text-xs text-muted">Mock data. Nothing is saved to a server or sent.</p>
          {LABELS.map((item) => (
            <button
              key={item.screen}
              type="button"
              role="menuitem"
              onClick={() => {
                dispatch({ type: 'jump', screen: item.screen });
                setOpen(false);
              }}
              className={cx(
                'flex w-full items-center rounded-sm px-2.5 py-2 text-left text-sm hover:bg-surface-2',
                state.screen === item.screen ? 'font-semibold text-ink' : 'text-ink-2',
              )}
            >
              {item.label}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatch({ type: 'reset' });
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm text-stop hover:bg-stop-soft"
          >
            <RotateCcw className="size-4" aria-hidden /> Start over
          </button>
        </div>
      )}
    </div>
  );
}
