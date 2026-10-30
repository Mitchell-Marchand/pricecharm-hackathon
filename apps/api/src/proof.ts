import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { aiMode, aiProvider, modelFor } from './ai/index.js';
import { deleteMetaFile, uploadMetaFile } from './ai/meta-media.js';
import { measureWalkaround } from './ai/walkaround.js';
import { appEnv } from './config.js';
import { closeDatabase, rows } from './db.js';
import { json } from './models.js';
import { pooledChat } from './channels/pooled.js';
import { compareDraft } from './pricing/accuracy.js';
import { median } from './pricing/rates.js';
import { canonicalUnit } from './pricing/units.js';
import { gapPercent, quoteTotal, type DraftedQuote, type Quote } from './practice/types.js';
import {
  liveCases,
  practiceCases,
  replayCharm,
  replayGeneric,
  type ReplayResult,
} from './replay.js';

/**
 * The numbers behind "it prices like you": how close the Charm lands to what owners charge, how
 * that compares with the same AI when it doesn't know the owner's prices, and how well SAM counts
 * what's in a video. Marketing quotes only this report, and it won't give a percentage from a
 * handful of jobs.
 *
 *   npm run proof --workspace @pricecharm/api                  drafts owners checked (free)
 *     -- --replay [--limit 20] [--model <id>]                 replay against a generic AI (two model calls a job)
 *     -- --videos <folder>                                    SAM counts against hand counts (Meta only)
 *     -- --business <id>  or  --skip <id,id>                  which businesses count
 *     -- --json <file>                                        also save the numbers
 *
 * On the server, run `npm run proof:production` with the same options. It prints business names
 * and numbers, never customer details.
 */

/** Fewer jobs than this and the report gives counts, not a percentage. */
export const MIN_SAMPLE = 20;

type Gapped = { gap: number | null };

/** How close drafts came to the owner's price. A job with no AI price counts as a miss. */
export function accuracy(items: Gapped[]) {
  const gaps = items.flatMap((item) => (item.gap === null ? [] : [item.gap]));
  return {
    jobs: items.length,
    priced: gaps.length,
    within10: gaps.filter((gap) => gap <= 10).length,
    within15: gaps.filter((gap) => gap <= 15).length,
    medianGap: gaps.length ? Math.round(median(gaps)) : null,
  };
}

/** "17 of 20 (85%)", or just "3 of 4" when there are too few for a percentage to mean much. */
export function share(count: number, of: number) {
  return of >= MIN_SAMPLE
    ? `${count} of ${of} (${Math.round((count / of) * 100)}%)`
    : `${count} of ${of}`;
}

/** How far a replayed draft's lines were from the owner's price, whatever it decided. */
export function bestPrice(result: ReplayResult): Gapped {
  return {
    gap:
      result.linesCents && result.ownerCents
        ? gapPercent(result.linesCents, result.ownerCents)
        : null,
  };
}

/** On how many jobs the owner's Charm came closer than the generic AI, both against the owner. */
export function closer(pairs: { charm: Gapped; generic: Gapped }[]) {
  let charm = 0,
    generic = 0,
    tied = 0;
  for (const pair of pairs) {
    const own = pair.charm.gap ?? Infinity,
      other = pair.generic.gap ?? Infinity;
    if (own < other) charm++;
    else if (other < own) generic++;
    else tied++;
  }
  return { charm, generic, tied };
}

/** How a counter did against hand counts. Not finding the thing at all counts as zero. */
export function countAccuracy(items: { truth: number; counted: number | null }[]) {
  const misses = items.map((item) => Math.abs((item.counted ?? 0) - item.truth));
  const percents = items.flatMap((item, index) =>
    item.truth > 0 ? [(misses[index] / item.truth) * 100] : [],
  );
  return {
    videos: items.length,
    exact: misses.filter((miss) => miss === 0).length,
    withinOne: misses.filter((miss) => miss <= 1).length,
    averageMissPercent: percents.length
      ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length)
      : null,
  };
}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

type Business = { id: string; name: string; status: string };

