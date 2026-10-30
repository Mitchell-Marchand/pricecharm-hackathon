import { rows } from '../db.js';
import { json } from '../models.js';
import { pooledChat } from '../channels/pooled.js';
import type { Discount, PracticeScenario, Quote } from '../practice/types.js';
import { undiscounted } from './history.js';
import { median } from './rates.js';
import { specFromScenario, type JobSpec } from './spec.js';
import { parseQuantity } from './units.js';

/**
 * A starting price for a service a business has never priced, from other businesses in the same
 * trade. Only combined rates leave a business: never one business's prices, name or jobs, and
 * nothing at all until enough businesses make up the rate.
 */
export const MARKET_MIN_BUSINESSES = 5;

/** Off unless MARKET_PRICES=on, so it only runs where the Terms allow it. */
export function marketPricesEnabled(): boolean {
  return process.env.MARKET_PRICES === 'on';
}

export type MarketRate = { centsPerUnit: number; unit: string; businesses: number };

/**
 * One rate from many businesses' own rates: each business's middle rate counts once, however
 * many jobs it has, and the result is the middle of those. Null under the minimum.
 */
export function combineRates(
  rates: { businessId: string; unit: string; centsPerUnit: number }[],
  unit?: string,
): MarketRate | null {
  const byUnit = new Map<string, Map<string, number[]>>();
  for (const rate of rates) {
    if (!(rate.centsPerUnit > 0) || (unit && rate.unit !== unit)) continue;
    const businesses = byUnit.get(rate.unit) ?? new Map<string, number[]>();
    businesses.set(rate.businessId, [
      ...(businesses.get(rate.businessId) ?? []),
      rate.centsPerUnit,
    ]);
    byUnit.set(rate.unit, businesses);
  }
  const [chosen] = [...byUnit.entries()].sort((a, b) => b[1].size - a[1].size);
  if (!chosen || chosen[1].size < MARKET_MIN_BUSINESSES) return null;
  const perBusiness = [...chosen[1].values()].map((values) => median(values));
  return { centsPerUnit: median(perBusiness), unit: chosen[0], businesses: perBusiness.length };
}

const OTHERS = "b.trade_id=? AND b.id<>? AND b.status='active' AND b.deletion_requested_at IS NULL";

/** The trade's combined rate for a service, from other businesses' jobs, practice and quotes. */
export async function marketRate(input: {
  businessId: string;
  tradeId: string;
  serviceName: string;
  unit?: string;
}): Promise<MarketRate | null> {
  const service = input.serviceName.trim().toLowerCase();
  const params = [input.tradeId, input.businessId];
  const rates: { businessId: string; unit: string; centsPerUnit: number }[] = [];
  const add = (
    businessId: unknown,
    size: { quantity: number; unit: string } | null,
    cents: number,
  ) => {
    if (size && size.quantity > 0 && cents > 0)
      rates.push({
        businessId: String(businessId),
        unit: size.unit,
        centsPerUnit: cents / size.quantity,
      });
  };

  for (const job of await rows(
    `SELECT j.business_id,j.size,j.description,j.price_cents,j.discount_kind,j.discount_value
     FROM past_jobs j JOIN businesses b ON b.id=j.business_id
     WHERE ${OTHERS} AND LOWER(j.service_name)=?`,
    [...params, service],
  )) {
    const discount = job.discount_kind
      ? ({ kind: job.discount_kind, value: Number(job.discount_value), reason: '' } as Discount)
      : null;
    add(
      job.business_id,
      parseQuantity(String(job.size)) ?? parseQuantity(String(job.description)),
      undiscounted(Number(job.price_cents), discount),
    );
  }

  for (const run of await rows(
    `SELECT r.business_id,r.scenario_json,r.quote_json FROM practice_runs r JOIN businesses b ON b.id=r.business_id
     WHERE ${OTHERS} AND r.outcome='quote'`,
    params,
  )) {
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const quote = json<Quote | null>(run.quote_json, null);
    if (scenario.serviceName?.trim().toLowerCase() !== service || !quote?.lines[0]) continue;
    const spec = specFromScenario(scenario);
    add(
      run.business_id,
      spec.quantity ? { quantity: spec.quantity, unit: spec.unit } : null,
      quote.lines[0].amountCents,
    );
  }

  for (const sent of await rows(
    `SELECT q.business_id,q.quote_json,c.spec_json FROM live_quotes q
     JOIN lead_chats c ON c.id=q.chat_id JOIN businesses b ON b.id=q.business_id
     WHERE ${OTHERS} AND ${pooledChat('c')} AND q.sent_by='owner' AND LOWER(c.service_name)=?`,
    [...params, service],
  )) {
    const quote = json<Quote | null>(sent.quote_json, null);
    const spec = json<JobSpec | null>(sent.spec_json, null);
    add(
      sent.business_id,
      spec?.quantity && spec.unit ? { quantity: spec.quantity, unit: spec.unit } : null,
      quote?.lines[0]?.amountCents ?? 0,
    );
  }

  return combineRates(rates, input.unit || undefined);
}
