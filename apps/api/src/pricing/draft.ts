import { unsettledDrivers } from '../ai/drivers.js';
import { aiMode, aiProvider, modelFor, type AiImage } from '../ai/index.js';
import { DRAFT_PROMPT_VERSION, draftQuote, type DraftRequest } from '../ai/quote-engine.js';
import { rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import type { PastJob } from '../past-jobs.js';
import { quoteTotal, subtotal, type DraftEngine, type DraftedQuote } from '../practice/types.js';
import { getPhoto } from '../storage.js';
import {
  currentFormula,
  ifPrices,
  priceDrivers,
  priceFromFormula,
  type IfPrice,
} from './formula-draft.js';
import { examplesFor, loadPricingData, similarHistory, type HistoryOptions } from './history.js';
import { marketPricesEnabled, marketRate } from './market.js';
import { describeRate, estimateFor, fitRates, median, type Estimate, type Rate } from './rates.js';
import { describeJob, type JobSpec } from './spec.js';
import { formatQuantity, parseQuantity } from './units.js';
import { money, roughMoney, type Currency } from '../money.js';
import { minimumCharge } from '../turn-downs.js';

/** Which formula pricing a draft came from, recorded with it like the draft prompt's version. */
const FORMULA_VERSION = 'formula-2026-11-01';

/** Photos from the owner's own past jobs that go with a draft, next to the customer's. */
const REFERENCE_PHOTOS = 2;
const MAX_PHOTOS = 5;

export type DraftResult = {
  drafted: DraftedQuote;
  engine: DraftEngine;
  estimate: Estimate | null;
  /** Every rate it worked out, which the live checks hold the draft to. */
  rates: Rate[];
  /**
   * With `drivers`, what the owner's price depends on that the customer hasn't settled, the
   * question that would settle it, and what each would change the price by.
   */
  unsettled?: { open: string[]; question: string; chips: string[]; ifs: IfPrice[] };
};

/** Demo mode: the owner's usual rate for this size, or else the middle of their similar jobs. */
export function demoDraft(
  jobs: { priceCents: number; serviceName: string }[],
  serviceName: string,
  estimate: Estimate | null,
): DraftedQuote {
  const similar = jobs.filter((job) => job.serviceName === serviceName);
  const pool = (similar.length ? similar : jobs).map((job) => job.priceCents);
  const cents = estimate?.cents ?? (pool.length ? Math.round(median(pool)) : 0);
  return {
    decision: 'quote',
    reason: '',
    lines: cents ? [{ label: serviceName || 'Job as described', amountCents: cents }] : [],
    discount: null,
    start: 'Next week',
    duration: '',
    confidence: estimate?.solid ? 'high' : cents ? 'medium' : 'low',
    reasoning: estimate
      ? 'Demo mode: your usual rate for this size.'
      : 'Demo mode: the middle price of your similar past jobs.',
  };
}

/**
 * The owner's minimum as a floor on the total: a smaller job's first line is raised to it, and a
 * discount never takes the total under it.
 */
export function withMinimum(
  drafted: DraftedQuote,
  minimumCents: number | null,
  currency: Currency = 'USD',
): DraftedQuote {
  if (!minimumCents || drafted.decision !== 'quote' || !drafted.lines.length) return drafted;
  if (quoteTotal(drafted) >= minimumCents) return drafted;
  const reasoning = [drafted.reasoning, `Raised to your ${money(minimumCents, currency)} minimum.`]
    .filter(Boolean)
    .join(' ');
  const before = subtotal(drafted);
  if (before < minimumCents)
    return {
      ...drafted,
      discount: null,
      reasoning,
      lines: drafted.lines.map((line, index) =>
        index === 0 ? { ...line, amountCents: line.amountCents + minimumCents - before } : line,
      ),
    };
  const off = before - minimumCents;
  return {
    ...drafted,
    reasoning,
    discount:
      off > 0 ? { kind: 'amount', value: off, reason: drafted.discount?.reason ?? '' } : null,
  };
}

/** The owner's past-job photos most like this request: same service, then the closest size. */
async function referencePhotos(
  businessId: string,
  jobs: PastJob[],
  serviceName: string,
  spec: JobSpec | null,
  count: number,
  currency: Currency,
) {
  if (count <= 0) return [];
  const score = (job: PastJob) => {
    let value = job.serviceName.toLowerCase() === serviceName.toLowerCase() ? 2 : 0;
    const size = parseQuantity(job.size) ?? parseQuantity(job.description);
    if (spec?.quantity && size && size.unit === spec.unit)
      value += Math.max(0, 1 - Math.abs(Math.log(size.quantity / spec.quantity)) / Math.log(4));
    return value;
  };
  const picked = jobs
    .filter((job) => job.photos.length && score(job) >= 2)
    .sort((a, b) => score(b) - score(a))
    .slice(0, count);
  const photos: { image: AiImage; label: string }[] = [];
  for (const job of picked) {
    const [photo] = await rows(
      "SELECT storage_key FROM attachments WHERE id=? AND business_id=? AND purpose='past_job'",
      [job.photos[0].id, businessId],
    );
    if (!photo) continue;
    try {
      photos.push({
        image: {
          mimeType: 'image/jpeg',
          dataBase64: (await getPhoto(String(photo.storage_key))).toString('base64'),
        },
        label: `${job.description.slice(0, 120)} (${roughMoney(job.priceCents, currency)})`,
      });
    } catch {
      // A missing photo only means one less example to look at.
    }
  }
  return photos;
}

/**
 * Drafts a quote the way this owner would. Live quotes and the practice guesses both come
 * through here, so they price the same way and record what priced them.
 */
export async function draftForBusiness(input: {
  businessId: string;
  serviceName: string;
  conversation: DraftRequest['conversation'];
  spec: JobSpec | null;
  /** What was measured and seen in the customer's video and photos, in words. */
  media?: string[];
  images: AiImage[];
  history?: HistoryOptions;
  /** A model to try instead of the configured one, when replaying past quotes. */
  model?: string;
  /** What demo mode answers instead of a model. */
  demo?: () => DraftedQuote;
  /** False to leave the owner's formula out, so the benchmark can compare the two. */
  formula?: boolean;
  /** Also find what the price depends on that the customer hasn't settled. Live quotes only. */
  drivers?: boolean;
}): Promise<DraftResult> {
  const { businessId, serviceName, spec } = input;
  const data = await loadPricingData(businessId, input.history);
  const { currency } = data.history.business;
  const rates = fitRates(data.points);
  const estimate = estimateFor(rates, serviceName, spec?.quantity ?? null, spec?.unit ?? '');
  // Today's minimum, like today's formula: a replay of an old quote goes without it.
  const minimum = input.history?.before ? null : await minimumCharge(businessId);
  const examples = {
    pastJobs: data.history.pastJobs.length,
    practice: data.history.practice.length,
    liveQuotes: data.history.liveQuotes.length,
  };

  // The owner's formula prices it when it fits their quotes and covers the job. A replay of an old
  // quote, or another model, goes the usual way, since the formula is today's.
  if (aiMode !== 'demo' && input.formula !== false && !input.model && !input.history?.before) {
    const learned = await currentFormula(businessId, data).catch((error: unknown) => {
      reportError(error, { event: 'formula_draft' });
      return null;
    });
    // Asked alongside the price, so it adds no wait.
    const drivers = input.drivers && learned ? priceDrivers(learned) : null;
    const [priced, open] = await Promise.all([
      learned
        ? priceFromFormula(learned, { ...input, currency }).catch((error: unknown) => {
            reportError(error, { event: 'formula_draft' });
            return null;
          })
        : null,
      drivers
        ? unsettledDrivers({
            conversation: input.conversation,
            details: describeJob(spec, input.media) || undefined,
            conditions: drivers.conditions,
            extras: drivers.extras.map((extra) => extra.name),
          }).catch((error: unknown) => {
            reportError(error, { event: 'unsettled_drivers' });
            return null;
          })
        : null,
    ]);
    if (priced?.drafted)
      return {
        drafted: withMinimum(priced.drafted, minimum, currency),
        ...(open && priced.use.used
          ? {
              unsettled: {
                ...open,
                ifs: ifPrices(priced.use.formula, priced.use.parts, open.open),
              },
            }
          : {}),
        estimate,
        rates,
        engine: {
          provider: aiProvider,
          model: modelFor('read_job') ?? null,
          promptVersion: FORMULA_VERSION,
          estimateCents: estimate?.cents ?? null,
          estimateBasis: '',
          estimateSolid: Boolean(estimate?.solid),
          startingPoint: false,
          examples,
          referencePhotos: 0,
          formula: true,
        },
      };
  }

  let startingPoint: DraftRequest['startingPoint'];
  if (!examplesFor(data.history, serviceName) && marketPricesEnabled() && data.tradeId) {
    const market = await marketRate({
      businessId,
      tradeId: data.tradeId,
      serviceName,
      unit: spec?.unit || undefined,
    });
    if (market)
      startingPoint = {
        basis: `About ${roughMoney(market.upperCentsPerUnit, currency)} per ${market.unit.replace(/s$/, '')}, a little above the middle rate of ${market.businesses} other ${data.history.business.trade.toLowerCase()} businesses`,
        mainWorkCents:
          spec?.quantity && spec.unit === market.unit
            ? Math.round((market.upperCentsPerUnit * spec.quantity) / 100) * 100
            : null,
      };
  }

  const customerImages = input.images.slice(0, 3);
  const reference =
    aiMode === 'demo'
      ? []
      : await referencePhotos(
          businessId,
          data.jobs,
          serviceName,
          spec,
          Math.min(REFERENCE_PHOTOS, MAX_PHOTOS - customerImages.length),
          currency,
        );
  const photoGuide = [
    ...customerImages.map((_, index) => `Photo ${index + 1}: from the customer`),
    ...reference.map(
      (photo, index) =>
        `Photo ${customerImages.length + index + 1}: from the owner's past job, ${photo.label}`,
    ),
  ];

  const history = similarHistory(data.history, serviceName, spec);
  const estimateBasis = estimate
    ? `${formatQuantity(estimate.quantity, estimate.unit)} at the usual rate comes to ${roughMoney(estimate.cents, currency)}. ${describeRate(estimate.rate, currency)}`
    : '';
  let drafted =
    aiMode === 'demo'
      ? (input.demo?.() ?? demoDraft(data.jobs, serviceName, estimate))
      : await draftQuote({
          history,
          request: {
            serviceName,
            conversation: input.conversation,
            details: describeJob(spec, input.media) || undefined,
            estimate: estimate
              ? { mainWorkCents: estimate.cents, basis: estimateBasis }
              : undefined,
            startingPoint,
            photoGuide: photoGuide.length ? photoGuide : undefined,
          },
          images: [...customerImages, ...reference.map((photo) => photo.image)],
          model: input.model,
        });
  // A service they haven't priced yet still doesn't go under the least they've charged for any
  // job: a guess below every price they've ever given reads as them overcharging.
  const ownPrices = data.points.filter(
    (point) => point.service.trim().toLowerCase() === serviceName.trim().toLowerCase(),
  );
  const lowest = Math.min(...data.points.map((point) => point.cents).filter((cents) => cents > 0));
  const short = !ownPrices.length && Number.isFinite(lowest) ? lowest - subtotal(drafted) : 0;
  if (drafted.decision === 'quote' && drafted.lines.length && short > 0)
    drafted = {
      ...drafted,
      lines: drafted.lines.map((line, index) =>
        index === 0 ? { ...line, amountCents: line.amountCents + short } : line,
      ),
    };
  // A price from other businesses is a first guess. The owner always sees it before it goes out.
  if (startingPoint) drafted = { ...drafted, confidence: 'low' };
  drafted = withMinimum(drafted, minimum, currency);

  return {
    drafted,
    estimate,
    rates,
    engine: {
      provider: aiProvider,
      model: aiMode === 'demo' ? null : (input.model ?? modelFor('draft_quote') ?? null),
      promptVersion: DRAFT_PROMPT_VERSION,
      estimateCents: estimate?.cents ?? null,
      estimateBasis,
      estimateSolid: Boolean(estimate?.solid),
      startingPoint: Boolean(startingPoint),
      examples: {
        pastJobs: history.pastJobs.length,
        practice: history.practice.length,
        liveQuotes: history.liveQuotes.length,
      },
      referencePhotos: reference.length,
      formula: false,
    },
  };
}
