import { Router } from 'express';
import { z } from 'zod';
import { ok, rateLimit } from '../http.js';
import { mutate } from '../db.js';
import { requireWorkspace, workspace } from '../workspace.js';
import {
  askForSiteVisit,
  computeShadow,
  editInsight,
  ensurePracticeRuns,
  kickPreparation,
  practiceState,
  retryPracticeRun,
  sendOwnerMessage,
  sendPracticeQuote,
} from './engine.js';

/** Step 3 of setup: practice customers, the owner's quotes, and what the AI picked up. */
export const practiceRouter = Router();
const runId = z.uuid();

/** Creates the practice customers and starts writing them. Safe to call more than once. */
practiceRouter.post('/onboarding/practice/prepare', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  await ensurePracticeRuns(businessId);
  await kickPreparation(businessId);
  res.json(ok(await practiceState(businessId)));
});

practiceRouter.get('/onboarding/practice', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  // Picks up any customer whose preparation stalled, for example after a restart.
  await kickPreparation(businessId);
  res.json(ok(await practiceState(businessId)));
});

practiceRouter.post(
  '/onboarding/practice/:id/messages',
  rateLimit(30, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(req.body);
    res.json(
      ok(await sendOwnerMessage(workspace(req).businessId, runId.parse(req.params.id), text)),
    );
  },
);

/** The client asks for the AI's guess as the owner opens the quote builder, so it's ready sooner. */
practiceRouter.post(
  '/onboarding/practice/:id/guess',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    await computeShadow(workspace(req).businessId, runId.parse(req.params.id));
    res.json(ok({ ok: true }));
  },
);

practiceRouter.post(
  '/onboarding/practice/:id/quote',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { businessId } = workspace(req);
    const run = await sendPracticeQuote(businessId, runId.parse(req.params.id), req.body);
    res.json(ok(run));
  },
);

practiceRouter.post(
  '/onboarding/practice/:id/site-visit',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { reason } = z
      .object({ reason: z.string().trim().min(4, 'Say what you need to check.').max(600) })
      .strict()
      .parse(req.body);
    res.json(
      ok(await askForSiteVisit(workspace(req).businessId, runId.parse(req.params.id), reason)),
    );
  },
);

practiceRouter.patch(
  '/onboarding/practice/:id/insights/:insightId',
  requireWorkspace,
  async (req, res) => {
    const { text } = z
      .object({ text: z.string().trim().min(2).max(200) })
      .strict()
      .parse(req.body);
    const insightId = z.string().max(40).parse(req.params.insightId);
    res.json(
      ok(await editInsight(workspace(req).businessId, runId.parse(req.params.id), insightId, text)),
    );
  },
);

practiceRouter.post('/onboarding/practice/:id/retry', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  await retryPracticeRun(businessId, runId.parse(req.params.id));
  res.json(ok(await practiceState(businessId)));
});

/** Moves setup on to the ready screen once every practice quote is done. */
practiceRouter.post('/onboarding/practice/done', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const state = await practiceState(businessId);
  if (state.finished >= state.count)
    await mutate(
      "UPDATE businesses SET onboarding_step='ready' WHERE id=? AND onboarding_step IN ('business','jobs','practice')",
      [businessId],
    );
  res.json(ok(state));
});
