import { Router } from 'express';
import { z } from 'zod';
import { ApiError, ok, rateLimit } from '../http.js';
import { mutate } from '../db.js';
import { businessContext } from '../pricing/history.js';
import { requireWorkspace, workspace } from '../workspace.js';
import {
  addPracticeRun,
  computeShadow,
  declinePracticeRun,
  declinePrefill,
  editInsight,
  explainPracticeQuote,
  ensurePracticeRuns,
  fixPhotoReading,
  kickPreparation,
  PRACTICE_COUNT,
  practiceState,
  retryPracticeRun,
  sendOwnerMessage,
  sendPracticeQuote,
} from './engine.js';
import { recordRequestEvent, setupFacts } from '../metrics.js';
import { gapPercent, quoteTotal } from './types.js';

/**
 * Practice customers, the owner's quotes and what the AI picked up: six during setup, and as
 * many more as the owner likes from the Train page.
 */
export const practiceRouter = Router();
const runId = z.uuid();

/** Creates the practice customers and starts writing them. Safe to call more than once. */
practiceRouter.post('/onboarding/practice/prepare', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  await ensurePracticeRuns(businessId);
  await kickPreparation(businessId);
  await recordRequestEvent(req, businessId, 'practice_prepared', await setupFacts(businessId));
  res.json(ok(await practiceState(businessId)));
});

/**
 * Another practice customer once setup's are done: from the Train page, or from the Ready
 * screen for a service that isn't sending on its own yet.
 */
practiceRouter.post(
  '/onboarding/practice/more',
  rateLimit(10, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { service } = z
      .object({ service: z.string().trim().min(1).max(80).optional() })
      .strict()
      .parse(req.body ?? {});
    const { businessId, draft } = workspace(req);
    if (draft && (await practiceState(businessId)).finished < PRACTICE_COUNT)
      throw new ApiError(409, 'PRACTICE_SETUP', 'Finish setup’s practice customers first.');
    const focus = service
      ? (await businessContext(businessId)).services.find(
          (name) => name.toLowerCase() === service.toLowerCase(),
        )
      : null;
    if (service && !focus)
      throw new ApiError(422, 'PRACTICE_SERVICE', 'That isn’t one of your services.');
    const id = await addPracticeRun(businessId, { focus, draft });
    await kickPreparation(businessId);
    await recordRequestEvent(
      req,
      businessId,
      'practice_more',
      { service: focus ?? '', during_setup: draft },
      { ref: id },
    );
    res.status(201).json(ok({ runId: id, state: await practiceState(businessId) }));
  },
);

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
    const { businessId } = workspace(req);
    const sent = await sendOwnerMessage(businessId, runId.parse(req.params.id), text);
    await recordRequestEvent(
      req,
      businessId,
      'practice_answer',
      {
        position: sent.run.position,
        service: sent.run.serviceName ?? '',
        turn: sent.run.messages.filter((message) => message.from === 'owner').length,
        chars: text.length,
        asked_price: Boolean(sent.nudge),
        asked_visit: sent.visitAsk,
      },
      { ref: sent.run.id },
    );
    // Asked a second time, the visit is the owner's answer for this customer.
    if (sent.run.outcome === 'site-visit')
      await recordRequestEvent(
        req,
        businessId,
        'practice_site_visit',
        {
          position: sent.run.position,
          service: sent.run.serviceName ?? '',
          ai_wanted_visit: Boolean(sent.run.shadow?.siteVisit),
          guess_cents: sent.run.shadow?.siteVisit ? null : (sent.run.shadow?.cents ?? null),
        },
        { ref: sent.run.id },
      );
    res.json(ok(sent));
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
    const ownerCents = run.quote ? quoteTotal(run.quote) : 0;
    const guess = run.shadow && !run.shadow.siteVisit ? run.shadow.cents : null;
    // How close the Charm's own guess came to the owner's price: the moment it clicks, or doesn't.
    await recordRequestEvent(
      req,
      businessId,
      'practice_quoted',
      {
        position: run.position,
        service: run.serviceName ?? '',
        owner_cents: ownerCents,
        guess_cents: guess,
        gap_pct: guess === null ? null : gapPercent(guess, ownerCents),
        ai_wanted_visit: Boolean(run.shadow?.siteVisit),
        confidence: run.shadow?.confidence ?? null,
        lines: run.quote?.lines?.length ?? 0,
        turns: run.messages.filter((message) => message.from === 'owner').length,
      },
      { ref: run.id, value: ownerCents },
    );
    res.json(ok(run));
  },
);

