import { rows } from '../db.js';
import { iso, json } from '../models.js';
import { quoteTotal, type PracticeScenario, type Quote, type Shadow } from '../practice/types.js';
import { AGREE_PERCENT, compareDraft, liveRecord } from './accuracy.js';
import { businessContext, loadPricingData } from './history.js';
import { fitRates, sizeRange, SOLID_POINTS, type Rate } from './rates.js';
import { formatNumber, formatQuantity, roundSize } from './units.js';

/** A service sends on its own once this many of its latest drafts were close to the owner's price. */
export const MATCHES_NEEDED = 2;
/** Its latest drafts are this many. Two misses among them and it waits for the owner again. */
export const RECENT_DRAFTS = 3;

/** One AI draft next to the price the owner chose, from practice or a real quote. */
export type Comparison = { service: string; agree: boolean; at: string };

/** Whether one service's quotes can go out without the owner, and what it needs if not. */
export type ServiceReadiness = {
  service: string;
  ready: boolean;
  /** Jobs and quotes with a size, in the unit it knows best. */
  sizedPrices: number;
  /** Its latest drafts the owner priced next to it, and how many came close. */
  checked: number;
  matched: number;
  /** Sized jobs it still needs before its drafts can be held to a rate. */
  jobsToGo: number;
  /** Close guesses in a row it still needs among its latest drafts. None once it's ready. */
  matchesToGo: number;
  /** "150 to 1,800 sq ft": the sizes it sends on its own. Bigger or smaller jobs wait. */
  covers: string;
  /** Why its quotes wait for the owner, in their terms. Empty once it's ready. */
  reason: string;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Close matches it still needs, one after another, to have enough among its latest drafts. */
function matchesToGo(recent: boolean[]) {
  let window = recent,
    more = 0;
  while (window.filter(Boolean).length < MATCHES_NEEDED) {
    window = [true, ...window].slice(0, RECENT_DRAFTS);
    more++;
  }
  return more;
}

/** "150 to 1,800 sq ft", rounded inward so it never claims a size it won't send. */
function covers(rate: Rate) {
  const { from, to } = sizeRange(rate);
  return `${formatNumber(roundSize(from, 'up'))} to ${formatQuantity(roundSize(to, 'down'), rate.unit)}`;
}

/**
 * Each service is ready once it has enough sized prices to hold a draft to a rate, and enough of
 * its latest drafts came within 15% of the owner. A run of misses takes it back to the owner.
 */
export function serviceReadiness(
  services: string[],
  rates: Rate[],
  comparisons: Comparison[],
): ServiceReadiness[] {
  const newestFirst = [...comparisons].sort((a, b) => b.at.localeCompare(a.at));
  return services.map((service) => {
    // Its rate is the unit it's priced by most often, like the one its drafts are checked against.
    const rate = rates
      .filter((item) => same(item.service, service))
      .sort((a, b) => b.points - a.points)[0];
    const sizedPrices = rate?.points ?? 0;
    const recent = newestFirst
      .filter((item) => same(item.service, service))
      .slice(0, RECENT_DRAFTS)
      .map((item) => item.agree);
    const matched = recent.filter(Boolean).length;
    const ready = sizedPrices >= SOLID_POINTS && matched >= MATCHES_NEEDED;
    const jobsToGo = Math.max(0, SOLID_POINTS - sizedPrices);
    const toGo = ready ? 0 : matchesToGo(recent);
    let reason = '';
    if (jobsToGo)
      reason = `It needs ${plural(jobsToGo, `more ${service} job`)} with a size before it sends these on its own.`;
    else if (!ready) {
      const off =
        recent.length - matched >= 2 ? `Its recent ${service} prices were off from yours. ` : '';
      reason = `${off}It needs to come within ${AGREE_PERCENT}% of your price on ${plural(toGo, `more ${service} job`)} before it sends these on its own.`;
    }
    return {
      service,
      ready,
      sizedPrices,
      checked: recent.length,
      matched,
      jobsToGo,
      matchesToGo: toGo,
      covers: rate && !jobsToGo ? covers(rate) : '',
      reason,
    };
  });
}

/**
 * Every draft the owner priced next to it. A practice customer the owner wanted to see first
 * says nothing about price, unless the AI would have priced it anyway.
 */
async function comparisons(businessId: string): Promise<Comparison[]> {
  const runs = await rows(
    "SELECT scenario_json,outcome,quote_json,shadow_json,finished_at FROM practice_runs WHERE business_id=? AND status='finished' AND shadow_json IS NOT NULL",
    [businessId],
  );
  const practice = runs.flatMap((run): Comparison[] => {
    const shadow = json<Shadow | null>(run.shadow_json, null);
    const quote = json<Quote | null>(run.quote_json, null);
    const service = json<Partial<PracticeScenario>>(run.scenario_json, {}).serviceName ?? '';
    const at = iso(run.finished_at);
    if (run.outcome === 'site_visit')
      return shadow?.decision === 'quote' && shadow.lines.length
        ? [{ service, agree: false, at }]
        : [];
    if (!shadow || !quote) return [];
    return [{ service, agree: compareDraft(shadow, quoteTotal(quote)).agree, at }];
  });
  const live = (await liveRecord(businessId)).map((item) => ({
    service: item.service,
    agree: item.agree,
    at: item.sentAt,
  }));
  return [...practice, ...live];
}

/** Every service the business offers, and whether its quotes can go out on their own. */
export async function businessReadiness(
  businessId: string,
  rates?: Rate[],
): Promise<ServiceReadiness[]> {
  if (rates)
    return serviceReadiness(
      (await businessContext(businessId)).services,
      rates,
      await comparisons(businessId),
    );
  const data = await loadPricingData(businessId);
  return serviceReadiness(
    data.history.business.services,
    fitRates(data.points),
    await comparisons(businessId),
  );
}
