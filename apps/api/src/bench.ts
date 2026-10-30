import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiMode, aiProvider, modelFor, runWithAiUsage, useSavedAnswers } from './ai/index.js';
import { draftGenericQuote } from './ai/quote-engine.js';
import { describeComparison, type SavedRun } from './bench/compare.js';
import {
  customerMessage,
  drawJob,
  jobSpec,
  ownerQuote,
  ownerTotal,
  pastJobRecord,
  seeded,
  simulatedOwners,
  type Rng,
  type SimJob,
  type SimOwner,
} from './bench/owners.js';
import { closeDatabase, mutate } from './db.js';
import { draftForBusiness } from './pricing/draft.js';
import {
  holdFailedFormulas,
  learnedFormula,
  priceFromFormula,
  type Learned,
} from './pricing/formula-draft.js';
import { describeSpec } from './pricing/spec.js';
import { gapPercent, quoteTotal, type DraftedQuote } from './practice/types.js';
import { accuracy, closer, share } from './proof.js';

/**
 * The simulated-owner benchmark. Made-up businesses with hidden pricing rules (src/bench/owners.ts)
 * each go through setup the way a real owner does: ten past jobs, then six practice customers
 * like setup's, answered by their rules. Then each owner's Charm prices jobs it has never seen,
 * next to the same model with none of the owner's prices, and both are compared with what the
 * owner's rules say. With --curve it also prices them from the past jobs alone, to show what
 * practice adds.
 *
 *   bash scripts/bench.sh [--owners 30] [--tests 6] [--seed 1] [--curve] [--formula] [--messy]
 *     [--past 10] [--practice original] [--concurrency 4] [--json <file>] [--formula-only]
 *     [--replay <file>] [--fill] [--compare <file>]
 *
 * With --messy the owners price by eye a little, straying 2–8% from their own rates job to job,
 * the way real owners do. With --formula each job is also priced from the owner's formula (src/pricing/formula-draft.ts),
 * falling back to the usual draft where the formula doesn't fit or doesn't cover the job.
 * --formula-only prices with the formula alone, skipping the Charm's usual draft and the generic
 * AI, for about half the model calls while working on formula pricing.
 *
 * --json saves every answer the model gave. --replay <file> runs again on a saved run's answers
 * instead of the model, so a change to how prices are worked out from them is scored for free; a
 * call the saved run never made fails rather than reaching the model, unless --fill sends it to
 * the model, so only what a change asks anew is paid for. --compare <file> lines this run up job
 * for job with an earlier run of the same seed (src/bench/compare.ts).
 *
 * Each owner's past jobs, practice customers and test jobs come from their own random sequences,
 * so changing the practice plan leaves the test jobs the same and two runs can be compared.
 * It only runs against the quoting_bench database, which scripts/bench.sh makes fresh each time.
 */

type Shape = Parameters<typeof drawJob>[2];

/**
 * Setup's practice customers, in order, as SITUATIONS in src/practice/plan.ts describes them
 * (experiments, since October 30). The plans setup used before are kept, so a run can compare.
 */
const PLANS: Record<string, { shape: Shape; extra?: number }[]> = {
  original: [
    { shape: 'typical' },
    { shape: 'bigger' },
    { shape: 'tricky' },
    { shape: 'small' },
    { shape: 'other' },
  ],
  coverage: [
    { shape: 'typical', extra: 0 },
    { shape: 'other', extra: 1 },
    { shape: 'tricky' },
    { shape: 'small' },
    { shape: 'bigger', extra: 0 },
  ],
  // Each customer changes one thing from a plain job, so nothing hides anything else: a minimum
  // can't pass for a surcharge, and bad shape and a second story are seen apart.
  experiments: [
    { shape: 'plain', extra: 0 },
    { shape: 'other', extra: 1 },
    { shape: 'heavy' },
    { shape: 'tall' },
    { shape: 'small' },
    { shape: 'bigger', extra: 0 },
  ],
};
const PLAN = 'experiments';

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * A file named on the command line, found from where scripts/bench.sh was run (it passes BENCH_CWD),
 * not from apps/api, where npm runs this.
 */
