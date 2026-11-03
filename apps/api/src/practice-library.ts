import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TRADES_BY_ID } from '@pricecharm/trades';
import { aiMode, aiProvider, runWithAiUsage } from './ai/index.js';
import { closeDatabase, rows } from './db.js';
import { buildLibraryEntry, LIBRARY_POSITIONS } from './practice/library.js';

/**
 * Builds the checked library of setup's first practice customers for one trade
 * (src/practice/library.ts): writes each one, makes its photos, reads them and squares the facts
 * with what was read.
 *
 *   npm run practice-library -- --trade window-cleaning --spend
 *   npm run practice-library -- --trade window-cleaning --position 2 --replace --spend
 *
 * It calls paid image and AI models, about 3 images, a scenario and a photo reading per customer,
 * so it won't run without --spend. With AI_PROVIDER=demo nothing is spent and it builds demo
 * mode's customers. Slots that are already filled are left alone unless --replace is given.
 */

/** Why it won't run: it would spend on paid models without being told to. Null when it may. */
export function spendRefusal(mode: 'live' | 'demo', spend: boolean, customers: number) {
  if (mode === 'demo' || spend) return null;
  return `This makes about ${customers * 3} images and ${customers * 3} model calls on ${aiProvider}, which costs credits. Run it again with --spend to go ahead.`;
}

export async function buildLibrary(input: {
  trade: string;
  positions: number[];
  spend: boolean;
  replace: boolean;
  log?: (line: string) => void;
}) {
  const log = input.log ?? console.info;
  if (!TRADES_BY_ID[input.trade]) throw new Error(`There's no trade called ${input.trade}.`);
  const refusal = spendRefusal(aiMode, input.spend, input.positions.length);
  if (refusal) throw new Error(refusal);
  const filled = new Set(
    (await rows('SELECT position FROM practice_library WHERE trade_id=?', [input.trade])).map(
      (row) => Number(row.position),
    ),
  );
  const tokens = { calls: 0, input: 0, output: 0 };
  const built: number[] = [];
  for (const position of input.positions) {
    if (filled.has(position) && !input.replace) {
      log(`Customer ${position + 1} is already in the library. Use --replace to make it again.`);
      continue;
    }
    await runWithAiUsage(
      {
        businessId: `library:${input.trade}`,
        record: async (usage) => {
          tokens.calls++;
          tokens.input += usage.inputTokens;
          tokens.output += usage.outputTokens;
        },
      },
      () => buildLibraryEntry(input.trade, position, log),
    );
    built.push(position);
  }
  if (aiMode !== 'demo')
    log(
      `Done: ${tokens.calls} model calls, ${tokens.input} input and ${tokens.output} output tokens.`,
    );
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      trade: { type: 'string' },
      position: { type: 'string', multiple: true },
      spend: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
    },
  });
  const positions = values.position?.length
    ? values.position.map((value) => Number(value) - 1)
    : Array.from({ length: LIBRARY_POSITIONS }, (_, index) => index);
  Promise.resolve()
    .then(() => {
      if (!values.trade)
        throw new Error('Usage: npm run practice-library -- --trade <trade id> --spend');
      if (positions.some((position) => !(position >= 0 && position < LIBRARY_POSITIONS)))
        throw new Error(`--position is 1 to ${LIBRARY_POSITIONS}.`);
      return buildLibrary({
        trade: values.trade,
        positions,
        spend: values.spend ?? false,
        replace: values.replace ?? false,
      });
    })
    .then(() => closeDatabase())
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await closeDatabase();
      process.exitCode = 1;
    });
}
