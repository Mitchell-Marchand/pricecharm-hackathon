import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { TRADES_BY_ID, tradeName } from '@pricecharm/trades';
import { hashToken, newToken } from './auth.js';
import { devTokensAllowed, isDeployed } from './config.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { isDisposableEmail } from './email-domains.js';
import { changeCurrency } from './billing.js';
import { ApiError, ok, rateLimit } from './http.js';
import { CURRENCIES, currencyOf } from './money.js';
import { businessLocations, MAX_LOCATIONS } from './locations.js';
import { verifyHuman } from './human-check.js';
import { mailProvider, queueEmail } from './integrations/email.js';
import { draftIpBudgetKey } from './usage.js';
import {
  recordEvent,
  recordMilestone,
  recordRequestEvent,
  requestSession,
  setupFacts,
} from './metrics.js';
import { consumeAuthRateLimit } from './verification.js';
import {
  DRAFT_DAYS,
  createDraft,
  draftFromRequest,
  requireWorkspace,
  rotateDraftCookie,
  workspace,
  workspaceFromRequest,
} from './workspace.js';

/**
 * Where setup can be picked up again. Practice comes straight after the business, past jobs are an
 * extra on the try page, and the account is made on the ready page.
 */
export const ONBOARDING_STEPS = [
  'trade',
  'services',
  'about',
  'practice',
  'ready',
  'try',
  'live',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Steps saved before setup changed order, and where each picks up now. */
const OLD_STEPS: Record<string, OnboardingStep> = {
  business: 'trade',
  jobs: 'practice',
  account: 'ready',
};
const stepOf = (value: unknown): OnboardingStep => {
  const step = String(value ?? '');
  return (ONBOARDING_STEPS as readonly string[]).includes(step)
    ? (step as OnboardingStep)
    : (OLD_STEPS[step] ?? 'trade');
};
const RADII = ['10', '15', '25', '50'] as const;
const DRAFTS_PER_ADDRESS_PER_DAY = 10;

/**
 * Setups one address may start in a day. The browser tests start many from one address, so a
 * local run can raise it with LOCAL_SETUPS_PER_ADDRESS. Deployed servers ignore that.
 */
function draftsPerAddress(): number {
  const local = Number(process.env.LOCAL_SETUPS_PER_ADDRESS);
  return local > 0 && process.env.NODE_ENV !== 'production' && !isDeployed()
    ? local
    : DRAFTS_PER_ADDRESS_PER_DAY;
}

export const onboardingRouter = Router();

/** Setup's own write of where it works, inside its save. Settings uses saveLocations. */
async function writeLocations(businessId: string, areas: string[], connection: Sql) {
  await mutate('DELETE FROM business_locations WHERE business_id=?', [businessId], connection);
  for (const [position, area] of areas.entries())
    await mutate(
      'INSERT INTO business_locations (id,business_id,position,area) VALUES (?,?,?,?)',
      [randomUUID(), businessId, position, area],
      connection,
    );
  await mutate(
    'UPDATE businesses SET service_area=? WHERE id=?',
    [areas[0] ?? '', businessId],
    connection,
  );
}

function appOrigin() {
  return (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
}

export async function onboardingState(businessId: string, draft: boolean, connection?: Sql) {
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId], connection);
  if (!business) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This business is unavailable.');
  const offerings = await rows(
    'SELECT name,custom FROM offerings WHERE business_id=? ORDER BY position,name',
    [businessId],
    connection,
  );
  const locations = await businessLocations(businessId, connection);
  return {
    draft,
    step: stepOf(business.onboarding_step),
    business: {
      tradeId: business.trade_id ?? null,
      customTrade: business.custom_trade ?? '',
      services: offerings.map((item) => String(item.name)),
      customServices: offerings.filter((item) => item.custom).map((item) => String(item.name)),
      name: business.name ?? '',
      area: business.service_area ?? '',
      locations: locations.length
        ? locations
        : business.service_area
          ? [business.service_area]
          : [],
      currency: currencyOf(business.currency),
      radius: business.travel_radius_miles ? String(business.travel_radius_miles) : '25',
    },
    slug: draft ? null : String(business.slug),
  };
}

/** A new setup for this browser, out of the day's allowance for its address. */
async function startDraft(req: Request, res: Response) {
  const day = new Date().toISOString().slice(0, 10);
  return transaction(async (connection) => {
    try {
      await consumeAuthRateLimit(
        draftIpBudgetKey(req.ip || req.socket.remoteAddress || 'unknown', day),
        draftsPerAddress(),
        24 * 60 * 60_000,
        connection,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'IDENTITY_RATE_LIMIT')
        throw new ApiError(
          429,
          'SETUP_LIMIT',
          'Too many setups were started from this connection today. Please try again tomorrow.',
        );
      throw error;
    }
    // The browser's guess at the owner's currency, from their time zone. They can change it.
    return createDraft(
      res,
      connection,
      requestSession(req),
      currencyOf(String(req.body?.currency ?? '')),
    );
  });
}