function fileOption(name: string) {
  const given = option(name);
  return given
    ? path.resolve(process.env.BENCH_CWD ?? process.env.INIT_CWD ?? process.cwd(), given)
    : undefined;
}

const number = (name: string, fallback: number, max: number) =>
  Math.min(Math.max(Math.round(Number(option(name) ?? fallback)) || fallback, 1), max);

/**
 * The owner's past jobs: three of their main service, small, usual and big, nothing unusual, then
 * with --past more, of any kind, the way an owner's invoices run.
 */
function pastJobs(rng: Rng, owner: SimOwner, count: number): SimJob[] {
  const rule = owner.rules.services[0];
  const [low, high] = rule.sizes;
  const first = [0.2, 0.5, 0.85].map((share) => {
    const raw = low + (high - low) * share;
    return {
      service: rule.name,
      quantity: rule.unit === 'sq ft' ? Math.round(raw / 10) * 10 : Math.round(raw),
      heavy: false,
      twoStory: rule.height && rng() < 0.4,
      addOns: [],
      second: null,
    };
  });
  return [
    ...first,
    ...Array.from({ length: Math.max(0, count - 3) }, () => drawJob(rng, owner, 'any')),
  ];
}

/**
 * Saves the owner as a business with its past jobs and finished practice customers, the rows the
 * Charm learns from. Past jobs are 10 ms apart, so they always load in the same order and a run
 * asks the model the same things each time. Practice customer i finishes i+1 minutes after the
 * past jobs, so a draft can be limited to what it knew before any practice.
 */
async function seedOwner(
  owner: SimOwner,
  rng: { past: Rng; practice: Rng },
  start: Date,
  plan: { shape: Shape; extra?: number }[],
  past: number,
) {
  const id = randomUUID();
  await mutate(
    "INSERT INTO businesses (id,name,slug,description,status,trade_id,service_area,metrics_subject) VALUES (?,?,?,'','active',?,?,UUID())",
    [
      id,
      owner.name,
      `${owner.name.toLowerCase().replace(/\W+/g, '-')}-${id.slice(0, 8)}`,
      owner.tradeId,
      owner.area,
    ],
  );
  for (const [position, rule] of owner.rules.services.entries())
    await mutate(
      'INSERT INTO offerings (id,business_id,name,custom,position) VALUES (?,?,?,FALSE,?)',
      [randomUUID(), id, rule.name, position],
    );
  for (const [index, job] of pastJobs(rng.past, owner, past).entries()) {
    const record = pastJobRecord(owner, job);
    await mutate(
      "INSERT INTO past_jobs (id,business_id,service_name,description,price_cents,size,notes,created_at) VALUES (?,?,?,?,?,?,'',?)",
      [
        randomUUID(),
        id,
        record.service,
        record.description,
        record.priceCents,
        record.size,
        new Date(start.getTime() + index * 10),
      ],
    );
  }
  for (const [position, { shape, extra }] of plan.entries()) {
    const job = drawJob(rng.practice, owner, shape, extra);
    const quote = ownerQuote(owner, job);
    const spec = jobSpec(owner, job);
    const runId = randomUUID();
    const finished = new Date(start.getTime() + (position + 1) * 60_000);
    await mutate(
      "INSERT INTO practice_runs (id,business_id,position,status,scenario_json,outcome,quote_json,finished_at) VALUES (?,?,?,'finished',?,'quote',?,?)",
      [
        runId,
        id,
        position,
        JSON.stringify({
          firstName: 'Sam',
          lastInitial: 'K',
          place: owner.area,
          serviceName: job.service,
          opener: '',
          facts: [],
          photos: [],
          suggestions: [],
          siteVisitLikely: false,
          siteVisitCue: '',
          acceptReply: '',
          siteVisitReply: '',
          quantity: spec.quantity,
          unit: spec.unit,
          situation: shape,
        }),
        JSON.stringify({
          lines: quote.lines.map((line, index) => ({ id: `l${index}`, ...line })),
          discount: quote.discount,
          start: '',
          duration: '',
          included: [],
          excluded: [],
          validDays: 14,
          note: '',
          number: position + 1,
          customer: 'Sam K.',
          place: owner.area,
          issuedAt: finished.toISOString(),
        }),
        finished,
      ],
    );
    const said = [
      ['customer', customerMessage(rng.practice, owner, job, shape === 'bigger')],
      ['owner', 'Thanks for the details. Here’s your quote.'],
    ];
    for (const [index, [sender, text]] of said.entries())
      await mutate(
        "INSERT INTO practice_messages (id,business_id,run_id,sender,kind,text,created_at) VALUES (?,?,?,?,'text',?,?)",
        [
          randomUUID(),
          id,
          runId,
          sender,
          text,
          new Date(finished.getTime() - 30_000 + index * 1000),
        ],
      );
  }
  return id;
}

