import { rows } from '../db.js';
import { iso, json } from '../models.js';
import { quoteTotal, type PracticeScenario, type Quote, type Shadow } from '../practice/types.js';
import { AGREE_PERCENT, closePercentFor, compareDraft, liveRecord } from './accuracy.js';
import { businessContext, loadPricingData } from './history.js';
import { fitRates, sizeRange, SOLID_POINTS, type Rate } from './rates.js';
import { formatNumber, formatQuantity, roundSize } from './units.js';

/** A service is fully trained once this many of its latest drafts were close to the owner's price. */
export const MATCHES_NEEDED = 2;
/** Its latest drafts are this many. Two misses among them and it's back to learning. */
export const RECENT_DRAFTS = 3;
/**
 * Sized prices the main service needs. On the benchmark the formula's prices kept getting closer
 * up to about a dozen examples, most of them for the main service, and barely moved past twenty.
 * The other services need SOLID_POINTS each.
 */
export const MAIN_SIZED_PRICES = 8;
/** The main service counts this much more than another, so it leads the score. */
const MAIN_WEIGHT = 2;
/** The score setup points owners toward: how many more customers to get here. */
export const WELL_TRAINED = 85;

/** One AI draft next to the price the owner chose, from practice or a real quote. */
export type Comparison = { service: string; agree: boolean; at: string };

/** How well the Charm knows one service's prices, and what it still needs. */
export type ServiceReadiness = {
  service: string;
  /** Fully trained: enough sized jobs, and its latest drafts close to the owner's prices. */
  ready: boolean;
  /** Jobs and quotes with a size, in the unit it knows best. */
  sizedPrices: number;
  /** How many of them this service needs: more for the main service. */
  sizedNeeded: number;
  /** Its latest drafts the owner priced next to it, and how many came close. */
  checked: number;
  matched: number;
  /** Sized jobs it still needs before its drafts can be held to a rate. */
  jobsToGo: number;
  /** Close guesses in a row it still needs among its latest drafts. None once it's ready. */
  matchesToGo: number;
  /** "150 to 1,800 sq ft": the sizes it knows. Much bigger or smaller jobs wait for the owner. */
  covers: string;
  /** 0 to 100: how well it knows this service. Half sized jobs, half close guesses. */
  progress: number;
  /** What it still needs, in the owner's terms. Empty once it's ready. */
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
 * The service they do most: the most past jobs and requests, or the first they listed. It needs the
 * most sized prices and leads the score.
 */
export function mainService(services: string[], workload: Record<string, number> = {}) {
  return services.reduce<string | null>(
    (best, service) =>
      best === null || (workload[service.toLowerCase()] ?? 0) > (workload[best.toLowerCase()] ?? 0)
        ? service
        : best,
    null,
  );
}

/**
 * Each service is ready once it has enough sized prices to hold a draft to a rate, and enough of
 * its latest drafts came as close to the owner's price as they asked for (15% unless they set
 * another). A run of misses takes it back to learning. The main service needs more sized prices.
 */
export function serviceReadiness(
  services: string[],
  rates: Rate[],
  comparisons: Comparison[],
  closePercent = AGREE_PERCENT,
  main: string | null = services[0] ?? null,
): ServiceReadiness[] {
  const newestFirst = [...comparisons].sort((a, b) => b.at.localeCompare(a.at));
  return services.map((service) => {
    const needed = main && same(service, main) ? MAIN_SIZED_PRICES : SOLID_POINTS;
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
    const ready = sizedPrices >= needed && matched >= MATCHES_NEEDED;
    const jobsToGo = Math.max(0, needed - sizedPrices);
    const toGo = ready ? 0 : matchesToGo(recent);
    let reason = '';
    if (jobsToGo)
      reason = `It needs ${plural(jobsToGo, `more ${service} job`)} with a size to know your prices.`;
    else if (!ready) {
      const off =
        recent.length - matched >= 2 ? `Its recent ${service} prices were off from yours. ` : '';
      reason = `${off}It needs to come within ${closePercent}% of your price on ${plural(toGo, `more ${service} job`)}.`;
    }
    const progress = ready
      ? 1
      : (Math.min(sizedPrices, needed) / needed + (MATCHES_NEEDED - toGo) / MATCHES_NEEDED) / 2;
    return {
      service,
      ready,
      sizedPrices,
      sizedNeeded: needed,
      checked: recent.length,
      matched,
      jobsToGo,
      matchesToGo: toGo,
      // Sizes it can stand behind once it has a few, even while the main service wants more.
      covers: rate && sizedPrices >= SOLID_POINTS ? covers(rate) : '',
      progress: Math.round(progress * 100),
      reason,
    };
  });
}

/** One thing the owner can do to raise the score: add sized jobs, or practice. */
export type ReadinessStep = {
  service: string;
  action: 'job' | 'practice';
  /** How many more of it the service needs. */
  count: number;
  /** Points one more adds to the score. */
  gain: number;
};

/** The Charm as a whole: how well it knows the owner's work. */
export type AgentReadiness = {
  /** 0 to 100. 100 once every service is fully trained. The services they do most count most. */
  score: number;
  /** The step that would raise it most. Null at 100. */
  next: ReadinessStep | null;
  /** One step for each service still learning, the biggest gain first. */
  steps: ReadinessStep[];
  /**
   * About how many more practice customers would take the score to WELL_TRAINED, if their prices
   * come close: each adds a sized price and a guess to check. 0 once it's there.
   */
  toWellTrained: number;
};

const progressOf = (sized: number, needed: number, matchesToGo: number) =>
  sized >= needed && matchesToGo === 0
    ? 100
    : Math.round(
        ((Math.min(sized, needed) / needed + (MATCHES_NEEDED - matchesToGo) / MATCHES_NEEDED) / 2) *
          100,
      );

/**
 * Each service's progress, weighted by how often it comes up: one for being offered, plus each
 * past job and each real request in the last 90 days, plus a little more for the main service. A
 * service they rarely do barely counts.
 */
export function agentReadiness(
  services: ServiceReadiness[],
  workload: Record<string, number>,
): AgentReadiness {
  const main = mainService(
    services.map((item) => item.service),
    workload,
  );
  const weight = (service: string) =>
    1 + (workload[service.toLowerCase()] ?? 0) + (main && same(service, main) ? MAIN_WEIGHT : 0);
  const total = services.reduce((sum, item) => sum + weight(item.service), 0);
  if (!total) return { score: 0, next: null, steps: [], toWellTrained: 0 };
  const scoreOf = (progress: number[]) =>
    Math.floor(
      services.reduce((sum, item, index) => sum + weight(item.service) * progress[index], 0) /
        total,
    );
  const score = scoreOf(services.map((item) => item.progress));
  const steps = services
    .filter((item) => !item.ready)
    .map((item): ReadinessStep => {
      // A job with a size is the quickest step while it's short of them; then guesses to check.
      const action = item.jobsToGo ? 'job' : 'practice';
      const step = action === 'job' ? 50 / item.sizedNeeded : 50 / MATCHES_NEEDED;
      return {
        service: item.service,
        action,
        count: action === 'job' ? item.jobsToGo : item.matchesToGo,
        gain: Math.max(1, Math.round((weight(item.service) * step) / total)),
      };
    })
    // Stable, so services with the same gain keep the owner's order.
    .sort((a, b) => b.gain - a.gain);

  // Practice customers to WELL_TRAINED: each one goes where it raises the score most.
  const state = services.map((item) => ({
    sized: item.sizedPrices,
    needed: item.sizedNeeded,
    toGo: item.matchesToGo,
  }));
  let toWellTrained = 0;
  let current = score;
  while (current < WELL_TRAINED && toWellTrained < 40) {
    const options = state.map((item, index) => {
      const next = state.map((other, at) =>
        at === index
          ? progressOf(other.sized + 1, other.needed, Math.max(0, other.toGo - 1))
          : progressOf(other.sized, other.needed, other.toGo),
      );
      return { index, score: scoreOf(next) };
    });
    const best = options.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score <= current) break;
    state[best.index] = {
      ...state[best.index],
      sized: state[best.index].sized + 1,
      toGo: Math.max(0, state[best.index].toGo - 1),
    };
    current = best.score;
    toWellTrained++;
  }
  return {
    score: steps.length ? Math.min(score, 99) : 100,
    next: steps[0] ?? null,
    steps,
    toWellTrained,
  };
}