/** Starts setup for a new visitor, or returns the setup this browser already has. */
onboardingRouter.post(
  '/onboarding/start',
  rateLimit(Math.max(10, draftsPerAddress()), 15 * 60_000),
  async (req, res) => {
    const existing = await workspaceFromRequest(req);
    if (existing) {
      res.json(ok(await onboardingState(existing.businessId, existing.draft)));
      return;
    }
    await verifyHuman(req, 'onboarding');
    const businessId = await startDraft(req, res);
    res.status(201).json(ok(await onboardingState(businessId, true)));
  },
);

/**
 * Starts over: a new setup takes this browser's cookie. The old one isn't touched. It goes when it
 * expires, and a resume link it already emailed still opens it. Only unfinished setups can do this,
 * and each new one counts against the same daily allowance as any other.
 */
onboardingRouter.post(
  '/onboarding/restart',
  rateLimit(Math.max(10, draftsPerAddress()), 15 * 60_000),
  requireWorkspace,
  async (req, res) => {
    if (!workspace(req).draft)
      throw new ApiError(409, 'SETUP_FINISHED', 'This account already has a business.');
    await verifyHuman(req, 'onboarding');
    const businessId = await startDraft(req, res);
    res.status(201).json(ok(await onboardingState(businessId, true)));
  },
);

onboardingRouter.get('/onboarding', requireWorkspace, async (req, res) => {
  const current = workspace(req);
  res.json(ok(await onboardingState(current.businessId, current.draft)));
});

const serviceName = z.string().trim().min(1).max(60);
const businessPatch = z
  .object({
    tradeId: z
      .string()
      .max(60)
      .nullable()
      .refine((value) => value === null || Boolean(TRADES_BY_ID[value]), 'Choose a listed trade.'),
    customTrade: z.string().trim().max(80),
    services: z
      .array(serviceName)
      .max(30)
      .refine(
        (names) => new Set(names.map((name) => name.toLowerCase())).size === names.length,
        'Each service can only be listed once.',
      ),
    name: z.string().trim().max(120),
    area: z.string().trim().max(120),
    locations: z
      .array(z.string().trim().min(1).max(120))
      .max(MAX_LOCATIONS)
      .refine(
        (areas) => new Set(areas.map((area) => area.toLowerCase())).size === areas.length,
        'Each location can only be listed once.',
      ),
    currency: z.enum(CURRENCIES),
    radius: z.enum(RADII),
  })
  .partial()
  .strict();