type Test = {
  owner: number;
  businessId: string;
  job: SimJob;
  message: string;
  ownerCents: number;
  /** The Charm's best price, by how much practice it had: 'full', or 0 with --curve. */
  charm: Record<string, { cents: number | null; visit: boolean } | undefined>;
  generic?: { cents: number | null };
  /** Formula pricing's best price, and why it fell back to the usual draft when it did. */
  formula?: { cents: number | null; used: boolean; reason?: string };
  failed?: string;
};

/** Its lines added up, even when it would rather the owner saw the job first. */
const best = (drafted: DraftedQuote) => (drafted.lines.length ? quoteTotal(drafted) : null);
const gapOf = (cents: number | null | undefined, owner: number) =>
  cents ? gapPercent(cents, owner) : null;

/** Whether this run answers only from a saved run, never the model (--replay without --fill). */
let replayOnly = false;

/** Tries a draft up to three times, since the model's API sometimes says it's unavailable. */
async function retried<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= 3) throw error;
      // A replay has no API to wait for.
      if (!replayOnly) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

type Saved = Record<string, { operation: string; answers: unknown[] }>;

/**
 * Keeps every answer the model gives, and with a saved run's answers, gives each call back what
 * it was answered before, in the order it was answered: a call that failed its check and was
 * asked again gets its second answer the second time.
 */
function savedAnswers(earlier: Saved | null, fill: boolean) {
  const kept: Saved = {};
  const served = new Map<string, number>();
  const replay = { answered: 0, missing: 0 };
  const keep = (key: string, operation: string, answer: unknown) => {
    kept[key] ??= { operation, answers: [] };
    kept[key].answers.push(answer);
  };
  useSavedAnswers({
    replayOnly: Boolean(earlier) && !fill,
    keep,
    answer: (key) => {
      const saved = earlier?.[key];
      if (!saved) {
        if (earlier) replay.missing++;
        return undefined;
      }
      const turn = served.get(key) ?? 0;
      served.set(key, turn + 1);
      replay.answered++;
      const answer = saved.answers[Math.min(turn, saved.answers.length - 1)];
      // Kept again, so a replayed run's file can be replayed too.
      keep(key, saved.operation, answer);
      return answer;
    },
  });
  return { kept, replay };
}

/** Runs tasks a few at a time, so the model isn't sent everything at once. */
async function pool(tasks: (() => Promise<void>)[], size: number) {
  let next = 0,
    done = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < tasks.length) {
        await tasks[next++]();
        if (++done % 20 === 0) console.info(`  ${done} of ${tasks.length} drafts done`);
      }
    }),
  );
}

/**
 * What the jobs it missed have in common: for each thing that changes an owner's price, the
 * Charm's typical miss on jobs with it against jobs without it, biggest difference first.
 */
