import { createHash } from 'node:crypto';
import { aiMode } from '../ai/index.js';
import { learnFormula, readJobParts, type FormulaExample } from '../ai/formula.js';
import type { PricingHistory } from '../ai/quote-engine.js';
import { mutate, rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import { json } from '../models.js';
import { quoteTotal, type DraftedQuote } from '../practice/types.js';
import { withAiUsage } from '../usage.js';
import {
  doubtsAbout,
  fitGaps,
  formulaFits,
  formulaUsable,
  ownerRounding,
  priceJob,
  refineFormula,
  type JobParts,
  type PriceFormula,
} from './formula.js';
import { loadPricingData, type HistoryOptions, type PricingData } from './history.js';
import { describeJob, type JobSpec } from './spec.js';
import { canonicalUnit } from './units.js';

/**
 * Formula pricing: the owner's formula, worked out from their quotes and checked against all of
 * them, prices the job; the AI only reads the request. Whenever the formula doesn't fit the
 * owner's own quotes, or the job asks for something it doesn't cover, the AI drafts the quote the
 * usual way instead (src/pricing/draft.ts), so nothing is forced into a formula that doesn't hold.
 * Working a formula out takes a minute or two, so it's done in the background whenever what the
 * owner taught changes, and kept; a quote never waits for it.
 */

type Written = {
  lines: { amountCents: number }[];
  discount: { kind: string; value: number; reason: string } | null;
};

/** A quote's total from its lines and discount, as the owner wrote them. */
const totalOf = ({ lines, discount }: Written) =>
  quoteTotal({
    lines,
    discount:
      discount && (discount.kind === 'percent' || discount.kind === 'amount')
        ? { ...discount, kind: discount.kind }
        : null,
  });

/** The owner's priced jobs and quotes, numbered, as the formula is worked out from them. */
export function formulaExamples(history: PricingHistory): FormulaExample[] {
  const examples: Omit<FormulaExample, 'index'>[] = [
    ...history.pastJobs.map((job) => ({
      kind: 'past job' as const,
      service: job.service,
      request: `${job.description}${job.size ? ` (size: ${job.size})` : ''}${job.notes ? `. ${job.notes}` : ''}`,
      lines: null,
      discount: job.discount,
      totalCents: job.priceCents,
    })),
    ...history.practice
      .filter((run) => run.outcome === 'quote' && run.lines.length)
      .map((run) => ({
        kind: 'practice' as const,
        service: run.service,
        request: run.request,
        lines: run.lines,
        discount: run.discount,
        totalCents: totalOf(run),
      })),
    // Only quotes the owner priced themselves: one the AI sent alone would teach its own guess.
    ...history.liveQuotes
      .filter((quote) => quote.ownerChange && quote.lines.length)
      .map((quote) => ({
        kind: 'real quote' as const,
        service: quote.service,
        request: [quote.request, quote.details].filter(Boolean).join('. '),
        lines: quote.lines,
        discount: quote.discount,
        totalCents: totalOf(quote),
      })),
  ];
  return examples.map((example, index) => ({ ...example, index }));
}

export type Learned = {
  formula: PriceFormula;
  /** The owner's notes it was worked out with. */
  notes: string[];
  /** Each example as the AI reads it at quote time, by its index, or null if it couldn't. */
  examples: (JobParts | null)[];
  /** How far the formula's price is from each example's total, in percent. */
  gaps: (number | null)[];
  /** Each example's total, as the owner charged it. */
  totals?: number[];
  fits: boolean;
};

/** Runs tasks a few at a time, in order. */
async function inTurns<T, R>(items: T[], at: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, items.length) }, worker));
  return results;
}

/**
 * How formulas are worked out and tuned. A change to it works every owner's formula out again, the
 * next time one is needed.
 */
const LEARNING = '2026-11-01';

/** What a formula is worked out from: the owner's quotes and their notes about their prices. */
function examplesKey(examples: FormulaExample[], notes: string[]) {
  return createHash('sha256')
    .update(JSON.stringify({ examples, notes, learning: LEARNING }))
    .digest('hex');
}

