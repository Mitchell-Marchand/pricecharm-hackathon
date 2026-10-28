import { api, json } from './api';

/** One question the customer chat asks. */
export interface CharmQuestion {
  id: string;
  text: string;
  /** The photo request is always first, and the chat asks for photos either way, so it stays. */
  source: 'photos' | 'owner' | 'practice';
}

/** A service's rate, the one its drafts are held to. */
export interface ServiceRate {
  service: string;
  /** "About $25 per window, lowest $100". Empty until it has prices with a size. */
  price: string;
  /** "From 1 past job and 3 practice quotes, 10 to 24 windows" */
  basis: string;
}

/** Something about their prices every draft follows: the owner's own, or a practice correction. */
export interface PriceNote {
  id: string;
  text: string;
  source: 'owner' | 'practice';
}

/** What the Charm knows, as the owner can change it. */
export interface Knows {
  questions: CharmQuestion[];
  rates: ServiceRate[];
  notes: PriceNote[];
}

const at = (kind: 'questions' | 'notes', id?: string) =>
  `/onboarding/knows/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`;

export const loadKnows = () => api<Knows>('/onboarding/knows');
export const addQuestion = (text: string) =>
  api<Knows>(at('questions'), { method: 'POST', ...json({ text }) });
export const editQuestion = (id: string, text: string) =>
  api<Knows>(at('questions', id), { method: 'PUT', ...json({ text }) });
export const removeQuestion = (id: string) => api<Knows>(at('questions', id), { method: 'DELETE' });
export const addNote = (text: string) =>
  api<Knows>(at('notes'), { method: 'POST', ...json({ text }) });
export const editNote = (id: string, text: string) =>
  api<Knows>(at('notes', id), { method: 'PUT', ...json({ text }) });
export const removeNote = (id: string) => api<Knows>(at('notes', id), { method: 'DELETE' });