export function missBreakdown(
  tests: Test[],
  owners: SimOwner[],
  priced: (test: Test) => number | null | undefined = (test) => test.charm.full?.cents,
) {
  const factors: [string, (test: Test, owner: SimOwner) => boolean][] = [
    ['Add-ons', (test) => test.job.addOns.length > 0],
    [
      'The owner’s other service',
      (test, owner) => test.job.service !== owner.rules.services[0].name,
    ],
    ['Two services together', (test) => Boolean(test.job.second)],
    [
      'In bad shape, which this owner charges for',
      (test, owner) => test.job.heavy && owner.rules.heavy > 0,
    ],
    [
      'Second story, which this owner charges for',
      (test, owner) =>
        test.job.twoStory &&
        owner.rules.height > 0 &&
        Boolean(owner.rules.services.find((rule) => rule.name === test.job.service)?.height),
    ],
    ['Small enough for the minimum', (test, owner) => test.ownerCents <= owner.rules.minimum],
    ['Owner folds extras into the main price', (_test, owner) => !owner.rules.itemizes],
    [
      'Owner lowers the rate on big jobs, or prices by size bands',
      (test, owner) => {
        const rule = owner.rules.services.find((item) => item.name === test.job.service);
        return Boolean(rule?.volume || rule?.bands);
      },
    ],
    ['It wanted to see the job first', (test) => Boolean(test.charm.full?.visit)],
  ];
  const miss = (subset: Test[]) =>
    accuracy(subset.map((test) => ({ gap: gapOf(priced(test), test.ownerCents) })));
  return factors
    .map(([label, has]) => {
      const withIt = tests.filter((test) => has(test, owners[test.owner]));
      const without = tests.filter((test) => !has(test, owners[test.owner]));
      return { label, withIt: miss(withIt), without: miss(without) };
    })
    .filter((row) => row.withIt.jobs > 0)
    .sort(
      (a, b) =>
        (b.withIt.medianGap ?? 0) -
        (b.without.medianGap ?? 0) -
        ((a.withIt.medianGap ?? 0) - (a.without.medianGap ?? 0)),
    );
}

function lines(label: string, gaps: { gap: number | null }[]) {
  const stats = accuracy(gaps);
  return [
    `  ${label}: within 10% on ${share(stats.within10, stats.jobs)}, within 15% on ${share(stats.within15, stats.jobs)}, typical miss ${stats.medianGap === null ? '-' : `${stats.medianGap}%`}`,
  ];
}

