import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from 'react';
import { SCENARIOS } from '../data/scenarios';
import { SAMPLE_BUSINESS, sampleJob, sampleQuotes } from '../data/samples';
import { TRADES_BY_ID } from '../data/trades';
import { quoteInsights, shadowQuote, siteVisitInsights } from './learn';
import type { Account, Business, ChatMessage, Job, LiveSettings, Quote, Run, Screen, State } from './types';
import { uid } from './util';

export const SCREENS: Screen[] = ['landing', 'business', 'jobs', 'practice', 'ready', 'account', 'live'];
const STORAGE_KEY = 'quotefolk-prototype-v1';

function emptyRun(scenarioId: string): Run {
  return {
    scenarioId,
    messages: [],
    asked: [],
    photoSent: false,
    outcome: null,
    quote: null,
    siteVisitReason: '',
    shadowCents: null,
    shadowFlag: false,
    insights: [],
    finished: false,
  };
}

export function initialState(): State {
  return {
    screen: 'landing',
    business: { tradeId: null, customTrade: '', services: [], customServices: [], name: '', area: '', radius: '25' },
    jobs: [],
    runs: SCENARIOS.map((scenario) => emptyRun(scenario.id)),
    current: 0,
    account: null,
    live: { website: '', style: 'floating', verified: false },
    nextQuoteNumber: 1041,
  };
}

export type Action =
  | { type: 'go'; screen: Screen }
  | { type: 'jump'; screen: Screen }
  | { type: 'business'; patch: Partial<Business> }
  | { type: 'pickTrade'; tradeId: string | null }
  | { type: 'toggleService'; name: string }
  | { type: 'addService'; name: string }
  | { type: 'saveJob'; job: Job }
  | { type: 'removeJob'; id: string }
  | { type: 'message'; run: number; message: ChatMessage; asked?: string[]; photoSent?: boolean }
  | { type: 'sendQuote'; run: number; quote: Omit<Quote, 'number' | 'issuedAt'> }
  | { type: 'siteVisit'; run: number; reason: string }
  | { type: 'finishRun'; run: number }
  | { type: 'editInsight'; run: number; id: string; text: string }
  | { type: 'nextRun' }
  | { type: 'account'; account: Account }
  | { type: 'live'; patch: Partial<LiveSettings> }
  | { type: 'useQuoteNumber' }
  | { type: 'reset' };

function updateRun(state: State, index: number, patch: Partial<Run>): State {
  return { ...state, runs: state.runs.map((run, i) => (i === index ? { ...run, ...patch } : run)) };
}

/** Records an owner quote on a run, with the AI's guess made before it. */
function withQuote(state: State, index: number, draft: Omit<Quote, 'number' | 'issuedAt'>): State {
  const shadow = shadowQuote(state, index);
  const quote: Quote = { ...draft, number: state.nextQuoteNumber, issuedAt: new Date().toISOString() };
  const run = state.runs[index];
  const message: ChatMessage = { id: uid('m'), from: 'owner', quote };
  const next = updateRun(state, index, {
    messages: [...run.messages, message],
    outcome: 'quote',
    quote,
    shadowCents: shadow.cents,
    shadowFlag: shadow.flag,
    insights: quoteInsights(run, quote),
  });
  return { ...next, nextQuoteNumber: state.nextQuoteNumber + 1 };
}

function withSiteVisit(state: State, index: number, reason: string): State {
  const shadow = shadowQuote(state, index);
  const run = state.runs[index];
  const message: ChatMessage = { id: uid('m'), from: 'owner', siteVisit: reason };
  return updateRun(state, index, {
    messages: [...run.messages, message],
    outcome: 'site-visit',
    siteVisitReason: reason,
    shadowCents: shadow.cents,
    shadowFlag: shadow.flag,
    insights: siteVisitInsights(run, reason),
  });
}