async function businessesInScope(): Promise<Business[]> {
  const only = option('business');
  const skip = new Set((option('skip') ?? '').split(',').filter(Boolean));
  const found = await rows(
    `SELECT id,name,status FROM businesses WHERE status IN ('draft','active') AND deletion_requested_at IS NULL${only ? ' AND id=?' : ''} ORDER BY created_at`,
    only ? [only] : [],
  );
  return found
    .map((row) => ({
      id: String(row.id),
      name: String(row.name || ''),
      status: String(row.status),
    }))
    .filter((business) => !skip.has(business.id));
}

const label = (business: Business) =>
  `${business.name || 'Unnamed'} (${business.id.slice(0, 8)}${business.status === 'draft' ? ', still in setup' : ''})`;

function accuracyLines(items: Gapped[]) {
  const stats = accuracy(items);
  if (!stats.jobs) return ['  None yet.'];
  return [
    `  Within 10%: ${share(stats.within10, stats.jobs)}`,
    `  Within 15%: ${share(stats.within15, stats.jobs)}`,
    `  Median gap: ${stats.medianGap === null ? '-' : `${stats.medianGap}%`}${stats.priced < stats.jobs ? ` (${stats.jobs - stats.priced} with no AI price, counted as misses)` : ''}`,
  ];
}

/**
 * Drafts the Charm made before the owner priced the job, against what the owner then charged.
 * Nothing is re-run: these are the drafts as they were at the time.
 */
async function checkedDrafts(businesses: Business[]) {
  const live: (Gapped & { businessId: string })[] = [];
  const practice: (Gapped & { businessId: string })[] = [];
  for (const business of businesses) {
    const quotes = await rows(
      `SELECT q.draft_json,q.quote_json FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
       WHERE q.business_id=? AND q.sent_by='owner' AND ${pooledChat('c')}
         AND q.status IN ('sent','accepted','visit_requested','lost','expired')`,
      [business.id],
    );
    for (const quote of quotes)
      live.push({
        businessId: business.id,
        ...compareDraft(
          json<DraftedQuote | null>(quote.draft_json, null),
          quoteTotal(
            json<Quote>(quote.quote_json, { lines: [], discount: null } as unknown as Quote),
          ),
        ),
      });
    // Practice customers the owner priced, against the guess the AI made before they did.
    const runs = await rows(
      "SELECT shadow_json,quote_json FROM practice_runs WHERE business_id=? AND status='finished' AND outcome<>'site_visit' AND shadow_json IS NOT NULL AND quote_json IS NOT NULL",
      [business.id],
    );
    for (const run of runs)
      practice.push({
        businessId: business.id,
        ...compareDraft(
          json<DraftedQuote | null>(run.shadow_json, null),
          quoteTotal(
            json<Quote>(run.quote_json, { lines: [], discount: null } as unknown as Quote),
          ),
        ),
      });
  }
  return { live, practice };
}

type Paired = { businessId: string; charm: ReplayResult; generic: ReplayResult | null };

