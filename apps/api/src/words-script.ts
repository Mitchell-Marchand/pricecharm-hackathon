import 'dotenv/config';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askForTranslation } from './ai/translate.js';
import { LANGUAGES, type LanguageCode } from './languages.js';
import { ACCEPT_WORDINGS } from './live/accept-wording.js';
import { LOSS_REASONS, lossReasons, lossReasonPhrase } from './live/outcomes.js';
import { SHORT_REASONS } from './channels/whatsapp.js';
import { TRANSLATED } from './words-translated.js';

/**
 * Finds every fixed line a customer reads, which is everything the code passes to say() or t(), and
 * translates what's new into each language in src/languages.ts. Run it after changing one:
 *   npm run words --workspace @pricecharm/api
 * A line that changed gets translated again, and one that's gone is dropped.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const SOURCES = [path.join(root, 'api/src'), path.join(root, 'web/src')];
const SKIP = /words-translated\.ts$|words-script\.ts$|words\.ts$/;
const BATCH = 20;
const AT_ONCE = 6;
const ABOUT =
  'the buttons and messages of a chat that gives a customer a price for a home service job';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(name) && !SKIP.test(name) ? [file] : [];
  });

const blanks = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join();
/** A translation that kept every {blank}, which the line can't fill in otherwise. */
const fits = (line: string, translated?: string) =>
  !!translated && blanks(line) === blanks(translated);

/** The strings in the argument starting here, and where that argument ends. */
function argument(code: string, start: number) {
  const strings: string[] = [];
  let depth = 0;
  for (let at = start; at < code.length; at += 1) {
    const char = code[at];
    if (char === "'" || char === '"') {
      let end = at + 1;
      while (code[end] !== char) end += code[end] === '\\' ? 2 : 1;
      if (!depth) strings.push(code.slice(at + 1, end).replace(/\\(.)/g, '$1'));
      at = end;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      if (!depth) return { strings, end: at };
      depth -= 1;
    } else if (char === ',' && !depth) return { strings, end: at };
  }
  return { strings, end: code.length };
}

export function fixedLines() {
  const lines = new Set<string>([
    ...ACCEPT_WORDINGS.map((wording) => wording.label),
    ...Object.values(LOSS_REASONS),
    ...lossReasons.map(lossReasonPhrase),
    ...Object.values(SHORT_REASONS),
  ]);
  for (const file of SOURCES.flatMap(sourceFiles)) {
    const code = readFileSync(file, 'utf8');
    for (const call of code.matchAll(/\b(say|t)\(/g)) {
      let start = call.index + call[0].length;
      // say() takes the language first.
      if (call[1] === 'say') start = argument(code, start).end + 1;
      for (const line of argument(code, start).strings)
        if (/[A-Za-z]{2}/.test(line)) lines.add(line);
    }
  }
  return [...lines].sort();
}

async function main() {
  const lines = fixedLines();
  const only = process.argv.slice(2);
  const done: Partial<Record<LanguageCode, Record<string, string>>> = {};
  const translate = async ({ code, name }: (typeof LANGUAGES)[number]) => {
    const had = TRANSLATED[code] ?? {};
    const kept = Object.fromEntries(
      lines.flatMap((line) => (fits(line, had[line]) ? [[line, had[line]]] : [])),
    );
    const missing = only.length && !only.includes(code) ? [] : lines.filter((line) => !kept[line]);
    for (let index = 0; index < missing.length; index += BATCH) {
      const batch = missing.slice(index, index + BATCH);
      for (let attempt = 1; ; attempt += 1)
        try {
          const translated = await askForTranslation(code, batch, ABOUT, 60_000);
          batch.forEach((line, at) => {
            if (fits(line, translated[at])) kept[line] = translated[at];
          });
          if (batch.every((line) => kept[line])) break;
          throw new Error(`${name} lost a blank`);
        } catch (error) {
          if (attempt === 3) throw error;
        }
    }
    console.log(`${name}: ${missing.length} lines`);
    done[code] = Object.fromEntries(
      lines.flatMap((line) => (kept[line] ? [[line, kept[line]]] : [])),
    );
  };
  const waiting = LANGUAGES.filter((language) => language.code !== 'en');
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let next = waiting.shift(); next; next = waiting.shift()) await translate(next);
    }),
  );
  const file = path.join(here, 'words-translated.ts');
  writeFileSync(
    file,
    `import type { LanguageCode } from './languages.js';\n\n// Written by src/words-script.ts. Don't edit by hand.\nexport const TRANSLATED: Partial<Record<LanguageCode, Record<string, string>>> = ${JSON.stringify(done, null, 2)};\n`,
  );
  execFileSync('npx', ['prettier', '--write', file], { cwd: root });
  console.log(`${lines.length} lines in ${Object.keys(done).length} languages`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
