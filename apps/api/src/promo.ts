import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normalCode } from './billing.js';
import { closeDatabase, mutate, rows } from './db.js';

/**
 * Makes, ends and lists the codes owners enter before their first card for free days from it:
 *   npm run promo -- add SPRING --days 30 --uses 50 --ends 2026-12-31 --note "November outreach"
 *   npm run promo -- end SPRING
 *   npm run promo -- list
 * On the server it's node dist/promo.js with the same words.
 */
export async function addCode(input: {
  code: string;
  days: number;
  uses?: number | null;
  ends?: Date | null;
  note?: string | null;
}) {
  const code = normalCode(input.code);
  if (!/^[A-Z0-9-]{3,40}$/.test(code))
    throw new Error('A code is 3 to 40 letters, numbers or dashes.');
  if (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 365)
    throw new Error('Free days are a whole number from 1 to 365.');
  if (input.uses != null && (!Number.isSafeInteger(input.uses) || input.uses < 1))
    throw new Error('Uses are a whole number, at least 1.');
  if (input.ends && (Number.isNaN(input.ends.getTime()) || input.ends.getTime() <= Date.now()))
    throw new Error('The end date has to be a real date, after today.');
  const [existing] = await rows('SELECT code FROM promo_codes WHERE code=?', [code]);
  if (existing) throw new Error(`${code} already exists. End it, or pick another code.`);
  await mutate('INSERT INTO promo_codes(code,free_days,max_uses,ends_at,note) VALUES (?,?,?,?,?)', [
    code,
    input.days,
    input.uses ?? null,
    input.ends ?? null,
    input.note?.trim().slice(0, 200) || null,
  ]);
  return code;
}

/** Stops a code from being used from now on. Owners who already used it keep their free days. */
export async function endCode(input: string) {
  const code = normalCode(input);
  const result = await mutate(
    'UPDATE promo_codes SET ends_at=UTC_TIMESTAMP(3) WHERE code=? AND (ends_at IS NULL OR ends_at>UTC_TIMESTAMP(3))',
    [code],
  );
  if (!result.affectedRows) throw new Error(`There's no code ${code} still running.`);
  return code;
}

/**
 * Each code and how it's done: owners who used it, added a card, went live, quotes they showed,
 * and how many are still on a plan once their free days are over.
 */
export async function listCodes() {
  const found = await rows(
    `SELECT p.code,p.free_days,p.max_uses,p.ends_at,p.note,
      COUNT(b.business_id) used,
      COALESCE(SUM(b.card_added_at IS NOT NULL),0) carded,
      COALESCE(SUM(s.deployed_at IS NOT NULL),0) live,
      COALESCE(SUM(b.card_added_at IS NOT NULL AND DATE_ADD(b.card_added_at,INTERVAL b.promo_days DAY)<=UTC_TIMESTAMP(3)),0) past_free,
      COALESCE(SUM(b.card_added_at IS NOT NULL AND DATE_ADD(b.card_added_at,INTERVAL b.promo_days DAY)<=UTC_TIMESTAMP(3) AND b.subscription_status IN ('active','trialing')),0) staying,
      (SELECT COUNT(*) FROM quote_usage q JOIN billing_accounts c ON c.business_id=q.business_id
        WHERE c.promo_code=p.code AND q.charge='delivered' AND q.source IN ('live_auto','live_owner')) quotes
    FROM promo_codes p
    LEFT JOIN billing_accounts b ON b.promo_code=p.code
    LEFT JOIN businesses s ON s.id=b.business_id
    GROUP BY p.code,p.free_days,p.max_uses,p.ends_at,p.note,p.created_at
    ORDER BY p.created_at DESC`,
  );
  return found.map((row) => ({
    code: String(row.code),
    days: Number(row.free_days),
    uses: row.max_uses === null ? `${row.used}` : `${row.used} of ${row.max_uses}`,
    ends: row.ends_at ? new Date(row.ends_at).toISOString().slice(0, 10) : '',
    running:
      (!row.ends_at || new Date(row.ends_at).getTime() > Date.now()) &&
      (row.max_uses === null || Number(row.used) < Number(row.max_uses)),
    carded: Number(row.carded),
    live: Number(row.live),
    quotes: Number(row.quotes),
    staying: `${row.staying} of ${row.past_free}`,
    note: row.note ? String(row.note) : '',
  }));
}

async function main(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: 'string', default: '30' },
      uses: { type: 'string' },
      ends: { type: 'string' },
      note: { type: 'string' },
    },
  });
  const [command, code] = positionals;
  if (command === 'add' && code) {
    const added = await addCode({
      code,
      days: Number(values.days),
      uses: values.uses === undefined ? null : Number(values.uses),
      // A date alone runs to the end of that day, in UTC.
      ends: values.ends
        ? new Date(
            /^\d{4}-\d{2}-\d{2}$/.test(values.ends) ? `${values.ends}T23:59:59Z` : values.ends,
          )
        : null,
      note: values.note ?? null,
    });
    console.info(`Added ${added}: ${values.days} free days from the first card.`);
  } else if (command === 'end' && code) console.info(`Ended ${await endCode(code)}.`);
  else if (command === 'list') {
    const codes = await listCodes();
    if (codes.length) console.table(codes);
    else console.info('No codes yet.');
  } else
    throw new Error(
      'Use: add CODE [--days 30] [--uses N] [--ends YYYY-MM-DD] [--note "..."], end CODE, or list.',
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
