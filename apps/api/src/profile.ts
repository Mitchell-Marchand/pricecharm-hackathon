import { Router } from 'express';
import { rows } from './db.js';
import { ok } from './http.js';
import { json, type Row } from './models.js';
import { settingsFromRow } from './charm.js';
import { listPastJobs } from './past-jobs.js';
import { practiceState } from './practice/engine.js';
import { liveRecord, LIVE_WINDOW } from './pricing/accuracy.js';
import { loadPricingData } from './pricing/history.js';
import { fitRates } from './pricing/rates.js';
import { agentReadiness, businessReadiness, serviceWorkload } from './pricing/readiness.js';
import type { Insight, PracticeScenario, Quote } from './practice/types.js';
import { requireWorkspace, workspace } from './workspace.js';

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** The questions the customer chat asks, from what the owner asked their practice customers. */
export async function questionChecklist(businessId: string): Promise<string[]> {
  const runs = await rows(
    "SELECT scenario_json,asked_json FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  const asks = ['Can you send a few photos?'];
  for (const run of runs) {
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    for (const key of json<string[]>(run.asked_json, [])) {
      const question = scenario.facts?.find((fact) => fact.key === key)?.question;
      if (question && !asks.includes(question)) asks.push(question);
    }
  }
  return asks.slice(0, 6);
}

/**
 * What the AI knows, in the owner's words: the questions it asks, how it prices and when it hands
 * a job back. It's built from the owner's practice, including any line they corrected, and from
 * their real quotes.
 */
export async function pricingProfile(businessId: string) {
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const settings = settingsFromRow(business ?? ({} as Row));
  const runs = await rows(
    "SELECT insights_json FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  const prices: string[] = [];
  const handoffs: string[] = [];
  for (const run of runs) {
    for (const { text } of json<Insight[]>(run.insights_json, [])) {
      if (/^(Charges|Prices|Adds|Gives|Takes)\b/.test(text) && !prices.includes(text))
        prices.push(text);
      if (/^(Won’t send|Won't send|Asks to see)/.test(text) && !handoffs.includes(text))
        handoffs.push(text);
    }
  }
  const area = String(business?.service_area ?? '').trim();
  const radius = business?.travel_radius_miles ? Number(business.travel_radius_miles) : null;
  if (settings.limitCents !== null) handoffs.push(`Anything over ${money(settings.limitCents)}`);
  handoffs.push(
    area && radius
      ? `Jobs more than ${radius} miles from ${area}`
      : 'Jobs outside your service area',
    'Services you don’t offer',
    'Jobs much bigger or smaller than ones you’ve priced',
    'Anyone who asks to talk to you',
  );
  const practice = await practiceState(businessId);
  const record = await liveRecord(businessId);
  const recent = record.slice(0, LIVE_WINDOW);
  const data = await loadPricingData(businessId);
  const services = await businessReadiness(businessId, fitRates(data.points));
  return {
    asks: await questionChecklist(businessId),
    prices: prices.slice(0, 6),
    /** Rates worked out from every job and quote with a size. */
    rates: data.history.rates.slice(0, 8),
    handoffs,
    results: practice.results,
    /** How well it knows each service. One it's still learning goes out as the owner chose. */
    services,
    autoSendReady: services.some((item) => item.ready),
    settings,
    readiness: agentReadiness(services, await serviceWorkload(businessId)),
    live: {
      reviewed: record.length,
      considered: recent.length,
      agreed: recent.filter((item) => item.agree).length,
      recent: recent.slice(0, 5),
    },
    liveQuotesLearned: data.history.liveQuotes.length,
    autoSend: settings.autoSend,
    jobsCount: (await listPastJobs(businessId)).length,
    practiceCount: practice.finished,
    practiceQuotes: practice.runs
      .flatMap((run) => (run.quote ? [run.quote as Quote] : []))
      .slice(-3),
  };
}

export const profileRouter = Router();

profileRouter.get('/onboarding/profile', requireWorkspace, async (req, res) => {
  res.json(ok(await pricingProfile(workspace(req).businessId)));
});
