import { Router } from 'express';
import { z } from 'zod';
import { mutate, rows } from './db.js';
import { ok } from './http.js';
import type { Row } from './models.js';
import { AGREE_PERCENT } from './pricing/accuracy.js';
import { agentReadiness, businessReadiness, serviceWorkload } from './pricing/readiness.js';
import { LEARNING_STYLES, TRAINED_PERCENT, type LearningStyle } from './pricing/style.js';
import { requireWorkspace, workspace } from './workspace.js';
import { recordRequestEvent } from './metrics.js';

/**
 * How the owner's Charm quotes: whether quotes go out on their own, a price over which they always
 * wait, how trained a service has to be for firm prices, and what goes out before then.
 */
export type CharmSettings = {
  autoSend: boolean;
  /** Null for no limit. */
  limitCents: number | null;
  trainedPercent: number;
  learningStyle: LearningStyle;
  /** A draft this close to the owner's price, in percent, counts as a match while it learns. */
  closePercent: number;
};

const SETTINGS_COLUMNS =
  'auto_send,auto_send_limit_cents,trained_percent,learning_style,close_percent';

/** The settings on a businesses row. Rows from before they existed get the defaults. */
export function settingsFromRow(row: Row): CharmSettings {
  const limit = row.auto_send_limit_cents;
  const style = String(row.learning_style ?? '');
  return {
    autoSend: Boolean(row.auto_send),
    limitCents: limit === null || limit === undefined ? null : Number(limit),
    trainedPercent:
      row.trained_percent === undefined || row.trained_percent === null
        ? TRAINED_PERCENT
        : Number(row.trained_percent),
    learningStyle: (LEARNING_STYLES as readonly string[]).includes(style)
      ? (style as LearningStyle)
      : 'range',
    closePercent:
      row.close_percent === undefined || row.close_percent === null
        ? AGREE_PERCENT
        : Number(row.close_percent),
  };
}

export async function charmSettings(businessId: string): Promise<CharmSettings> {
  const [business] = await rows(`SELECT ${SETTINGS_COLUMNS} FROM businesses WHERE id=?`, [
    businessId,
  ]);
  return settingsFromRow(business ?? ({} as Row));
}

export const charmSettingsInput = z
  .object({
    autoSend: z.boolean(),
    limitCents: z.number().int().min(5000).max(10_000_000).nullable(),
    /** Older pages send the limit under this name. */
    autoSendLimitCents: z.number().int().min(5000).max(10_000_000).nullable(),
    trainedPercent: z.number().int().min(10).max(100),
    learningStyle: z.enum(LEARNING_STYLES),
    closePercent: z.number().int().min(5).max(30),
  })
  .partial()
  .strict();

export async function saveCharmSettings(
  businessId: string,
  input: z.infer<typeof charmSettingsInput>,
): Promise<CharmSettings> {
  const limit = input.limitCents !== undefined ? input.limitCents : input.autoSendLimitCents;
  const changes: [string, string | number | boolean | null][] = [];
  if (input.autoSend !== undefined) changes.push(['auto_send', input.autoSend]);
  if (limit !== undefined) changes.push(['auto_send_limit_cents', limit]);
  if (input.trainedPercent !== undefined) changes.push(['trained_percent', input.trainedPercent]);
  if (input.learningStyle !== undefined) changes.push(['learning_style', input.learningStyle]);
  if (input.closePercent !== undefined) changes.push(['close_percent', input.closePercent]);
  if (changes.length)
    await mutate(
      `UPDATE businesses SET ${changes.map(([column]) => `${column}=?`).join(',')} WHERE id=?`,
      [...changes.map(([, value]) => value), businessId],
    );
  return charmSettings(businessId);
}

/** The score, each service, and the settings: everything the Charm card shows. */
export async function charmView(businessId: string) {
  const services = await businessReadiness(businessId);
  return {
    businessId,
    readiness: agentReadiness(services, await serviceWorkload(businessId)),
    services,
    settings: await charmSettings(businessId),
  };
}

/** The same during setup and after it, so the switch works before there's an account. */
export const charmRouter = Router();

charmRouter.get('/onboarding/charm', requireWorkspace, async (req, res) => {
  res.json(ok(await charmView(workspace(req).businessId)));
});

charmRouter.patch('/onboarding/charm', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const input = charmSettingsInput.parse(req.body);
  await saveCharmSettings(businessId, input);
  const limit = input.limitCents !== undefined ? input.limitCents : input.autoSendLimitCents;
  await recordRequestEvent(req, businessId, 'charm_settings_changed', {
    fields: Object.keys(input).join(','),
    auto_send: input.autoSend,
    limit_cents: limit,
    trained_percent: input.trainedPercent,
    learning_style: input.learningStyle,
    close_percent: input.closePercent,
  });
  res.json(ok(await charmView(businessId)));
});
