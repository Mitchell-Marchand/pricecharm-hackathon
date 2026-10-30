import { Router } from 'express';
import { rows } from './db.js';
import { ok } from './http.js';
import type { Row } from './models.js';
import { settingsFromRow } from './charm.js';
import { listPastJobs } from './past-jobs.js';
import { practiceState } from './practice/engine.js';
import { liveRecord, LIVE_WINDOW } from './pricing/accuracy.js';
import { loadPricingData } from './pricing/history.js';
import { fitRates } from './pricing/rates.js';
import { agentReadiness, businessReadiness, serviceWorkload } from './pricing/readiness.js';
import type { Quote } from './practice/types.js';
import { requireWorkspace, workspace } from './workspace.js';

/**
 * How the Charm is doing: how well it knows each service, its guesses next to the owner's, its
 * record on real quotes, and what it learned from. What it asks and how it prices are in
 * charm-notes.ts, where the owner can change them.
 */
export async function pricingProfile(businessId: string) {
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
  const settings = settingsFromRow(business ?? ({} as Row));
  const practice = await practiceState(businessId);
  const record = await liveRecord(businessId, settings.closePercent);
  const recent = record.slice(0, LIVE_WINDOW);
  const data = await loadPricingData(businessId);
  const services = await businessReadiness(businessId, fitRates(data.points));
  return {
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
