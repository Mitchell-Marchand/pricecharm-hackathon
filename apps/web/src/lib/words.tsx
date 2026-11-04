'use client';

import { createContext, useContext } from 'react';

type Values = Record<string, string | number>;
/** A customer-facing line, by its English, in the language the chat is in. */
export type Say = (english: string, values?: Values) => string;
/** A language's fixed lines, by their English (src/words.ts in the API). */
export type Words = Record<string, string>;

export const sayFrom =
  (words: Words): Say =>
  (english, values = {}) =>
    (words[english] ?? english).replace(/\{(\w+)\}/g, (found, key: string) =>
      key in values ? String(values[key]) : found,
    );

const RIGHT_TO_LEFT = ['ar', 'ur'];
export const isRightToLeft = (language: string) => RIGHT_TO_LEFT.includes(language);

type Shown = { t: Say; language: string };
const WordsContext = createContext<Shown>({ t: sayFrom({}), language: 'en' });

export const WordsProvider = WordsContext.Provider;
/** English until something above sets a language, so these work outside the customer chat too. */
export const useWords = () => useContext(WordsContext);