/** What the "Why not?" sheet fills in from this customer, once the owner opens it. */
practiceRouter.get('/onboarding/practice/:id/decline', requireWorkspace, async (req, res) => {
  res.json(ok(await declinePrefill(workspace(req).businessId, runId.parse(req.params.id))));
});

/** The owner turns this customer down, and saves the rule it follows from now on. */
practiceRouter.post(
  '/onboarding/practice/:id/decline',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { businessId } = workspace(req);
    const run = await declinePracticeRun(businessId, runId.parse(req.params.id), req.body);
    await recordRequestEvent(
      req,
      businessId,
      'practice_declined',
      {
        position: run.position,
        service: run.serviceName ?? '',
        reason: run.turnDown?.reason ?? '',
        minimum: Boolean(run.turnDown?.minimumCents),
        turns: run.messages.filter((message) => message.from === 'owner').length,
      },
      { ref: run.id },
    );
    res.json(ok(run));
  },
);

practiceRouter.patch(
  '/onboarding/practice/:id/explanation',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { text } = z
      .object({ text: z.string().trim().min(3).max(600) })
      .strict()
      .parse(req.body);
    await recordRequestEvent(req, workspace(req).businessId, 'practice_quote_explained', {
      chars: text.length,
    });
    res.json(
      ok(await explainPracticeQuote(workspace(req).businessId, runId.parse(req.params.id), text)),
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
    await recordRequestEvent(req, workspace(req).businessId, 'practice_insight_edited', {
      chars: text.length,
    });
    res.json(
      ok(await editInsight(workspace(req).businessId, runId.parse(req.params.id), insightId, text)),
    );
  },
);

/** The owner's fix to what their Charm saw in the customer's photos: a count, the size or a note. */
practiceRouter.patch(
  '/onboarding/practice/:id/photo-reading',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const size = z.number().finite().min(0).max(1_000_000);
    const fixes = z
      .object({
        counts: z.record(z.string().trim().min(1).max(80), size.int()).optional(),
        area: size.positive().nullable().optional(),
        note: z.string().trim().max(300).optional(),
      })
      .strict()
      .refine((body) => Object.keys(body.counts ?? {}).length <= 6, {
        message: 'That’s more counts than it saw.',
      })
      .parse(req.body);
    const { businessId } = workspace(req);
    const run = await fixPhotoReading(businessId, runId.parse(req.params.id), fixes);
    await recordRequestEvent(
      req,
      businessId,
      'practice_photo_fixed',
      {
        position: run.position,
        counts: Object.keys(fixes.counts ?? {}).length,
        area: fixes.area !== undefined,
        note: Boolean(fixes.note),
      },
      { ref: run.id },
    );
    res.json(ok(run));
  },
);

practiceRouter.post('/onboarding/practice/:id/retry', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  await retryPracticeRun(businessId, runId.parse(req.params.id));
  await recordRequestEvent(req, businessId, 'practice_retry', {}, { ref: String(req.params.id) });
  res.json(ok(await practiceState(businessId)));
});

/** Moves setup on to the ready screen once every practice quote is done. */
practiceRouter.post('/onboarding/practice/done', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const state = await practiceState(businessId);
  await recordRequestEvent(req, businessId, 'practice_done', {
    finished: state.finished,
    count: state.count,
  });
  if (state.finished >= state.count)
    await mutate(
      "UPDATE businesses SET onboarding_step='ready' WHERE id=? AND onboarding_step IN ('trade','services','about','practice','business','jobs')",
      [businessId],
    );
  res.json(ok(state));
});
