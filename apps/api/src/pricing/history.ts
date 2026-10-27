import { tradeName } from '@quotefolk/trades';
import type { PricingHistory } from '../ai/quote-engine.js';
import { rows, type Sql } from '../db.js';
import { ApiError } from '../http.js';
import { json, type Row } from '../models.js';
import { listPastJobs, type PastJob } from '../past-jobs.js';
import {
  quoteTotal,
  type Discount,
  type DraftedQuote,
  type Insight,
  type PracticeScenario,
  type Quote,
} from '../practice/types.js';
import { lossReasonPhrase } from '../live/outcomes.js';
import { describeRate, fitRates, type PricePoint } from './rates.js';
import { describeSpec, specFromScenario, type JobSpec } from './spec.js';
import { parseQuantity } from './units.js';

export type HistoryOptions = {
  /** Leave out one practice run, for the AI's guess on it. */
  excludeRunId?: string;
  /** Leave out one live quote, when replaying it. */
  excludeQuoteId?: string;
  /** Only what the business had taught it before this moment, when replaying an old quote. */
  before?: Date;
};

/** Everything pricing works from, plus the numbers behind it. */
export type PricingData = {
  history: PricingHistory;
  points: PricePoint[];
  jobs: PastJob[];
  tradeId: string | null;
};

/** The real quotes it learns from: the owner's own, and the ones customers answered. */
const LEARNING_STATUSES = "('sent','accepted','visit_requested','lost','expired','declined')";
const LIVE_EXAMPLES = 60;

const centsFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const money = (cents: number) => centsFormat.format(cents / 100);
const monthYear = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

export async function businessContext(businessId: string, connection?: Sql) {
  const [business] = await rows(
    'SELECT name,trade_id,custom_trade,service_area,travel_radius_miles FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  if (!business) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This business is unavailable.');
  const services = (
    await rows(
      'SELECT name FROM offerings WHERE business_id=? ORDER BY position',
      [businessId],
      connection,
    )
  ).map((row) => String(row.name));
  return {
    name: String(business.name || ''),
    tradeId: business.trade_id ? String(business.trade_id) : null,
    trade: tradeName(business.trade_id, business.custom_trade),
    services,
    area: String(business.service_area || ''),
    radiusMiles: business.travel_radius_miles ? Number(business.travel_radius_miles) : null,
  };
}

/** What a past job came to before its discount, so rates aren't pulled down by one-off deals. */
export function undiscounted(price: number, discount: Discount | null) {
  if (!discount) return price;
  if (discount.kind === 'amount') return price + discount.value;
  return discount.value < 100 ? Math.round(price / (1 - discount.value / 100)) : price;
}

/** Where the owner changed the AI's draft before sending it, in a line the AI can learn from. */
export function ownerChange(draft: DraftedQuote | null, sent: Quote): string {
  const sentCents = quoteTotal(sent);
  if (!draft || draft.decision === 'site_visit' || !draft.lines.length)
    return `The AI didn't price it. The owner quoted ${money(sentCents)}.`;
  const draftCents = quoteTotal(draft);
  if (Math.abs(draftCents - sentCents) < Math.max(100, sentCents * 0.01)) {
    const relabeled = draft.lines.some((line, index) => sent.lines[index]?.label !== line.label);
    return relabeled
      ? `The owner kept the AI's ${money(sentCents)} and reworded the lines.`
      : 'The owner sent the AI’s draft as it was.';
  }
  return `The owner changed the AI's ${money(draftCents)} to ${money(sentCents)}.`;
}

function liveOutcome(status: string, reason: string) {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'visit_requested':
      return 'the customer asked for a site visit';
    case 'lost':
      return `turned down: ${lossReasonPhrase(reason)}`;
    case 'expired':
      return 'no answer';
    case 'declined':
      return 'the owner turned the job down';
    default:
      return 'waiting for the customer';
  }
}