/** Every job an owner priced, drafted again by their Charm and by the generic AI side by side. */
async function replayAll(businesses: Business[], limit: number, model: string | undefined) {
  const generic = aiMode !== 'demo';
  const paired: Paired[] = [];
  let failed = 0;
  for (const business of businesses) {
    const jobs = [
      ...(await liveCases(business.id, limit)),
      ...(await practiceCases(business.id, limit)),
    ].filter((job) => job.ownerCents !== null);
    for (const job of jobs) {
      try {
        const [charm, other] = await Promise.all([
          replayCharm(job, model),
          generic ? replayGeneric(job, model) : null,
        ]);
        paired.push({ businessId: business.id, charm, generic: other });
      } catch (error) {
        failed++;
        console.error(
          `  ${label(business)} ${job.kind} #${job.number} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return { paired, failed, generic };
}

const videoSchema = z.object({
  file: z.string().min(1),
  /** The trade, in words: "window cleaning". */
  trade: z.string().min(1).default('window cleaning'),
  service: z.string().min(1).default('Window cleaning'),
  /** Hand counts: { "windows": 19 }. */
  counts: z.record(z.string().min(1), z.number().int().min(0)),
});
const manifestSchema = z.array(videoSchema).min(1);

type VideoRow = {
  file: string;
  label: string;
  truth: number;
  sam: number | null;
  spark: number | null;
};

/**
 * Runs each hand-counted video through the same measuring customers' videos go through, and
 * compares what SAM counted, and what Muse Spark counted watching it, with the hand count.
 * The folder holds the videos and a counts.json listing them.
 */
async function measureVideos(folder: string) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(folder, 'counts.json'), 'utf8')),
  );
  const results: VideoRow[] = [];
  const failures: string[] = [];
  for (const video of manifest) {
    const extension = path.extname(video.file).toLowerCase();
    const mimeType =
      extension === '.mov' ? 'video/quicktime' : extension === '.mp4' ? 'video/mp4' : null;
    if (!mimeType) {
      failures.push(`${video.file}: only .mp4 and .mov videos are measured`);
      continue;
    }
    let fileId = '';
    try {
      const bytes = await readFile(path.join(folder, video.file));
      fileId = await uploadMetaFile(bytes, path.basename(video.file), mimeType);
      const units = Object.keys(video.counts).map(
        (name) => canonicalUnit(name) ?? name.toLowerCase(),
      );
      const measured = await measureWalkaround({
        business: { name: 'PriceCharm benchmark', trade: video.trade, services: [video.service] },
        serviceName: video.service,
        priceUnits: { [video.service.toLowerCase()]: units },
        videoFileId: fileId,
        // No stills, so nothing gets drawn: only the counts matter here.
        frames: [],
        durationMs: null,
        saveOverlay: async () => '',
      });
      for (const [name, truth] of Object.entries(video.counts)) {
        const unit = canonicalUnit(name) ?? name.toLowerCase();
        const found = measured.counts.find(
          (item) => item.unit === unit || item.label.toLowerCase() === name.toLowerCase(),
        );
        results.push({
          file: video.file,
          label: name,
          truth,
          sam: found ? found.count : null,
          spark: found ? found.sparkCount : null,
        });
      }
    } catch (error) {
      failures.push(`${video.file}: ${error instanceof Error ? error.message : error}`);
    } finally {
      if (fileId) await deleteMetaFile(fileId).catch(() => {});
    }
  }
  return { results, failures };
}

function countLines(name: string, items: { truth: number; counted: number | null }[]) {
  const stats = countAccuracy(items);
  return [
    `  ${name}: exact on ${share(stats.exact, stats.videos)}, within one on ${share(stats.withinOne, stats.videos)}, average miss ${stats.averageMissPercent === null ? '-' : `${stats.averageMissPercent}%`}`,
  ];
}

async function main() {
  const limit = Math.min(Math.max(Number(option('limit') ?? 20) || 20, 1), 200);
  const model = option('model');
  const folder = option('videos');
  const businesses = await businessesInScope();
  const out: string[] = [];
  const saved: Record<string, unknown> = { generatedAt: new Date().toISOString(), env: appEnv() };
  out.push(`PriceCharm proof report, ${new Date().toISOString().slice(0, 10)} (${appEnv()})`);
  out.push(
    `Percentages need at least ${MIN_SAMPLE} jobs or videos; below that it gives counts only.`,
  );

  // 1. Drafts owners checked.
  const checked = await checkedDrafts(businesses);
  saved.checked = { live: accuracy(checked.live), practice: accuracy(checked.practice) };
  out.push(
    '',
    '1. Drafts owners checked',
    'The Charm’s draft, made before the owner priced the job, against what the owner charged.',
    `Real customers, quotes the owner reviewed before sending (${checked.live.length}):`,
    ...accuracyLines(checked.live),
    `Practice customers the owner priced, against the AI’s guess before they did (${checked.practice.length}). The first guesses come before it has any of the owner’s prices, so section 2 is the fairer test:`,
    ...accuracyLines(checked.practice),
  );
  const counted = new Map<string, number>();
  for (const item of [...checked.live, ...checked.practice])
    counted.set(item.businessId, (counted.get(item.businessId) ?? 0) + 1);
  if (counted.size) {
    out.push('By business (use --skip with the ids of your own test accounts):');
    for (const business of businesses) {
      const jobs = counted.get(business.id) ?? 0;
      if (jobs)
        out.push(`  ${label(business)}: ${jobs} ${jobs === 1 ? 'job' : 'jobs'}  ${business.id}`);
    }
  }

  // 2. Replay against a generic AI.
  if (process.argv.includes('--replay')) {
    const engine =
      aiMode === 'demo'
        ? 'the rate card alone (AI_PROVIDER=demo)'
        : `${aiProvider} ${model ?? modelFor('draft_quote')}`;
    console.info(
      `Replaying with ${engine}.${aiMode === 'demo' ? '' : ' This calls the model twice for each job.'}`,
    );
    const { paired, failed, generic } = await replayAll(businesses, limit, model);
    // Both are held to their best price. The Charm may say the owner should see a job first and
    // still give its lines, while the generic AI always prices, so a visit isn't counted against it.
    const charm = paired.map((pair) => bestPrice(pair.charm));
    const others = paired.flatMap((pair) => (pair.generic ? [bestPrice(pair.generic)] : []));
    const visits = paired.filter((pair) => pair.charm.decision === 'site_visit').length;
    out.push(
      '',
      '2. Your prices against a generic AI',
      `Every job an owner priced (up to ${limit} real and ${limit} practice per business), drafted again two ways with ${engine}: by the owner’s Charm, from only what the business had taught it before that job, and by the same AI with none of the owner’s prices. Each is held to its best price.`,
      `The owner’s Charm (${charm.length}):`,
      ...accuracyLines(charm),
      ...(visits
        ? [
            `  It would have asked the owner to see ${visits} of these first, which sends the quote to the owner instead of the customer.`,
          ]
        : []),
    );
    if (generic) {
      const pairs = paired.flatMap((pair) =>
        pair.generic ? [{ charm: bestPrice(pair.charm), generic: bestPrice(pair.generic) }] : [],
      );
      const wins = closer(pairs);
      out.push(
        `Generic AI (${others.length}):`,
        ...accuracyLines(others),
        `Closer to the owner’s price: the Charm on ${share(wins.charm, pairs.length)}, the generic AI on ${share(wins.generic, pairs.length)}${wins.tied ? `, tied on ${wins.tied}` : ''}.`,
      );
      saved.replay = {
        engine,
        charm: accuracy(charm),
        generic: accuracy(others),
        closer: wins,
        visits,
        failed,
      };
    } else {
      out.push('The generic AI needs a live model, so it was skipped.');
      saved.replay = { engine, charm: accuracy(charm), visits, failed };
    }
    if (failed) out.push(`${failed} jobs couldn’t be replayed (see above) and aren’t counted.`);
  }

  // 3. SAM against hand counts.
  if (folder) {
    out.push('', '3. Counting from video');
    if (aiProvider !== 'meta')
      out.push('Needs Meta’s models (AI_PROVIDER=meta), so it was skipped.');
    else {
      console.info(`Measuring the videos in ${folder}.`);
      const { results, failures } = await measureVideos(folder);
      out.push(
        `Each video measured the way customers’ videos are (${modelFor('read_walkaround')} picks what to count, SAM 3.1 counts it), against a hand count (${results.length} counts):`,
        ...countLines(
          'SAM 3.1',
          results.map((row) => ({ truth: row.truth, counted: row.sam })),
        ),
        ...countLines(
          `${modelFor('read_walkaround')} watching it`,
          results.map((row) => ({ truth: row.truth, counted: row.spark })),
        ),
        ...results.map(
          (row) =>
            `    ${row.file} ${row.label}: hand ${row.truth}, SAM ${row.sam ?? 'not counted'}, Spark ${row.spark ?? 'not counted'}`,
        ),
        ...failures.map((failure) => `  Couldn’t measure ${failure}`),
      );
      saved.videos = {
        sam: countAccuracy(results.map((row) => ({ truth: row.truth, counted: row.sam }))),
        spark: countAccuracy(results.map((row) => ({ truth: row.truth, counted: row.spark }))),
        rows: results,
        failures,
      };
    }
  }

  console.info(out.join('\n'));
  const file = option('json');
  if (file) {
    await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
    console.info(`\nSaved to ${file}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error('The proof report failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