/** Fills whatever a screen needs so any step can be opened directly from the prototype menu. */
function ensureData(state: State, screen: Screen): State {
  const order = SCREENS.indexOf(screen);
  let next = state;
  if (order >= SCREENS.indexOf('jobs') && !next.business.tradeId && !next.business.customTrade.trim()) {
    next = { ...next, business: { ...SAMPLE_BUSINESS } };
  }
  if (order >= SCREENS.indexOf('jobs') && !next.business.name.trim()) {
    next = { ...next, business: { ...next.business, name: SAMPLE_BUSINESS.name } };
  }
  if (order >= SCREENS.indexOf('practice') && next.jobs.length === 0) {
    next = { ...next, jobs: [sampleJob(uid('job'))] };
  }
  if (order >= SCREENS.indexOf('ready')) {
    const quotes = sampleQuotes();
    next.runs.forEach((run, index) => {
      if (run.finished) return;
      const scenario = SCENARIOS[index];
      const opener: ChatMessage = { id: uid('m'), from: 'customer', text: scenario.opener, photos: [...scenario.photos] };
      const question: ChatMessage = { id: uid('m'), from: 'owner', text: 'How big is it, and when was it last cleaned?' };
      const sizeFact = scenario.facts.find((fact) => fact.key === 'size');
      const answer: ChatMessage = { id: uid('m'), from: 'customer', text: sizeFact?.answer ?? '' };
      next = updateRun(next, index, { messages: [opener, question, answer], asked: ['size', 'stains'] });
      if (scenario.id === 'priya') {
        next = withSiteVisit(
          next,
          index,
          'Loose and cracked flagstones. I want to check the base before I price repairs.',
        );
      } else {
        next = withQuote(next, index, scenario.id === 'dana' ? quotes.dana : quotes.marcus);
      }
      next = updateRun(next, index, { finished: true });
    });
    next = { ...next, current: next.runs.length - 1 };
  }
  if (order >= SCREENS.indexOf('live') && !next.account) {
    next = { ...next, account: { name: 'Maya Lopez', email: 'maya@mossandstone.com', google: false } };
  }
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'go':
      return { ...state, screen: action.screen };
    case 'jump':
      return { ...ensureData(state, action.screen), screen: action.screen };
    case 'business':
      return { ...state, business: { ...state.business, ...action.patch } };
    case 'pickTrade': {
      const trade = action.tradeId ? TRADES_BY_ID[action.tradeId] : null;
      return {
        ...state,
        business: {
          ...state.business,
          tradeId: action.tradeId,
          services: trade ? trade.services.slice(0, trade.preselect) : [],
          customServices: [],
        },
      };
    }
    case 'toggleService': {
      const has = state.business.services.includes(action.name);
      const services = has
        ? state.business.services.filter((name) => name !== action.name)
        : [...state.business.services, action.name];
      return { ...state, business: { ...state.business, services } };
    }
    case 'addService': {
      const name = action.name.trim();
      if (!name || state.business.services.includes(name)) return state;
      return {
        ...state,
        business: {
          ...state.business,
          services: [...state.business.services, name],
          customServices: [...state.business.customServices, name],
        },
      };
    }
    case 'saveJob': {
      const exists = state.jobs.some((job) => job.id === action.job.id);
      return {
        ...state,
        jobs: exists ? state.jobs.map((job) => (job.id === action.job.id ? action.job : job)) : [...state.jobs, action.job],
      };
    }
    case 'removeJob':
      return { ...state, jobs: state.jobs.filter((job) => job.id !== action.id) };
    case 'message': {
      const run = state.runs[action.run];
      return updateRun(state, action.run, {
        messages: [...run.messages, action.message],
        asked: action.asked?.length ? [...new Set([...run.asked, ...action.asked])] : run.asked,
        photoSent: action.photoSent ?? run.photoSent,
      });
    }
    case 'sendQuote':
      return withQuote(state, action.run, action.quote);
    case 'siteVisit':
      return withSiteVisit(state, action.run, action.reason);
    case 'finishRun':
      return updateRun(state, action.run, { finished: true });
    case 'editInsight': {
      const run = state.runs[action.run];
      return updateRun(state, action.run, {
        insights: run.insights.map((item) => (item.id === action.id ? { ...item, text: action.text } : item)),
      });
    }
    case 'nextRun':
      return { ...state, current: Math.min(state.current + 1, state.runs.length - 1) };
    case 'account':
      return { ...state, account: action.account };
    case 'live':
      return { ...state, live: { ...state.live, ...action.patch } };
    case 'useQuoteNumber':
      return { ...state, nextQuoteNumber: state.nextQuoteNumber + 1 };
    case 'reset':
      return initialState();
  }
}

function loadState(): State {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as State;
      if (SCREENS.includes(saved.screen) && Array.isArray(saved.runs) && saved.runs.length === SCENARIOS.length) {
        return { ...initialState(), ...saved };
      }
    }
  } catch {
    // Storage can be blocked or full; the prototype still works without it.
  }
  return initialState();
}

function startingState(): State {
  const state = loadState();
  const token = window.location.hash.replace('#', '') as Screen;
  return SCREENS.includes(token) && token !== state.screen ? reducer(state, { type: 'jump', screen: token }) : state;
}

const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, startingState);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Photos can fill local storage. Progress then lasts only until the tab closes.
    }
  }, [state]);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside StoreProvider.');
  return value;
}