/** Real quotes worth learning from. A quote the AI sent alone teaches nothing until it's answered. */
function teaches(row: Row) {
  if (row.sent_by === 'owner' || row.status === 'declined') return true;
  return row.status === 'accepted' || row.status === 'lost';
}

/**
 * Everything the business has taught the AI: past jobs, practice, real quotes and corrections,
 * with the size and price of each one that has a size.
 */
export async function loadPricingData(
  businessId: string,
  options: HistoryOptions = {},
): Promise<PricingData> {
  const context = await businessContext(businessId);
  const before = options.before;
  const jobs = (await listPastJobs(businessId)).filter(
    (job) => !before || new Date(job.createdAt) < before,
  );
  const points: PricePoint[] = [];
  for (const job of jobs) {
    const size = parseQuantity(job.size) ?? parseQuantity(job.description);
    if (size)
      points.push({
        service: job.serviceName,
        ...size,
        cents: undiscounted(job.priceCents, job.discount),
        source: 'job',
      });
  }

  const runs = await rows(
    "SELECT * FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  const messages = await rows(
    "SELECT run_id,sender,text FROM practice_messages WHERE business_id=? AND kind='text' ORDER BY created_at,id",
    [businessId],
  );
  const notes: string[] = [];
  const practice: PricingHistory['practice'] = [];
  for (const run of runs) {
    if (run.id === options.excludeRunId) continue;
    if (before && run.finished_at && new Date(run.finished_at) >= before) continue;
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const quote = json<Quote | null>(run.quote_json, null);
    const conversation = messages
      .filter((message) => message.run_id === run.id)
      .map((message) => `${message.sender === 'owner' ? 'Owner' : 'Customer'}: ${message.text}`)
      .join('\n')
      .slice(0, 1500);
    practice.push({
      service: scenario.serviceName,
      request: conversation,
      outcome: run.outcome === 'site_visit' ? 'site_visit' : 'quote',
      lines: quote?.lines.map(({ label, amountCents }) => ({ label, amountCents })) ?? [],
      discount: quote?.discount ?? null,
      start: quote?.start ?? '',
      duration: quote?.duration ?? '',
      note: quote?.note ?? '',
      siteVisitReason: String(run.site_visit_reason ?? ''),
    });
    const spec = specFromScenario(scenario);
    if (quote?.lines[0] && spec.quantity)
      points.push({
        service: scenario.serviceName,
        quantity: spec.quantity,
        unit: spec.unit,
        cents: quote.lines[0].amountCents,
        source: 'practice',
      });
    for (const insight of json<(Insight & { edited?: boolean })[]>(run.insights_json, []))
      if (insight.edited) notes.push(insight.text);
  }

  const live = (
    await rows(
      `SELECT q.id,q.status,q.sent_by,q.quote_json,q.draft_json,q.outcome_reason,q.sent_at,q.created_at,
        c.service_name,c.summary,c.spec_json
       FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
       WHERE q.business_id=? AND c.source<>'test' AND q.status IN ${LEARNING_STATUSES}${before ? ' AND q.created_at<?' : ''}
       ORDER BY q.created_at DESC LIMIT ${LIVE_EXAMPLES}`,
      before ? [businessId, before] : [businessId],
    )
  )
    .filter((row) => row.id !== options.excludeQuoteId && teaches(row))
    .reverse();
  const liveQuotes: PricingHistory['liveQuotes'] = live.map((row) => {
    const sent = json<Quote>(row.quote_json, {} as Quote);
    const spec = json<JobSpec | null>(row.spec_json, null);
    const declined = row.status === 'declined';
    // Only prices a person chose or a customer took count toward the rate.
    const chosen = row.sent_by === 'owner' || row.status === 'accepted';
    if (chosen && !declined && sent.lines?.[0] && spec?.quantity && spec.unit)
      points.push({
        service: String(row.service_name),
        quantity: spec.quantity,
        unit: spec.unit,
        cents: sent.lines[0].amountCents,
        source: 'quote',
      });
    return {
      service: String(row.service_name),
      request: String(row.summary || ''),
      details: describeSpec(spec),
      outcome: liveOutcome(String(row.status), String(row.outcome_reason || '')),
      lines: declined
        ? []
        : (sent.lines ?? []).map(({ label, amountCents }) => ({ label, amountCents })),
      discount: declined ? null : (sent.discount ?? null),
      ownerChange:
        row.sent_by === 'owner'
          ? ownerChange(json<DraftedQuote | null>(row.draft_json, null), sent)
          : '',
      when: monthYear(row.sent_at ?? row.created_at),
    };
  });

  return {
    history: {
      business: {
        name: context.name,
        trade: context.trade,
        services: context.services,
        area: context.area,
        radiusMiles: context.radiusMiles,
      },
      pastJobs: jobs.map((job) => ({
        service: job.serviceName,
        description: job.description,
        priceCents: job.priceCents,
        size: job.size,
        duration: job.duration,
        when: job.when,
        materialsCents: job.materialsCents,
        discount: job.discount,
        notes: job.notes,
      })),
      practice,
      liveQuotes,
      rates: fitRates(points).map(describeRate),
      notes,
    },
    points,
    jobs,
    tradeId: context.tradeId,
  };
}