async function main() {
  if (process.env.DB_NAME !== 'quoting_bench')
    throw new Error('The benchmark only runs on the quoting_bench database. Use scripts/bench.sh.');
  const count = number('owners', 30, 90);
  const perOwner = number('tests', 6, 30);
  const seed = number('seed', 1, 1_000_000);
  const concurrency = number('concurrency', 4, 12);
  const model = option('model');
  const curve = process.argv.includes('--curve');
  const formulaOnly = process.argv.includes('--formula-only');
  const formula = formulaOnly || process.argv.includes('--formula');
  if (curve && formulaOnly)
    throw new Error(
      '--curve compares the Charm’s usual drafts, so it can’t run with --formula-only.',
    );
  const messy = process.argv.includes('--messy');
  const past = number('past', 10, 50);
  const planName = option('practice') ?? PLAN;
  const plan = PLANS[planName];
  if (!plan)
    throw new Error(`No practice plan called ${planName}. Try ${Object.keys(PLANS).join(' or ')}.`);
  const tokens = { input: 0, output: 0, calls: 0 };
  /** Each kind of model call: how many were answered, their tokens, and why any failed. */
  const calls: Record<
    string,
    { answered: number; input: number; output: number; failed: Record<string, number> }
  > = {};
  const callsOf = (operation: string) =>
    (calls[operation] ??= { answered: 0, input: 0, output: 0, failed: {} });
  const replayFile = fileOption('replay');
  const earlier = replayFile
    ? ((JSON.parse(await readFile(replayFile, 'utf8')) as { answers?: Saved }).answers ?? null)
    : null;
  if (replayFile && !earlier)
    throw new Error(`${replayFile} has no saved answers. Runs save them with --json.`);
  const fill = process.argv.includes('--fill');
  replayOnly = Boolean(earlier) && !fill;
  const answers = savedAnswers(earlier, fill);
  const generic = aiMode !== 'demo' && !formulaOnly;
  const owners = simulatedOwners(seed, count, messy);
  const start = new Date(Date.now() - 86_400_000);

  console.info(`Setting up ${count} simulated owners.`);
  const tests: Test[] = [];
  for (const [index, owner] of owners.entries()) {
    const base = seed * 1000 + index * 10;
    const businessId = await seedOwner(
      owner,
      { past: seeded(base + 1), practice: seeded(base + 2) },
      start,
      plan,
      past,
    );
    const rng = seeded(base + 3);
    for (let n = 0; n < perOwner; n++) {
      const job = drawJob(rng, owner, 'any');
      tests.push({
        owner: index,
        businessId,
        job,
        message: customerMessage(rng, owner, job),
        ownerCents: ownerTotal(owner, job),
        charm: {},
      });
    }
  }

  const engine =
    aiMode === 'demo'
      ? 'the rate card alone (AI_PROVIDER=demo)'
      : `${aiProvider} ${model ?? modelFor('draft_quote')}`;
  const levels: [string, Date | undefined][] = [
    ['full', undefined],
    ...(curve ? ([['0', new Date(start.getTime() + 30_000)]] as [string, Date][]) : []),
  ];
  /** A draft, retried if the API is down, with the tokens it used and any failures added up. */
  const tallied = <T>(businessId: string, task: () => Promise<T>) =>
    runWithAiUsage(
      {
        businessId,
        record: async (usage) => {
          tokens.input += usage.inputTokens;
          tokens.output += usage.outputTokens;
          tokens.calls++;
          const kind = callsOf(usage.operation);
          kind.answered++;
          kind.input += usage.inputTokens;
          kind.output += usage.outputTokens;
        },
        failed: async (failure) => {
          const kind = callsOf(failure.operation);
          kind.failed[failure.reason] = (kind.failed[failure.reason] ?? 0) + 1;
        },
      },
      task,
    );
  const counted = <T>(businessId: string, task: () => Promise<T>) =>
    retried(() => tallied(businessId, task));
  /** Each owner's formula from before pricing started, so the report never works one out again. */
  const formulas = new Map<string, Learned | null>();
  const tasks: (() => Promise<void>)[] = [];
  for (const test of tests) {
    const owner = owners[test.owner];
    const spec = jobSpec(owner, test.job);
    const conversation = [{ from: 'customer' as const, text: test.message }];
    for (const [level, before] of formulaOnly ? [] : levels)
      tasks.push(async () => {
        try {
          const { drafted } = await counted(test.businessId, () =>
            draftForBusiness({
              businessId: test.businessId,
              serviceName: test.job.service,
              conversation,
              spec,
              images: [],
              history: before ? { before } : {},
              model,
              formula: false,
            }),
          );
          test.charm[level] = { cents: best(drafted), visit: drafted.decision === 'site_visit' };
        } catch (error) {
          test.failed = error instanceof Error ? error.message : String(error);
        }
      });
    if (formula)
      tasks.push(async () => {
        try {
          // Where the formula can't price it, the usual draft does, as in a live quote.
          const { drafted, use } = await counted(test.businessId, async () => {
            const input = { businessId: test.businessId, serviceName: test.job.service };
            const learned = await learnedFormula(test.businessId, {}, model).catch(() => null);
            const priced = await priceFromFormula(learned, { ...input, conversation, spec, model });
            return priced.drafted
              ? { drafted: priced.drafted, use: priced.use }
              : {
                  drafted: (
                    await draftForBusiness({
                      ...input,
                      conversation,
                      spec,
                      images: [],
                      model,
                      formula: false,
                    })
                  ).drafted,
                  use: priced.use,
                };
          });
          test.formula = {
            cents: best(drafted),
            used: use.used,
            reason: use.used ? undefined : use.reason,
          };
        } catch (error) {
          test.failed = error instanceof Error ? error.message : String(error);
        }
      });
    if (generic)
      tasks.push(async () => {
        try {
          const drafted = await counted(test.businessId, () =>
            draftGenericQuote({
              business: {
                trade: owner.trade,
                services: owner.rules.services.map((rule) => rule.name),
                area: owner.area,
              },
              request: {
                serviceName: test.job.service,
                conversation,
                details: describeSpec(spec),
              },
              images: [],
              model,
            }),
          );
          test.generic = { cents: best(drafted) };
        } catch (error) {
          test.failed = error instanceof Error ? error.message : String(error);
        }
      });
  }
  if (formula) {
    // Each owner's formula is worked out before any job is priced, a few at a time, so the long
    // calls don't all hit the API at once.
    console.info(`Working out ${owners.length} owners’ formulas.`);
    holdFailedFormulas(null);
    const ids = [...new Set(tests.map((test) => test.businessId))];
    await pool(
      ids.map((id) => async () => {
        // Learning retries on its own, so it isn't retried again here.
        formulas.set(
          id,
          await tallied(id, () => learnedFormula(id, {}, model)).catch((error: unknown) => {
            console.error(`  ${id}: ${error instanceof Error ? error.message : error}`);
            return null;
          }),
        );
      }),
      3,
    );
  }
  console.info(`Pricing ${tests.length} new jobs with ${engine}: ${tasks.length} drafts.`);
  await pool(tasks, concurrency);

  const scored = tests.filter((test) => !test.failed);
  const report = (subset: Test[]) => {
    const charm = subset.map((test) => ({ gap: gapOf(test.charm.full?.cents, test.ownerCents) }));
    const others = subset.map((test) => ({ gap: gapOf(test.generic?.cents, test.ownerCents) }));
    const formulas = subset.map((test) => ({ gap: gapOf(test.formula?.cents, test.ownerCents) }));
    return { charm, others, formulas };
  };
  const out: string[] = [];
  const trades = [...new Set(owners.map((owner) => owner.trade))];
  out.push(
    `PriceCharm simulated-owner benchmark, ${new Date().toISOString().slice(0, 10)}, seed ${seed}`,
    '',
    `${count} made-up businesses (${trades.join(', ').toLowerCase()}), each with its own hidden prices: rates, minimums, extra for jobs in bad shape and for a second story, add-ons, a discount for two services, and how they round.${messy ? ' They price by eye a little: each job’s main work strays 2–8% from their own rate.' : ''} Each Charm learned only from ${past} past jobs and ${plan.length} practice quotes (the ${planName} plan), then priced ${perOwner} jobs it had never seen. ${formulaOnly ? `This run priced with the owner’s formula alone (--formula-only), on ${engine}.` : generic ? `Both run on ${engine}; the generic AI gets the same job with none of the owner’s prices. Both are held to their best price.` : `This run used ${engine}, so there's no generic AI to compare with.`}`,
    '',
    `All ${scored.length} jobs:`,
  );
  const all = report(scored);
  if (!formulaOnly) out.push(...lines('Charm', all.charm));
  if (formula) out.push(...lines('Formula pricing', all.formulas));
  if (generic) {
    out.push(...lines('Generic AI', all.others));
    const wins = closer(all.charm.map((charm, index) => ({ charm, generic: all.others[index] })));
    const charmMiss = accuracy(all.charm).medianGap,
      genericMiss = accuracy(all.others).medianGap;
    out.push(
      `  Closer to the owner: the Charm on ${share(wins.charm, scored.length)}, the generic AI on ${share(wins.generic, scored.length)}${wins.tied ? `, tied on ${wins.tied}` : ''}.`,
    );
    if (charmMiss !== null && genericMiss !== null && charmMiss > 0)
      out.push(
        `  The Charm’s typical miss is ${(genericMiss / charmMiss).toFixed(1)} times smaller.`,
      );
  }
  const visits = scored.filter((test) => test.charm.full?.visit).length;
  if (visits)
    out.push(
      `  The Charm would have asked the owner to see ${visits} of these first; its price still counts above.`,
    );
  if (!formulaOnly)
    out.push(
      '',
      'Where the Charm misses (typical miss on jobs with each, then without):',
      ...missBreakdown(scored, owners).map(
        (row) =>
          `  ${row.label}: ${row.withIt.medianGap ?? '-'}% on ${row.withIt.jobs} jobs, against ${row.without.medianGap ?? '-'}%`,
      ),
    );
  const learned: unknown[] = [];
  if (formula) {
    const used = scored.filter((test) => test.formula?.used);
    const reasons = new Map<string, number>();
    for (const test of scored)
      if (test.formula && !test.formula.used) {
        const reason = (test.formula.reason ?? '').replace(
          /^the formula doesn’t cover .*/,
          'the job asks for something the formula doesn’t cover',
        );
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    let fitting = 0;
    for (const [index, owner] of owners.entries()) {
      const businessId = tests.find((test) => test.owner === index)?.businessId;
      const result = businessId ? (formulas.get(businessId) ?? null) : null;
      if (result?.fits) fitting++;
      learned.push({
        owner: owner.name,
        fits: result?.fits ?? false,
        gaps: result?.gaps ?? [],
        formula: result?.formula ?? null,
        examples: result?.examples ?? [],
      });
    }
    out.push(
      '',
      'Formula pricing:',
      `  The formula gave back the owner’s own prices for ${share(fitting, owners.length)} owners.`,
      `  It priced ${share(used.length, scored.length)} jobs itself:`,
      ...lines(
        '  On those',
        used.map((test) => ({ gap: gapOf(test.formula?.cents, test.ownerCents) })),
      ),
      ...[...reasons.entries()].map(([reason, n]) => `  The AI drafted ${n} because ${reason}.`),
      'Where formula pricing misses (typical miss on jobs with each, then without):',
      ...missBreakdown(scored, owners, (test) => test.formula?.cents).map(
        (row) =>
          `  ${row.label}: ${row.withIt.medianGap ?? '-'}% on ${row.withIt.jobs} jobs, against ${row.without.medianGap ?? '-'}%`,
      ),
    );
  }
  out.push('', 'By trade:');
  for (const trade of trades) {
    const subset = scored.filter((test) => owners[test.owner].trade === trade);
    const { charm, others, formulas } = report(subset);
    out.push(`${trade} (${subset.length} jobs)`);
    if (!formulaOnly) out.push(...lines('Charm', charm));
    if (formula) out.push(...lines('Formula pricing', formulas));
    if (generic) out.push(...lines('Generic AI', others));
  }
  if (curve) {
    out.push(
      '',
      'What practice adds (the Charm on the same jobs):',
      ...lines(
        'Past jobs only',
        scored.map((test) => ({ gap: gapOf(test.charm['0']?.cents, test.ownerCents) })),
      ),
      ...lines(`Plus ${plan.length} practice quotes`, all.charm),
    );
  }
  const failed = tests.length - scored.length;
  if (failed) out.push('', `${failed} jobs failed to draft and aren’t counted.`);
  if (tokens.calls)
    out.push(
      '',
      `${tokens.calls} model calls: ${tokens.input.toLocaleString('en-US')} tokens in, ${tokens.output.toLocaleString('en-US')} out.`,
    );
  // Failures are counted per try, so a formula that took three tries shows two here.
  const kinds = Object.entries(calls).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length)
    out.push(
      'By kind of call:',
      ...kinds.map(([operation, kind]) => {
        const reasons = Object.entries(kind.failed);
        const failures = reasons.reduce((sum, [, n]) => sum + n, 0);
        return `  ${operation}: ${kind.answered} answered${failures ? `, ${failures} failed (${reasons.map(([reason, n]) => `${n} ${reason}`).join(', ')})` : ''}${operation === 'learn_formula_quick' ? ', each the quicker last try after longer ones failed' : ''}`;
      }),
    );
  if (earlier)
    out.push(
      '',
      `Replayed from ${replayFile}: ${answers.replay.answered} calls answered from the saved run${answers.replay.missing ? `, ${answers.replay.missing} not in it, ${fill ? 'so the model answered them' : 'so those jobs failed instead of reaching the model'}` : ', none missing'}.`,
    );

  const run = {
    seed,
    engine,
    practice: planName,
    formulaOnly,
    tokens,
    calls,
    owners,
    learned,
    tests: tests.map((test) => ({
      ...test,
      business: owners[test.owner].name,
      spec: describeSpec(jobSpec(owners[test.owner], test.job)),
    })),
  };
  const against = fileOption('compare');
  if (against) {
    const before = JSON.parse(await readFile(against, 'utf8')) as SavedRun;
    out.push(
      '',
      ...describeComparison([before], [run], formula ? 'formula' : 'charm').map((text, index) =>
        index ? text : `${text} Before is ${against}; after is this run.`,
      ),
    );
  }
  console.info(`\n${out.join('\n')}`);

  const file = fileOption('json');
  if (file) {
    await writeFile(file, `${JSON.stringify({ ...run, answers: answers.kept }, null, 2)}\n`);
    console.info(`\nSaved every owner’s rules, every job and every model answer to ${file}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error('The benchmark failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