/** Works out the owner's formula from their quotes and notes, then checks and tunes it on them. */
async function learnFrom(
  data: PricingData,
  examples: FormulaExample[],
  model?: string,
): Promise<Learned> {
  const { notes } = data.history;
  const business = { trade: data.history.business.trade, services: data.history.business.services };
  const ask = (quick: boolean) => learnFormula({ quick, business, examples, notes, model });
  // Working out a formula reasons at length, and the API sometimes gives up on long calls, so it
  // gets two more tries before the quote falls back to the usual draft.
  const attempt = async (tries: number): Promise<PriceFormula> => {
    try {
      // The last try reasons less, so it finishes inside its allowance.
      return await ask(tries <= 1);
    } catch (error) {
      if (tries <= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return attempt(tries - 1);
    }
  };
  return settle(await attempt(3), examples, notes, model);
}

/** Checks and tunes the AI's formula on the owner's own quotes, read the way new requests are. */
async function settle(
  answer: PriceFormula,
  examples: FormulaExample[],
  notes: string[],
  model?: string,
): Promise<Learned> {
  // Rounding is counted from what they wrote: every line, and every total with no discount.
  const learned = {
    ...answer,
    roundToCents: ownerRounding(
      examples.flatMap((example) =>
        example.lines
          ? example.lines.map((line) => line.amountCents)
          : example.discount
            ? []
            : [example.totalCents],
      ),
    ),
  };
  // Each example is read the way a new request will be, so the formula is checked and tuned on
  // what it will actually be given, not on the AI's own account of its examples.
  const read = (example: FormulaExample) =>
    readJobParts({
      formula: learned,
      request: {
        serviceName: example.service,
        conversation: [{ from: 'customer', text: example.request }],
      },
      model,
    }).then(({ uncovered: _uncovered, unpriced: _unpriced, ...parts }) => parts);
  const parts = await inTurns(examples, 3, (example) =>
    read(example)
      .catch(() => read(example))
      .catch(() => null),
  );
  const checked = examples.flatMap((example, index) => {
    const found = parts[index];
    return found ? [{ parts: found, totalCents: example.totalCents, lines: example.lines }] : [];
  });
  const formula = refineFormula(learned, checked);
  const gaps = examples.map((example, index) => {
    const found = parts[index];
    return found ? fitGaps(formula, [{ parts: found, totalCents: example.totalCents }])[0] : null;
  });
  return {
    formula,
    notes,
    examples: parts,
    gaps,
    fits: formulaFits(gaps),
    totals: examples.map((example) => example.totalCents),
  };
}

const learning = new Map<string, Promise<Learned | null>>();
let failedHoldMs: number | null = 10 * 60_000;

/**
 * How long a business's formula isn't tried again after it fails to work out: ten minutes by
 * default, or never again in this process with null (the benchmark, so a long run doesn't keep
 * retrying the same owners).
 */
export function holdFailedFormulas(ms: number | null) {
  failedHoldMs = ms;
}

/**
 * The owner's formula for what they've taught so far, waiting for it to be worked out. Null when
 * there are too few examples to work one out from. The benchmark uses this; quotes use
 * currentFormula, which never waits.
 */
export function learnedFormula(
  businessId: string,
  history: HistoryOptions = {},
  model?: string,
): Promise<Learned | null> {
  return loadPricingData(businessId, history).then((data) => {
    const examples = formulaExamples(data.history);
    if (examples.length < 3) return null;
    const key = `${businessId}:${model ?? ''}:${examplesKey(examples, data.history.notes)}`;
    let pending = learning.get(key);
    if (!pending) {
      pending = learnFrom(data, examples, model);
      pending.catch(() => {
        if (failedHoldMs !== null) setTimeout(() => learning.delete(key), failedHoldMs).unref();
      });
      learning.set(key, pending);
    }
    return pending;
  });
}

const refreshing = new Set<string>();
const refreshAgain = new Set<string>();
const failedAt = new Map<string, number>();

/**
 * Works the owner's formula out again, in the background, when their quotes or notes have changed
 * since it was last worked out, and keeps it. Call it whenever they teach it something; quotes
 * call it too, so nothing is missed. One at a time for a business: a change while one is being
 * worked out runs one more after it.
 */
export function refreshFormula(businessId: string): void {
  if (aiMode === 'demo') return;
  if (refreshing.has(businessId)) {
    refreshAgain.add(businessId);
    return;
  }
  const failed = failedAt.get(businessId);
  if (failed && failedHoldMs !== null && Date.now() - failed < failedHoldMs) return;
  refreshing.add(businessId);
  void (async () => {
    const data = await loadPricingData(businessId);
    const examples = formulaExamples(data.history);
    if (examples.length < 3) return;
    const key = examplesKey(examples, data.history.notes);
    const [kept] = await rows('SELECT examples_key FROM pricing_formulas WHERE business_id=?', [
      businessId,
    ]);
    if (kept?.examples_key === key) return;
    const learned = await withAiUsage(businessId, 'formula', () => learnFrom(data, examples));
    await mutate(
      `INSERT INTO pricing_formulas (business_id,examples_key,learned_json) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE examples_key=VALUES(examples_key),learned_json=VALUES(learned_json),learned_at=UTC_TIMESTAMP(3)`,
      [businessId, key, JSON.stringify(learned)],
    );
    failedAt.delete(businessId);
  })()
    .catch((error) => {
      failedAt.set(businessId, Date.now());
      reportError(error, { event: 'formula_learn' });
    })
    .finally(() => {
      refreshing.delete(businessId);
      if (refreshAgain.delete(businessId)) refreshFormula(businessId);
    });
}

/**
 * The owner's formula as last worked out, without waiting. When their quotes have changed since,
 * it's worked out again in the background, and this one prices until then; when their notes
 * have changed, it doesn't, since it wouldn't follow them.
 */
export async function currentFormula(businessId: string, data: PricingData) {
  refreshFormula(businessId);
  const [kept] = await rows('SELECT learned_json FROM pricing_formulas WHERE business_id=?', [
    businessId,
  ]);
  const learned = kept ? json<Learned | null>(kept.learned_json, null) : null;
  return learned && JSON.stringify(learned.notes) === JSON.stringify(data.history.notes)
    ? learned
    : null;
}

export type FormulaUse =
  | {
      used: true;
      formula: PriceFormula;
      /** Why it isn't sure of this one, in the owner's words, when it isn't (doubtsAbout). */
      doubts: string[];
    }
  | { used: false; reason: string };

/** The job's size from what the customer said, when it's in the unit the formula prices by. */
function measuredSize(formula: PriceFormula, service: string, spec: JobSpec | null) {
  const rule = formula.services.find((item) => item.name.toLowerCase() === service.toLowerCase());
  if (!rule || !spec?.quantity || !spec.unit) return null;
  const unit = canonicalUnit(rule.unit) ?? rule.unit;
  return unit === spec.unit ? spec.quantity : null;
}

/**
 * The quote from the owner's formula, when it fits their own quotes and covers everything the
 * customer asks for. The AI only reads the request; the server does the arithmetic.
 */
export async function priceFromFormula(
  learned: Learned | null,
  input: {
    serviceName: string;
    conversation: { from: 'customer' | 'owner'; text: string }[];
    spec: JobSpec | null;
    /** What was measured and seen in the customer's video and photos, in words. */
    media?: string[];
    model?: string;
  },
): Promise<{ drafted: DraftedQuote | null; use: FormulaUse }> {
  const skip = (reason: string) => ({ drafted: null, use: { used: false as const, reason } });
  if (!learned) return skip('too few priced jobs for a formula');
  if (!learned.fits && !formulaUsable(learned.gaps))
    return skip('the formula doesn’t give back the owner’s own prices');
  const { formula } = learned;
  const read = await readJobParts({
    formula,
    request: {
      serviceName: input.serviceName,
      conversation: input.conversation,
      details: describeJob(input.spec, input.media) || undefined,
    },
    model: input.model,
  });
  if (read.uncovered) return skip(`the formula doesn’t cover ${read.uncovered}`);
  const { unpriced, uncovered: _uncovered, ...asked } = read;
  const parts = { ...asked, size: measuredSize(formula, read.service, input.spec) ?? read.size };
  const priced = priceJob(formula, parts);
  if (!priced) return skip('the formula can’t price this job');
  // Its doubts are judged against the owner's own quotes, as the formula was checked on them.
  const checks = learned.examples.flatMap((found, index) =>
    found && learned.totals?.[index] ? [{ parts: found, totalCents: learned.totals[index] }] : [],
  );
  const doubts = [
    ...(learned.fits ? [] : ['It doesn’t give back enough of your own quotes yet.']),
    // A choice the customer made that none of the owner's quotes priced, like a cheaper finish.
    ...(unpriced ? [`They asked for ${unpriced}, which you haven’t priced yet.`] : []),
    ...doubtsAbout(formula, checks, parts, priced),
  ];
  return {
    drafted: {
      decision: 'quote',
      reason: '',
      lines: priced.lines,
      discount: priced.discount,
      start: '',
      duration: '',
      // A quote it doubts goes out as a range, never as a firm price.
      confidence: doubts.length ? 'low' : 'high',
      reasoning: ['Priced the way your own quotes add up.', ...doubts].join(' '),
    },
    use: { used: true as const, formula, doubts },
  };
}