onboardingRouter.patch('/onboarding/business', requireWorkspace, async (req, res) => {
  const input = businessPatch.parse(req.body);
  const current = workspace(req);
  await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT trade_id,custom_trade FROM businesses WHERE id=? FOR UPDATE',
      [current.businessId],
      connection,
    );
    const tradeId = input.tradeId !== undefined ? input.tradeId : business.trade_id;
    const customTrade = input.customTrade ?? business.custom_trade ?? '';
    const fields: string[] = [],
      values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column}=?`);
      values.push(value);
    };
    if (input.tradeId !== undefined) set('trade_id', input.tradeId);
    if (input.customTrade !== undefined) set('custom_trade', input.customTrade);
    if (input.tradeId !== undefined || input.customTrade !== undefined)
      set('industry', tradeName(tradeId, customTrade).slice(0, 160));
    if (input.name !== undefined) set('name', input.name);
    // An older page sends one area: it becomes their only location.
    const areas =
      input.locations ?? (input.area !== undefined ? [input.area].filter(Boolean) : null);
    if (areas) await writeLocations(current.businessId, areas, connection);
    if (input.radius !== undefined) set('travel_radius_miles', Number(input.radius));
    if (input.currency) await changeCurrency(current.businessId, input.currency, connection);
    if (fields.length)
      await mutate(
        `UPDATE businesses SET ${fields.join(',')} WHERE id=?`,
        [...values, current.businessId],
        connection,
      );
    if (input.services) {
      const template = new Set(
        (tradeId ? TRADES_BY_ID[tradeId]?.services : [])?.map((name) => name.toLowerCase()),
      );
      await mutate(
        `DELETE FROM offerings WHERE business_id=?${input.services.length ? ` AND name NOT IN (${input.services.map(() => '?').join(',')})` : ''}`,
        [current.businessId, ...input.services],
        connection,
      );
      for (const [position, name] of input.services.entries())
        await mutate(
          'INSERT INTO offerings (id,business_id,name,custom,position) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE custom=VALUES(custom),position=VALUES(position)',
          [randomUUID(), current.businessId, name, !template.has(name.toLowerCase()), position],
          connection,
        );
    }
  });
  await recordRequestEvent(req, current.businessId, 'business_updated', {
    fields: Object.keys(input).join(','),
    ...(await setupFacts(current.businessId)),
  });
  res.json(ok(await onboardingState(current.businessId, current.draft)));
});

onboardingRouter.patch('/onboarding/step', requireWorkspace, async (req, res) => {
  const { step } = z
    .object({ step: z.enum(ONBOARDING_STEPS) })
    .strict()
    .parse(req.body);
  const current = workspace(req);
  await mutate('UPDATE businesses SET onboarding_step=? WHERE id=?', [step, current.businessId]);
  const facts = await setupFacts(current.businessId);
  await recordMilestone(undefined, current.businessId, 'setup_step', step, {
    props: facts,
    session: requestSession(req),
  });
  await recordRequestEvent(req, current.businessId, 'step_changed', { to: step, ...facts });
  res.json(ok(await onboardingState(current.businessId, current.draft)));
});

/** "Email me a link to finish later." The link moves this setup to whichever browser opens it. */
onboardingRouter.post(
  '/onboarding/resume-link',
  rateLimit(10, 15 * 60_000),
  requireWorkspace,
  async (req, res) => {
    const { email } = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((value) => value.trim().toLowerCase()),
      })
      .strict()
      .parse(req.body);
    const current = workspace(req);
    if (!current.draft)
      throw new ApiError(409, 'ALREADY_SAVED', 'Your setup is already saved to your account.');
    if (isDisposableEmail(email))
      throw new ApiError(422, 'DISPOSABLE_EMAIL', 'Please use an email address you’ll keep.');
    await consumeAuthRateLimit(`resume-link:${current.businessId}`, 5, 60 * 60_000);
    const token = newToken();
    await transaction(async (connection) => {
      const [business] = await rows(
        'SELECT name FROM businesses WHERE id=? FOR UPDATE',
        [current.businessId],
        connection,
      );
      await mutate(
        'UPDATE businesses SET draft_resume_hash=?,draft_email=? WHERE id=?',
        [hashToken(token), email, current.businessId],
        connection,
      );
      const link = `${appOrigin()}/start/resume#token=${encodeURIComponent(token)}`;
      const name = String(business?.name || '').trim();
      await queueEmail(
        {
          businessId: current.businessId,
          dedupeKey: `resume-link:${current.businessId}:${randomUUID()}`,
          to: email,
          subject: 'Pick up where you left off',
          text: `Here’s the link to finish setting up ${name || 'your business'} on PriceCharm:\n${link}\n\nIt works for ${DRAFT_DAYS} days from when you started. If you didn’t ask for this, you can ignore this email.`,
        },
        connection,
      );
    });
    await recordRequestEvent(req, current.businessId, 'resume_link_sent');
    res.json(
      ok({
        ok: true,
        ...(mailProvider() === 'local' && devTokensAllowed(req) ? { devToken: token } : {}),
      }),
    );
  },
);

onboardingRouter.post('/onboarding/resume', rateLimit(20, 15 * 60_000), async (req, res) => {
  const { token } = z
    .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .strict()
    .parse(req.body);
  const businessId = await transaction(async (connection) => {
    const [draft] = await rows(
      "SELECT id FROM businesses WHERE draft_resume_hash=? AND status='draft' AND draft_expires_at>UTC_TIMESTAMP(3) AND deletion_requested_at IS NULL FOR UPDATE",
      [hashToken(token)],
      connection,
    );
    if (!draft)
      throw new ApiError(
        410,
        'RESUME_LINK_EXPIRED',
        'This link has expired or was already used. Start again, or ask for a new link.',
      );
    await mutate('UPDATE businesses SET draft_resume_hash=NULL WHERE id=?', [draft.id], connection);
    await rotateDraftCookie(res, String(draft.id), connection);
    await recordEvent(
      connection,
      String(draft.id),
      'resume_link_used',
      {},
      {
        session: requestSession(req),
      },
    );
    return String(draft.id);
  });
  res.json(ok(await onboardingState(businessId, true)));
});

/** The draft this browser set up, for signup to claim. */
export async function claimableDraft(req: Request, connection: Sql) {
  return draftFromRequest(req, connection, true);
}
