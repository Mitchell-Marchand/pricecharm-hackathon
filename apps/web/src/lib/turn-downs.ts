import { api, json } from './api';

export type TurnDownKind =
  'too_small' | 'too_big' | 'not_offered' | 'too_far' | 'lead_time' | 'other';

/** A job the owner turns down, with only the values its kind uses. */
export interface TurnDownRule {
  id: string;
  kind: TurnDownKind;
  size: number | null;
  sizeUnit: string;
  priceCents: number | null;
  distance: number | null;
  distanceUnit: 'mi' | 'km' | null;
  days: number | null;
  text: string;
  fromRunId: string | null;
  /** "Too far away" */
  reason: string;
  /** "More than about 25 mi from Austin, TX": the words the customer chat reads too. */
  line: string;
}

/** Every rule, the least they charge, and where they work, which "too far" is measured from. */
export interface TurnDowns {
  rules: TurnDownRule[];
  minimumCents: number | null;
  locations: string[];
}

export type RuleInput =
  | { kind: 'too_small'; size: number | null; sizeUnit: string | null; priceCents: number | null }
  | { kind: 'too_big'; size: number; sizeUnit: string }
  | { kind: 'not_offered'; text: string }
  | { kind: 'too_far'; distance: number; distanceUnit: 'mi' | 'km' }
  | { kind: 'lead_time'; days: number }
  | { kind: 'other'; text: string };

/** The answers to "Why not?", in the order the sheet shows them. */
export const REASONS: { kind: TurnDownKind; label: string }[] = [
  { kind: 'too_small', label: 'Too small' },
  { kind: 'too_big', label: 'Too big' },
  { kind: 'not_offered', label: 'Not something we do' },
  { kind: 'too_far', label: 'Too far away' },
  { kind: 'lead_time', label: 'Can’t fit it in' },
  { kind: 'other', label: 'Something else' },
];

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** "Turns down jobs of 200 sq ft or less", as the practice card says what it saved. */
export function turnsDown(rule: Pick<TurnDownRule, 'kind' | 'line' | 'text'>) {
  if (rule.kind === 'other') return `Turns down jobs like this: “${rule.text}”`;
  if (rule.kind === 'too_far') return `Turns down jobs ${lowerFirst(rule.line)}`;
  return `Turns down ${lowerFirst(rule.line)}`;
}

export const loadTurnDowns = () => api<TurnDowns>('/onboarding/turn-downs');
export const addTurnDown = (input: RuleInput) =>
  api<TurnDowns>('/onboarding/turn-downs', { method: 'POST', ...json(input) });
export const changeTurnDown = (id: string, input: RuleInput) =>
  api<TurnDowns>(`/onboarding/turn-downs/${id}`, { method: 'PUT', ...json(input) });
export const removeTurnDown = (id: string) =>
  api<TurnDowns>(`/onboarding/turn-downs/${id}`, { method: 'DELETE' });
/** The least they charge for any job, or null to take it off. */
export const saveMinimum = (minimumCents: number | null) =>
  api<TurnDowns>('/onboarding/minimum', { method: 'PUT', ...json({ minimumCents }) });

/** Where the owner works from, main one first. Settings only, after signup. */
export const loadLocations = () => api<{ areas: string[] }>('/app/locations');
export const saveLocations = (areas: string[]) =>
  api<{ areas: string[] }>('/app/locations', { method: 'PUT', ...json({ areas }) });
