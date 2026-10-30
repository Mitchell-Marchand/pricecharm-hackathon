import { aiMode, aiProvider, modelFor, type AiImage } from '../ai/index.js';
import { DRAFT_PROMPT_VERSION, draftQuote, type DraftRequest } from '../ai/quote-engine.js';
import { rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import type { PastJob } from '../past-jobs.js';
import type { DraftEngine, DraftedQuote } from '../practice/types.js';
import { getPhoto } from '../storage.js';
import { currentFormula, priceFromFormula } from './formula-draft.js';
import { examplesFor, loadPricingData, similarHistory, type HistoryOptions } from './history.js';
import { marketPricesEnabled, marketRate } from './market.js';
import { describeRate, estimateFor, fitRates, median, type Estimate, type Rate } from './rates.js';
import { describeSpec, type JobSpec } from './spec.js';
import { formatQuantity, parseQuantity } from './units.js';

/** Which formula pricing a draft came from, recorded with it like the draft prompt's version. */
const FORMULA_VERSION = 'formula-2026-10-30';

/** Photos from the owner's own past jobs that go with a draft, next to the customer's. */
const REFERENCE_PHOTOS = 2;
const MAX_PHOTOS = 5;

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: cents < 1000 ? 2 : 0,
  }).format(cents / 100);

export type DraftResult = {
  drafted: DraftedQuote;
  engine: DraftEngine;
  estimate: Estimate | null;
  /** Every rate it worked out, which the live checks hold the draft to. */
  rates: Rate[];
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

/** The owner's past-job photos most like this request: same service, then the closest size. */
async function referencePhotos(
  businessId: string,
  jobs: PastJob[],
  serviceName: string,
  spec: JobSpec | null,
  count: number,
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
        label: `${job.description.slice(0, 120)} (${money(job.priceCents)})`,
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
  images: AiImage[];
  history?: HistoryOptions;
  /** A model to try instead of the configured one, when replaying past quotes. */
  model?: string;
  /** What demo mode answers instead of a model. */
  demo?: () => DraftedQuote;
  /** False to leave the owner's formula out, so the benchmark can compare the two. */
  formula?: boolean;
}): Promise<DraftResult> {
  const { businessId, serviceName, spec } = input;
  const data = await loadPricingData(businessId, input.history);
  const rates = fitRates(data.points);
  const estimate = estimateFor(rates, serviceName, spec?.quantity ?? null, spec?.unit ?? '');
  const examples = {
    pastJobs: data.history.pastJobs.length,
    practice: data.history.practice.length,
    liveQuotes: data.history.liveQuotes.length,
  };

  // The owner's formula prices it when it fits their quotes and covers the job. A replay of an old
  // quote, or another model, goes the usual way, since the formula is today's.
  if (aiMode !== 'demo' && input.formula !== false && !input.model && !input.history?.before) {
    const priced = await currentFormula(businessId, data)
      .then((learned) => (learned ? priceFromFormula(learned, input) : null))
      .catch((error: unknown) => {
        reportError(error, { event: 'formula_draft' });
        return null;
      });
    if (priced?.drafted)
      return {
        drafted: priced.drafted,
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
        basis: `About ${money(market.centsPerUnit)} per ${market.unit.replace(/s$/, '')}, the middle rate of ${market.businesses} other ${data.history.business.trade.toLowerCase()} businesses`,
        mainWorkCents:
          spec?.quantity && spec.unit === market.unit
            ? Math.round((market.centsPerUnit * spec.quantity) / 100) * 100
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
    ? `${formatQuantity(estimate.quantity, estimate.unit)} at the usual rate comes to ${money(estimate.cents)}. ${describeRate(estimate.rate)}`
    : '';
  let drafted =
    aiMode === 'demo'
      ? (input.demo?.() ?? demoDraft(data.jobs, serviceName, estimate))
      : await draftQuote({
          history,
          request: {
            serviceName,
            conversation: input.conversation,
            details: describeSpec(spec) || undefined,
            estimate: estimate
              ? { mainWorkCents: estimate.cents, basis: estimateBasis }
              : undefined,
            startingPoint,
            photoGuide: photoGuide.length ? photoGuide : undefined,
          },
          images: [...customerImages, ...reference.map((photo) => photo.image)],
          model: input.model,
        });
  // A price from other businesses is a first guess. The owner always sees it before it goes out.
  if (startingPoint) drafted = { ...drafted, confidence: 'low' };

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
