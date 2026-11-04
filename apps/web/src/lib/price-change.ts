import { api, json } from './api';

/** Something the owner told their Charm about their prices for now. */
export interface PriceChange {
  /** Above zero is higher. */
  percent: number;
  endsAt: string | null;
  /** "Quotes are 20% higher through Nov 30." */
  words: string;
}

export type Until = 'week' | 'month' | 'open' | string;

export interface PriceChangeRead {
  changesPrices: boolean;
  direction: 'up' | 'down' | null;
  percent: number | null;
  lasts: 'week' | 'month' | null;
}

export const loadPriceChange = () => api<{ change: PriceChange | null }>('/app/price-change');
export const readPriceChange = (text: string) =>
  api<PriceChangeRead>('/app/price-change/read', { method: 'POST', ...json({ text }) });
export const setPriceChange = (input: { percent: number; until: Until; words: string }) =>
  api<{ change: PriceChange | null }>('/app/price-change', { method: 'POST', ...json(input) });
export const endPriceChange = () =>
  api<{ change: PriceChange | null }>('/app/price-change', { method: 'DELETE' });
