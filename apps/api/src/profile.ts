import { Router } from 'express';
import { rows } from './db.js';
import { ok } from './http.js';
import { json } from './models.js';
import { listPastJobs } from './past-jobs.js';
import { practiceState } from './practice/engine.js';
import type { Insight, PracticeScenario, Quote } from './practice/types.js';
import { requireWorkspace, workspace } from './workspace.js';

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

/**
 * What the AI knows, in the owner's words: the questions it asks, how it prices and when it hands
 * a job back. It's built from the owner's practice, including any line they corrected.
 */
export async function pricingProfile(businessId: string) {
  const [business] = await rows(
    'SELECT service_area,travel_radius_miles,auto_send,auto_send_limit_cents FROM businesses WHERE id=?',
    [businessId],
  );
  const runs = await rows(
    "SELECT scenario_json,asked_json,insights_json FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  const asks = ['Can you send a few photos?'];
  const prices: string[] = [];
  const handoffs: string[] = [];
  for (const run of runs) {
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    for (const key of json<string[]>(run.asked_json, [])) {
      const question = scenario.facts?.find((fact) => fact.key === key)?.question;
      if (question && !asks.includes(question)) asks.push(question);
    }
    for (const { text } of json<Insight[]>(run.insights_json, [])) {
      if (/^(Charges|Prices|Adds|Gives|Takes)\b/.test(text) && !prices.includes(text))
        prices.push(text);
      if (/^(Won’t send|Won't send|Asks to see)/.test(text) && !handoffs.includes(text))
        handoffs.push(text);
    }
  }
  const area = String(business?.service_area ?? '').trim();
  const radius = business?.travel_radius_miles ? Number(business.travel_radius_miles) : null;
  handoffs.push(
    `Anything over ${money(Number(business?.auto_send_limit_cents ?? 150000))}`,
    area && radius
      ? `Jobs more than ${radius} miles from ${area}`
      : 'Jobs outside your service area',
    'Services you don’t offer, or anything it hasn’t seen before',
  );
  const practice = await practiceState(businessId);
  return {
    asks: asks.slice(0, 6),
    prices: prices.slice(0, 6),
    handoffs,
    results: practice.results,
    autoSendReady: practice.autoSendReady,
    autoSend: Boolean(business?.auto_send),
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
