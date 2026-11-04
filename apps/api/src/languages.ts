import type { Row } from './models.js';

/**
 * The languages an owner can offer. The Charm answers in whatever a customer writes, but these are
 * the ones with their fixed words translated (src/words.ts), so a whole chat reads that way.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'ur', name: 'Urdu', native: 'اردو', rtl: true },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'tl', name: 'Tagalog', native: 'Tagalog' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'pcm', name: 'Nigerian Pidgin', native: 'Naijá' },
  { code: 'ha', name: 'Hausa', native: 'Hausa' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá' },
  { code: 'ig', name: 'Igbo', native: 'Igbo' },
  { code: 'zu', name: 'Zulu', native: 'isiZulu' },
] as const satisfies readonly {
  code: string;
  name: string;
  native: string;
  rtl?: boolean;
}[];

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code) as [
  LanguageCode,
  ...LanguageCode[],
];

const known = (code: unknown): code is LanguageCode =>
  LANGUAGE_CODES.includes(String(code) as LanguageCode);

/** The English name of a language, which is how the AI is told about it. */
export const languageName = (code: string) =>
  LANGUAGES.find((language) => language.code === code)?.name ?? 'English';

/** The language a business talks to customers in by default. */
export const businessLanguage = (business: Record<string, unknown>): LanguageCode =>
  known(business.language) ? business.language : 'en';

/** What a customer can pick from: the default first, then the others the owner offers. */
export function offeredLanguages(business: Row): LanguageCode[] {
  const saved = business.languages_json;
  const others: unknown[] = Array.isArray(saved)
    ? saved
    : typeof saved === 'string'
      ? (JSON.parse(saved) as unknown[])
      : [];
  return [...new Set([businessLanguage(business), ...others.filter(known)])];
}

/** The language a chat is in: what the customer picked or writes in, or the business's default. */
export const chatLanguage = (
  business: Record<string, unknown>,
  chat: Record<string, unknown>,
): LanguageCode => (known(chat.language) ? chat.language : businessLanguage(business));

export const isLanguage = known;
