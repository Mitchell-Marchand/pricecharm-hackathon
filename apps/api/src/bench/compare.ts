import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gapPercent } from '../practice/types.js';
import {
  asPercent as asShare,
  asPoints,
  closeness,
  ownerInterval,
  pricingShape,
} from './metrics.js';
import { seeded, type SimJob, type SimOwner } from './owners.js';

/**
 * Compares two benchmark runs on the same jobs: job by job, how many the change fixed and how many
 * it broke, with an exact McNemar test on those two counts, and owner by owner, since one owner's
 * jobs tend to move together. Runs pair by seed; within a seed the same owners price the same jobs
 * in the same order, so two runs of one seed can be lined up job for job.
 *
 *   npm run bench:compare --workspace @pricecharm/api -- old.json new.json [--path charm]
 *   npm run bench:compare --workspace @pricecharm/api -- --old a.json,b.json --new c.json,d.json
 */

/** A run as the benchmark saves it with --json. */
export type SavedRun = {
  seed: number;
  engine?: string;
  owners: SimOwner[];
  tests: {
    owner: number;
    job: SimJob;
    ownerCents: number;
    charm?: Record<string, { cents: number | null } | undefined>;
    generic?: { cents: number | null };
    formula?: { cents: number | null };
    /** What the owner's quotes never showed for this job, when the run recorded it. */
    gaps?: string[];
    failed?: string;
  }[];
};

/** Which price a run is judged on: formula pricing, the Charm's usual draft, or the generic AI. */
export type PricePath = 'formula' | 'charm' | 'generic';

function priceOf(test: SavedRun['tests'][number], path: PricePath) {
  if (path === 'formula') return test.formula?.cents ?? null;
  if (path === 'charm') return test.charm?.full?.cents ?? null;
  return test.generic?.cents ?? null;
}

const within10 = (cents: number | null, ownerCents: number) => {
  const gap = cents ? gapPercent(cents, ownerCents) : null;
  return gap !== null && gap <= 10;
};

/**
 * The chance of a split at least this lopsided between jobs fixed and jobs broken if the change
 * did nothing: the exact two-sided McNemar test. Worked in logs so big counts don't overflow.
 */
export function mcnemarP(fixed: number, broke: number) {
  const n = fixed + broke;
  if (!n) return 1;
  const terms: number[] = [];
  let logChoose = 0;
  for (let k = 0; k <= Math.min(fixed, broke); k++) {
    if (k) logChoose += Math.log(n - k + 1) - Math.log(k);
    terms.push(logChoose - n * Math.LN2);
  }
  const top = Math.max(...terms);
  const tail = Math.exp(top) * terms.reduce((sum, term) => sum + Math.exp(term - top), 0);
  return Math.min(1, 2 * tail);
}

type Pair = {
  seed: number;
  owner: number;
  trade: string;
  pricing: string;
  /** Whether the owner's quotes showed everything the job needed, when the run recorded it. */
  cause: string;
  ownerCents: number;
  oldCents: number | null;
  newCents: number | null;
  old: boolean;
  new: boolean;
};

/** Lines two runs of each seed up job for job, refusing runs that didn't price the same jobs. */
export function pairRuns(olds: SavedRun[], news: SavedRun[], path: PricePath) {
  const pairs: Pair[] = [];
  let failed = 0;
  const seeds: number[] = [];
  for (const before of olds) {
    const after = news.find((run) => run.seed === before.seed);
    if (!after) continue;
    seeds.push(before.seed);
    if (before.tests.length !== after.tests.length)
      throw new Error(`Seed ${before.seed}'s runs priced different numbers of jobs.`);
    for (const [index, old] of before.tests.entries()) {
      const next = after.tests[index];
      if (
        old.owner !== next.owner ||
        old.ownerCents !== next.ownerCents ||
        JSON.stringify(old.job) !== JSON.stringify(next.job)
      )
        throw new Error(
          `Seed ${before.seed}'s runs didn't price the same jobs (job ${index + 1} differs). Compare runs of one seed with the same owners, tests and --messy setting.`,
        );
      if (old.failed || next.failed) {
        failed++;
        continue;
      }
      const owner = after.owners[next.owner];
      const gaps = next.gaps ?? old.gaps;
      pairs.push({
        seed: before.seed,
        owner: next.owner,
        trade: owner.trade,
        pricing: pricingShape(owner, next.job.service),
        cause: !gaps
          ? 'not recorded'
          : gaps.length
            ? 'Something it needed never was in the owner’s quotes'
            : 'Everything it needed was in the owner’s quotes',
        ownerCents: next.ownerCents,
        oldCents: priceOf(old, path),
        newCents: priceOf(next, path),
        old: within10(priceOf(old, path), old.ownerCents),
        new: within10(priceOf(next, path), next.ownerCents),
      });
    }
  }
  if (!pairs.length)
    throw new Error('No seed is in both lists of runs, so there is nothing to pair.');
  return { pairs, failed, seeds };
}

