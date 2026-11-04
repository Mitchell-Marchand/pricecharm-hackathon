import type { LanguageCode } from './languages.js';
import { TRANSLATED } from './words-translated.js';

type Values = Record<string, string | number>;

/**
 * Every fixed line a customer reads goes through here or the web chat's t(), keyed by its English.
 * `npm run words --workspace @pricecharm/api` finds those lines in the code and translates what's
 * new, once for each language in src/languages.ts, into src/words-translated.ts. Nothing is
 * translated while a customer waits. A line that isn't translated yet shows in English.
 */
export function say(language: string, english: string, values: Values = {}) {
  const line = TRANSLATED[language as LanguageCode]?.[english] ?? english;
  return line.replace(/\{(\w+)\}/g, (found, key: string) =>
    key in values ? String(values[key]) : found,
  );
}

/** What the web chat reads its lines from, for one language. */
export const wordsFor = (language: string): Record<string, string> =>
  TRANSLATED[language as LanguageCode] ?? {};