/** Everything the business has taught the AI so far, as the AI reads it. */
export async function pricingHistory(
  businessId: string,
  options: HistoryOptions = {},
): Promise<PricingHistory> {
  return (await loadPricingData(businessId, options)).history;
}

/** Examples past this many in all, and it keeps the ones most like the job at hand. */
export const EXAMPLE_LIMIT = 50;
const KEEP = { pastJobs: 25, practice: 10, liveQuotes: 25 };

function closeness(text: string, target: JobSpec | null) {
  if (!target?.quantity || !target.unit) return 0;
  const size = parseQuantity(text);
  if (!size || size.unit !== target.unit) return 0;
  // 1 at the same size, 0 at four times bigger or smaller.
  return Math.max(0, 1 - Math.abs(Math.log(size.quantity / target.quantity)) / Math.log(4));
}

function keepMostAlike<T>(items: T[], limit: number, score: (item: T) => number): T[] {
  if (items.length <= limit) return items;
  const ranked = items
    .map((item, index) => ({ index, score: score(item) + (index / items.length) * 0.5 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.index)
    .sort((a, b) => a - b);
  return ranked.map((index) => items[index]);
}

/**
 * A long history is cut down to the examples most like this request: the same service first,
 * then the closest size, then the most recent. Rates still come from everything.
 */
export function similarHistory(
  history: PricingHistory,
  serviceName: string,
  spec: JobSpec | null,
): PricingHistory {
  const total = history.pastJobs.length + history.practice.length + history.liveQuotes.length;
  if (total <= EXAMPLE_LIMIT) return history;
  const sameService = (service: string) =>
    service.trim().toLowerCase() === serviceName.trim().toLowerCase() ? 2 : 0;
  return {
    ...history,
    pastJobs: keepMostAlike(
      history.pastJobs,
      KEEP.pastJobs,
      (job) => sameService(job.service) + closeness(job.size || job.description, spec),
    ),
    practice: keepMostAlike(history.practice, KEEP.practice, (run) => sameService(run.service)),
    liveQuotes: keepMostAlike(
      history.liveQuotes,
      KEEP.liveQuotes,
      (quote) => sameService(quote.service) + closeness(quote.details, spec),
    ),
  };
}

/** How much this business has taught it about one service. */
export function examplesFor(history: PricingHistory, serviceName: string): number {
  const same = (service: string) =>
    service.trim().toLowerCase() === serviceName.trim().toLowerCase();
  return (
    history.pastJobs.filter((job) => same(job.service)).length +
    history.practice.filter((run) => same(run.service)).length +
    history.liveQuotes.filter((quote) => same(quote.service)).length
  );
}