/** Within 10% before and after, and what changed, for a set of paired jobs. */
export function tally(pairs: Pair[]) {
  const fixed = pairs.filter((pair) => pair.new && !pair.old).length;
  const broke = pairs.filter((pair) => pair.old && !pair.new).length;
  return {
    jobs: pairs.length,
    old: pairs.filter((pair) => pair.old).length,
    new: pairs.filter((pair) => pair.new).length,
    fixed,
    broke,
    p: mcnemarP(fixed, broke),
  };
}

/** Owners whose jobs came out better, worse or the same. */
export function ownerMoves(pairs: Pair[]) {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const key = `${pair.seed}:${pair.owner}`;
    counts.set(key, (counts.get(key) ?? 0) + Number(pair.new) - Number(pair.old));
  }
  const moves = [...counts.values()];
  return {
    better: moves.filter((move) => move > 0).length,
    worse: moves.filter((move) => move < 0).length,
    same: moves.filter((move) => move === 0).length,
  };
}

/**
 * The range the new run's share within 10% would likely fall in on other owners: owners are
 * drawn again with replacement, many times, keeping each owner's jobs together.
 */
export function ownerRange(pairs: Pair[], draws = 2000) {
  const byOwner = new Map<string, boolean[]>();
  for (const pair of pairs) {
    const key = `${pair.seed}:${pair.owner}`;
    byOwner.set(key, [...(byOwner.get(key) ?? []), pair.new]);
  }
  const groups = [...byOwner.values()];
  const random = seeded(groups.length * 7919 + pairs.length);
  const shares: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    let hits = 0,
      jobs = 0;
    for (let n = 0; n < groups.length; n++) {
      const group = groups[Math.floor(random() * groups.length)];
      hits += group.filter(Boolean).length;
      jobs += group.length;
    }
    shares.push(hits / jobs);
  }
  shares.sort((a, b) => a - b);
  return { low: shares[Math.floor(draws * 0.025)], high: shares[Math.floor(draws * 0.975)] };
}

const asPercent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const percent = (count: number, of: number) => asPercent(count / of);
const pValue = (p: number) => (p < 0.0001 ? p.toExponential(1) : p.toFixed(p < 0.01 ? 4 : 2));

const before = (pairs: Pair[]) =>
  closeness(pairs.map((pair) => ({ cents: pair.oldCents, ownerCents: pair.ownerCents })));
const after = (pairs: Pair[]) =>
  closeness(pairs.map((pair) => ({ cents: pair.newCents, ownerCents: pair.ownerCents })));
const ownerKey = (pair: Pair) => `${pair.seed}:${pair.owner}`;

/**
 * How within 10% and the mean miss moved on these jobs, with the range each move would likely fall
 * in on other owners, resampling owners with their jobs kept together.
 */
export function moves(pairs: Pair[], level = 0.95) {
  const within = ownerInterval(
    pairs,
    ownerKey,
    (sample) => after(sample).within10 - before(sample).within10,
    2000,
    level,
  );
  const mean = ownerInterval(
    pairs,
    ownerKey,
    (sample) => after(sample).mean - before(sample).mean,
    2000,
    level,
  );
  const old = before(pairs),
    next = after(pairs);
  return {
    old,
    next,
    within: { change: next.within10 - old.within10, ...within },
    mean: { change: next.mean - old.mean, ...mean },
    // Better or worse past what chance would do: the whole range on one side of no change.
    better: within.low > 0 || mean.high < 0,
    worse: within.high < 0 || mean.low > 0,
  };
}

/** A trade, pricing shape or kind of job needs this many owners before it can be judged alone. */
const GROUP_OWNERS = 8;

/**
 * Whether one trade, pricing shape or kind of job got clearly worse. With twenty-odd of them, one
 * would look worse at the usual 95% by chance alone, as two runs of the same code showed (seed 16,
 * November 2026), so each is held to more: McNemar on its own jobs, or its mean miss up past a 99%
 * range, and only with enough owners for a range to mean anything.
 */
function groupWorse(subset: Pair[]) {
  if (new Set(subset.map(ownerKey)).size < GROUP_OWNERS) return false;
  const counts = tally(subset);
  return (counts.p < 0.05 && counts.broke > counts.fixed) || moves(subset, 0.99).mean.low > 0;
}

/**
 * Whether to keep a change. Keep it when within 10% or the mean miss got better past what chance
 * would do (or McNemar says the jobs it fixed outweigh the ones it broke), neither got worse, and
 * no trade, pricing shape or kind of job got clearly worse. Drop it when either got clearly worse.
 * Otherwise there isn't the evidence to tell. Two runs of the same code on one seed, which differ
 * only in what the model answered, come out as no clear difference.
 */
