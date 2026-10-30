import { createHash } from 'node:crypto';
import type { AiImage } from '../ai/index.js';
import {
  learnFormula,
  readJobParts,
  type FormulaExample,
  type LearnedFormula,
} from '../ai/formula.js';
import type { PricingHistory } from '../ai/quote-engine.js';
import { quoteTotal, type DraftedQuote } from '../practice/types.js';
import { draftForBusiness } from './draft.js';
import {
  fitGaps,
  formulaFits,
  ownerRounding,
  priceJob,
  refineFormula,
  type PriceFormula,
} from './formula.js';
import { loadPricingData, type HistoryOptions } from './history.js';
import { describeSpec, type JobSpec } from './spec.js';
import { canonicalUnit } from './units.js';

/**
 * Formula pricing: the owner's formula, worked out from their quotes and checked against all of
 * them, prices the job; the AI only reads the request. Whenever the formula doesn't fit the
 * owner's own quotes, or the job asks for something it doesn't cover, the AI drafts the quote the
 * usual way instead, so nothing is forced into a formula that doesn't hold.
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

export type Learned = LearnedFormula & {
  /** How far the formula's price is from each example's total, in percent. */
  gaps: (number | null)[];
  fits: boolean;
};

const learning = new Map<string, Promise<Learned | null>>();
let failedHoldMs: number | null = 10 * 60_000;

/**
 * How long quotes go the usual way after a formula fails to work out, before it's tried again:
 * ten minutes by default, or never again in this process with null (the benchmark, so a long run
 * doesn't keep retrying the same owners).
 */
export function holdFailedFormulas(ms: number | null) {
  failedHoldMs = ms;
}

/**
 * The owner's formula, worked out once for what they've taught so far. Null when there are too
 * few examples to work one out from.
 */
export function learnedFormula(
  businessId: string,
  history: HistoryOptions = {},
  model?: string,
): Promise<Learned | null> {
  return loadPricingData(businessId, history).then((data) => {
    const examples = formulaExamples(data.history);
    if (examples.length < 3) return null;
    const key = `${businessId}:${model ?? ''}:${createHash('sha256').update(JSON.stringify(examples)).digest('hex')}`;
    let pending = learning.get(key);
    if (!pending) {
      const ask = (quick: boolean) =>
        learnFormula({
          quick,
          business: {
            trade: data.history.business.trade,
            services: data.history.business.services,
          },
          examples,
          model,
        });
      // Working out a formula reasons at length, and the API sometimes gives up on long calls,
      // so it gets two more tries before the quote falls back to the usual draft.
      const attempt = async (tries: number): Promise<Awaited<ReturnType<typeof ask>>> => {
        try {
          // The last try reasons less, so it finishes inside its allowance.
          return await ask(tries <= 1);
        } catch (error) {
          if (tries <= 1) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return attempt(tries - 1);
        }
      };
      pending = attempt(3).then((answer) => {
        // Rounding is counted from what they wrote: every line, and every total with no discount.
        const learned = {
          ...answer,
          formula: {
            ...answer.formula,
            roundToCents: ownerRounding(
              examples.flatMap((example) =>
                example.lines
                  ? example.lines.map((line) => line.amountCents)
                  : example.discount
                    ? []
                    : [example.totalCents],
              ),
            ),
          },
        };
        const parts = new Map(learned.examples.map((example) => [example.index, example]));
        const checked = examples.flatMap((example) => {
          const found = parts.get(example.index);
          return found ? [{ parts: found, totalCents: example.totalCents }] : [];
        });
        const formula = refineFormula(learned.formula, checked);
        const gaps = examples.map((example) => {
          const found = parts.get(example.index);
          return found
            ? fitGaps(formula, [{ parts: found, totalCents: example.totalCents }])[0]
            : null;
        });
        return { ...learned, formula, gaps, fits: formulaFits(gaps) };
      });
      // After a failure, quotes go the usual way for ten minutes before it's tried again, so a
      // run of quotes doesn't retry the same long call one after another.
      pending.catch(() => {
        if (failedHoldMs !== null) setTimeout(() => learning.delete(key), failedHoldMs).unref();
      });
      learning.set(key, pending);
    }
    return pending;
  });
}

export type FormulaUse = { used: true; formula: PriceFormula } | { used: false; reason: string };

/** The job's size from what the customer said, when it's in the unit the formula prices by. */
function measuredSize(formula: PriceFormula, service: string, spec: JobSpec | null) {
  const rule = formula.services.find((item) => item.name.toLowerCase() === service.toLowerCase());
  if (!rule || !spec?.quantity || !spec.unit) return null;
  const unit = canonicalUnit(rule.unit) ?? rule.unit;
  return unit === spec.unit ? spec.quantity : null;
}

/**
 * Drafts the quote from the owner's formula when it fits, else the usual way. Takes the same
 * input as draftForBusiness.
 */
export async function draftWithFormula(input: {
  businessId: string;
  serviceName: string;
  conversation: { from: 'customer' | 'owner'; text: string }[];
  spec: JobSpec | null;
  images: AiImage[];
  history?: HistoryOptions;
  model?: string;
}): Promise<{ drafted: DraftedQuote; use: FormulaUse }> {
  const fallback = async (reason: string) => ({
    drafted: (await draftForBusiness(input)).drafted,
    use: { used: false as const, reason },
  });
  let learned: Learned | null;
  try {
    learned = await learnedFormula(input.businessId, input.history, input.model);
  } catch (error) {
    return fallback(
      `it couldn’t work out a formula (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!learned) return fallback('too few priced jobs for a formula');
  if (!learned.fits) return fallback('the formula doesn’t give back the owner’s own prices');
  const { formula } = learned;
  const read = await readJobParts({
    formula,
    request: {
      serviceName: input.serviceName,
      conversation: input.conversation,
      details: describeSpec(input.spec) || undefined,
    },
    model: input.model,
  });
  if (read.uncovered) return fallback(`the formula doesn’t cover ${read.uncovered}`);
  const parts = { ...read, size: measuredSize(formula, read.service, input.spec) ?? read.size };
  const priced = priceJob(formula, parts);
  if (!priced) return fallback('the formula can’t price this job');
  return {
    drafted: {
      decision: 'quote',
      reason: '',
      lines: priced.lines,
      discount: priced.discount,
      start: '',
      duration: '',
      confidence: 'high',
      reasoning: 'Priced from the formula worked out from your own quotes.',
    },
    use: { used: true, formula },
  };
}
