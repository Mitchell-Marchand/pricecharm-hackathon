import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiMode, aiProvider, modelFor, runWithAiUsage } from './ai/index.js';
import { draftGenericQuote } from './ai/quote-engine.js';
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
  draftWithFormula,
  holdFailedFormulas,
  learnedFormula,
  type Learned,
} from './pricing/formula-draft.js';
import { describeSpec } from './pricing/spec.js';
import { gapPercent, quoteTotal, type DraftedQuote } from './practice/types.js';
import { accuracy, closer, share } from './proof.js';

/**
 * The simulated-owner benchmark. Made-up businesses with hidden pricing rules (src/bench/owners.ts)
 * each go through setup the way a real owner does: three past jobs, then five practice customers
 * like setup's, answered by their rules. Then each owner's Charm prices jobs it has never seen,
 * next to the same model with none of the owner's prices, and both are compared with what the
 * owner's rules say. With --curve it also prices them from the past jobs alone, to show what
 * practice adds.
 *
 *   bash scripts/bench.sh [--owners 30] [--tests 6] [--seed 1] [--curve] [--formula] [--messy]
 *     [--practice original] [--concurrency 4] [--json <file>]
 *
 * With --messy the owners price by eye a little, straying 2–8% from their own rates job to job,
 * the way real owners do. With --formula each job is also priced from the owner's formula (src/pricing/formula-draft.ts),
 * falling back to the usual draft where the formula doesn't fit or doesn't cover the job.
 *
 * Each owner's past jobs, practice customers and test jobs come from their own random sequences,
 * so changing the practice plan leaves the test jobs the same and two runs can be compared.
 * It only runs against the quoting_bench database, which scripts/bench.sh makes fresh each time.
 */

type Shape = Parameters<typeof drawJob>[2];

/**
 * Setup's practice customers, in order, as SITUATIONS in src/practice/plan.ts describes them. The
 * plan setup used until October 30 is kept, so a run can compare the two.
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
const PLAN = 'coverage';

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const number = (name: string, fallback: number, max: number) =>
  Math.min(Math.max(Math.round(Number(option(name) ?? fallback)) || fallback, 1), max);

/** Three past jobs of the owner's main service: small, usual and big, nothing unusual. */
function pastJobs(rng: Rng, owner: SimOwner): SimJob[] {
  const rule = owner.rules.services[0];
  const [low, high] = rule.sizes;
  return [0.2, 0.5, 0.85].map((share) => {
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
}

/**
 * Saves the owner as a business with its past jobs and finished practice customers, the rows the
 * Charm learns from. Practice customer i finishes i+1 minutes after the past jobs, so a draft
 * can be limited to what it knew before any practice.
 */
async function seedOwner(
  owner: SimOwner,
  rng: { past: Rng; practice: Rng },
  start: Date,
  plan: { shape: Shape; extra?: number }[],
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
  for (const job of pastJobs(rng.past, owner)) {
    const record = pastJobRecord(owner, job);
    await mutate(
      "INSERT INTO past_jobs (id,business_id,service_name,description,price_cents,size,notes,created_at) VALUES (?,?,?,?,?,?,'',?)",
      [randomUUID(), id, record.service, record.description, record.priceCents, record.size, start],
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

/** Tries a draft up to three times, since the model's API sometimes says it's unavailable. */
async function retried<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
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
  const formula = process.argv.includes('--formula');
  const messy = process.argv.includes('--messy');
  const planName = option('practice') ?? PLAN;
  const plan = PLANS[planName];
  if (!plan)
    throw new Error(`No practice plan called ${planName}. Try ${Object.keys(PLANS).join(' or ')}.`);
  const tokens = { input: 0, output: 0, calls: 0 };
  const generic = aiMode !== 'demo';
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
  /** A draft, retried if the API is down, with the tokens it used added up. */
  const tallied = <T>(businessId: string, task: () => Promise<T>) =>
    runWithAiUsage(
      {
        businessId,
        record: async (usage) => {
          tokens.input += usage.inputTokens;
          tokens.output += usage.outputTokens;
          tokens.calls++;
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
    for (const [level, before] of levels)
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
          const { drafted, use } = await counted(test.businessId, () =>
            draftWithFormula({
              businessId: test.businessId,
              serviceName: test.job.service,
              conversation,
              spec,
              images: [],
              model,
            }),
          );
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
    `${count} made-up businesses (${trades.join(', ').toLowerCase()}), each with its own hidden prices: rates, minimums, extra for jobs in bad shape and for a second story, add-ons, a discount for two services, and how they round.${messy ? ' They price by eye a little: each job’s main work strays 2–8% from their own rate.' : ''} Each Charm learned only from 3 past jobs and ${plan.length} practice quotes (the ${planName} plan), then priced ${perOwner} jobs it had never seen. ${generic ? `Both run on ${engine}; the generic AI gets the same job with none of the owner’s prices. Both are held to their best price.` : `This run used ${engine}, so there's no generic AI to compare with.`}`,
    '',
    `All ${scored.length} jobs:`,
  );
  const all = report(scored);
  out.push(...lines('Charm', all.charm));
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
    out.push(`${trade} (${subset.length} jobs)`, ...lines('Charm', charm));
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
  console.info(`\n${out.join('\n')}`);

  const file = option('json');
  if (file) {
    await writeFile(
      file,
      `${JSON.stringify(
        {
          seed,
          engine,
          practice: planName,
          tokens,
          owners,
          learned,
          tests: tests.map((test) => ({
            ...test,
            business: owners[test.owner].name,
            spec: describeSpec(jobSpec(owners[test.owner], test.job)),
          })),
        },
        null,
        2,
      )}\n`,
    );
    console.info(`\nSaved every owner’s rules and every job to ${file}.`);
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