export function verdict(pairs: Pair[]) {
  const all = moves(pairs);
  const counts = tally(pairs);
  const better = all.better || (counts.p < 0.05 && counts.fixed > counts.broke);
  const worse = all.worse || (counts.p < 0.05 && counts.broke > counts.fixed);
  const regressed = (['trade', 'pricing', 'cause'] as const).flatMap((key) =>
    [...new Set(pairs.map((pair) => pair[key]))].filter((value) =>
      groupWorse(pairs.filter((pair) => pair[key] === value)),
    ),
  );
  const decision = worse
    ? 'Drop it: it’s worse.'
    : better && !regressed.length
      ? 'Keep it: it’s better, and nothing got clearly worse.'
      : better
        ? `Look closer: it’s better overall but clearly worse on ${regressed.join(', ')}.`
        : regressed.length
          ? `Drop it: no better overall, and clearly worse on ${regressed.join(', ')}.`
          : 'No clear difference: what moved is within what chance would do.';
  return { decision, regressed, all, counts };
}

const signed = (value: number, format: (value: number) => string) =>
  `${value >= 0 ? '+' : '−'}${format(Math.abs(value))}`;

/** The comparison, as the lines the command prints. */
export function describeComparison(olds: SavedRun[], news: SavedRun[], path: PricePath) {
  const { pairs, failed, seeds } = pairRuns(olds, news, path);
  const all = tally(pairs);
  const people = ownerMoves(pairs);
  const range = ownerRange(pairs);
  const { decision, all: moved } = verdict(pairs);
  const line = (label: string, subset: Pair[]) => {
    const stats = tally(subset);
    const m = moves(subset);
    return `  ${label} (${stats.jobs} jobs): within 10% ${percent(stats.old, stats.jobs)} → ${percent(stats.new, stats.jobs)} (fixed ${stats.fixed}, broke ${stats.broke}), mean miss ${asPoints(m.old.mean)} → ${asPoints(m.next.mean)}${groupWorse(subset) ? ' — clearly worse' : ''}`;
  };
  const groups = (key: 'trade' | 'pricing' | 'cause') =>
    [...new Set(pairs.map((pair) => pair[key]))].sort().map((value) =>
      line(
        value,
        pairs.filter((pair) => pair[key] === value),
      ),
    );
  const measure = (label: string, old: number, next: number, format: (value: number) => string) =>
    `  ${label}: ${format(old)} → ${format(next)}`;
  return [
    `Comparing ${path} pricing on seed${seeds.length > 1 ? 's' : ''} ${seeds.join(', ')}: ${all.jobs} jobs priced in both runs.`,
    measure('Within 10%', moved.old.within10, moved.next.within10, asShare),
    measure('Within 15%', moved.old.within15, moved.next.within15, asShare),
    measure('Median miss', moved.old.median, moved.next.median, asPoints),
    measure('Mean miss', moved.old.mean, moved.next.mean, asPoints),
    measure('90th-percentile miss', moved.old.p90, moved.next.p90, asPoints),
    measure('Worst miss', moved.old.worst, moved.next.worst, asPoints),
    measure('Average signed miss', moved.old.bias, moved.next.bias, (value) =>
      signed(value, asPoints),
    ),
    `  The change fixed ${all.fixed} jobs and broke ${all.broke}. Exact McNemar p = ${pValue(all.p)}${all.p < 0.05 ? '' : ', which chance alone could explain'}.`,
    `  Resampling owners, within 10% moved ${signed(moved.within.change, asShare)} (likely ${signed(moved.within.low, asShare)} to ${signed(moved.within.high, asShare)}) and the mean miss ${signed(moved.mean.change, asPoints)} (likely ${signed(moved.mean.low, asPoints)} to ${signed(moved.mean.high, asPoints)}).`,
    `  Owners: ${people.better} came out better, ${people.worse} worse, ${people.same} the same.`,
    `  After, resampling owners: within 10% likely between ${asPercent(range.low)} and ${asPercent(range.high)}.`,
    ...(failed ? [`  ${failed} jobs failed in one run or the other and aren't counted.`] : []),
    `  ${decision}`,
    '',
    'By trade:',
    ...groups('trade'),
    '',
    'By how the owner prices the service:',
    ...groups('pricing'),
    '',
    'By whether the owner’s quotes showed what the job needed:',
    ...groups('cause'),
  ];
}

async function load(files: string[]) {
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as SavedRun),
  );
}

async function main() {
  const option = (name: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const given = process.argv.slice(2).filter((arg, index, all) => {
    const flag = all[index - 1];
    return !arg.startsWith('--') && !['--old', '--new', '--path'].includes(flag ?? '');
  });
  const oldFiles = option('old')?.split(',') ?? given.slice(0, 1);
  const newFiles = option('new')?.split(',') ?? given.slice(1, 2);
  if (!oldFiles.length || !newFiles.length)
    throw new Error('Give an old run and a new run: bench:compare old.json new.json');
  const judged = (option('path') ?? 'formula') as PricePath;
  if (!['formula', 'charm', 'generic'].includes(judged))
    throw new Error('--path is formula, charm or generic.');
  console.info(describeComparison(await load(oldFiles), await load(newFiles), judged).join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