/** How often each service comes up, by lowercase name: past jobs, and requests in 90 days. */
export async function serviceWorkload(businessId: string): Promise<Record<string, number>> {
  const counts = await rows(
    `SELECT LOWER(service_name) AS service, COUNT(*) AS count FROM past_jobs WHERE business_id=? GROUP BY LOWER(service_name)
     UNION ALL
     SELECT LOWER(service_name), COUNT(*) FROM lead_chats WHERE business_id=? AND source<>'test' AND service_name<>'' AND created_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 90 DAY) GROUP BY LOWER(service_name)`,
    [businessId, businessId],
  );
  const workload: Record<string, number> = {};
  for (const row of counts)
    workload[String(row.service)] = (workload[String(row.service)] ?? 0) + Number(row.count);
  return workload;
}

/**
 * Every draft the owner priced next to it. A practice customer the owner wanted to see first
 * says nothing about price, unless the AI would have priced it anyway.
 */
async function comparisons(businessId: string, closePercent: number): Promise<Comparison[]> {
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
    return [{ service, agree: compareDraft(shadow, quoteTotal(quote), closePercent).agree, at }];
  });
  const live = (await liveRecord(businessId, closePercent)).map((item) => ({
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
  const close = await closePercentFor(businessId);
  const workload = await serviceWorkload(businessId);
  if (rates) {
    const services = (await businessContext(businessId)).services;
    return serviceReadiness(
      services,
      rates,
      await comparisons(businessId, close),
      close,
      mainService(services, workload),
    );
  }
  const data = await loadPricingData(businessId);
  const services = data.history.business.services;
  return serviceReadiness(
    services,
    fitRates(data.points),
    await comparisons(businessId, close),
    close,
    mainService(services, workload),
  );
}
