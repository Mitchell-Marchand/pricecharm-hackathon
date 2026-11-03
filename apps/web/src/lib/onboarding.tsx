'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage, json } from './api';
import { guessCurrency, setCurrency, type Currency } from './currency';
import { useHumanCheck } from './human-check';

export type Step = 'business' | 'jobs' | 'practice' | 'ready' | 'account' | 'try' | 'live';

export interface BusinessDraft {
  tradeId: string | null;
  customTrade: string;
  services: string[];
  /** Services the owner typed in, kept as chips even after they're switched off. */
  customServices: string[];
  name: string;
  area: string;
  /** What their quotes and their plan are in. An older API leaves it out, for dollars. */
  currency?: Currency;
  radius: string;
}

export interface Onboarding {
  draft: boolean;
  step: Step;
  business: BusinessDraft;
  slug: string | null;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

interface OnboardingValue {
  state: Onboarding | null;
  loadError: string;
  save: SaveState;
  reload: () => Promise<void>;
  updateBusiness: (patch: Partial<BusinessDraft>) => void;
  /** Saves anything pending, records the step and opens it. */
  goTo: (step: Step) => Promise<void>;
  flush: () => Promise<boolean>;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

// React runs effects twice in development. One shared request keeps that from starting two drafts.
let starting: Promise<Onboarding> | null = null;

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { slot, headers: humanHeaders } = useHumanCheck('onboarding');
  const [state, setState] = useState<Onboarding | null>(null);
  const [loadError, setLoadError] = useState('');
  const [save, setSave] = useState<SaveState>('idle');
  const pending = useRef<Partial<BusinessDraft>>({});
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<boolean> | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setState(await api<Onboarding>('/onboarding'));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setLoadError(errorMessage(error));
        return;
      }
      try {
        starting ??= humanHeaders()
          .then((headers) =>
            // A first guess at their currency, from where the browser is. They can change it.
            api<Onboarding>('/onboarding/start', {
              method: 'POST',
              headers,
              ...json({ currency: guessCurrency() }),
            }),
          )
          .finally(() => {
            starting = null;
          });
        setState(await starting);
      } catch (startError) {
        setLoadError(errorMessage(startError));
      }
    }
  }, [humanHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (saving.current) await saving.current;
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return true;
    const { customServices: _localOnly, ...body } = patch;
    setSave('saving');
    saving.current = api<Onboarding>('/onboarding/business', { method: 'PATCH', ...json(body) })
      .then(() => {
        setSave(Object.keys(pending.current).length ? 'saving' : 'saved');
        return true;
      })
      .catch(() => {
        // Keep the edits so the next change, or Continue, tries them again.
        pending.current = { ...patch, ...pending.current };
        setSave('failed');
        return false;
      })
      .finally(() => {
        saving.current = null;
      });
    return saving.current;
  }, []);

  const updateBusiness = useCallback(
    (patch: Partial<BusinessDraft>) => {
      setState((current) =>
        current ? { ...current, business: { ...current.business, ...patch } } : current,
      );
      pending.current = { ...pending.current, ...patch };
      setSave('saving');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 500);
    },
    [flush],
  );

  const goTo = useCallback(
    async (step: Step) => {
      if (!(await flush())) return;
      try {
        const next = await api<Onboarding>('/onboarding/step', {
          method: 'PATCH',
          ...json({ step }),
        });
        setState((current) => (current ? { ...current, step: next.step } : next));
      } catch {
        // The step is only a bookmark for coming back later; moving on still works.
      }
      router.push(`/start/${step}`);
    },
    [flush, router],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Every amount in setup is in the business's currency.
  if (state) setCurrency(state.business.currency);
  const value = useMemo(
    () => ({ state, loadError, save, reload: load, updateBusiness, goTo, flush }),
    [state, loadError, save, load, updateBusiness, goTo, flush],
  );
  return (
    <OnboardingContext.Provider value={value}>
      {children}
      <div ref={slot} className="human-check fixed inset-x-0 bottom-24 z-50" />
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingValue {
  const value = useContext(OnboardingContext);
  if (!value) throw new Error('useOnboarding must be used inside OnboardingProvider.');
  return value;
}
