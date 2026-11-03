import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok, rateLimit } from './http.js';
import { businessLocations } from './locations.js';
import { recordRequestEvent } from './metrics.js';
import { currencyOf, money, type Currency } from './money.js';
import type { Row } from './models.js';
import type { JobSpec } from './pricing/spec.js';
import { canonicalUnit, formatNumber, formatQuantity } from './pricing/units.js';
import { requireWorkspace, workspace } from './workspace.js';

/**
 * Jobs the owner turns down, and the least they charge. A practice customer saves one ("We don't
 * do this job"), and What it knows and Settings change them. The live chat reads every rule: the
 * intake turns down what matches (src/ai/intake.ts), the server holds sizes and prices to them
 * (src/live/chat.ts), and a turned-down request shows no quote, so it's never billed. The minimum
 * raises every draft, live and practice (draftForBusiness in src/pricing/draft.ts).
 */

export const TURN_DOWN_KINDS = [
  'too_small',
  'too_big',
  'not_offered',
  'too_far',
  'lead_time',
  'other',
] as const;
export type TurnDownKind = (typeof TURN_DOWN_KINDS)[number];

export type TurnDownRule = {
  id: string;
  kind: TurnDownKind;
  /** too_small and too_big: a size and its unit, like 200 and "sq ft". */
  size: number | null;
  sizeUnit: string;
  /** too_small: a total the job comes to or under. */
  priceCents: number | null;
  /** too_far: how far from the nearest of the owner's locations. */
  distance: number | null;
  distanceUnit: 'mi' | 'km' | null;
  /** lead_time: the fewest days out they book. */
  days: number | null;
  /** not_offered: the work they don't do. other: the owner's own sentence. */
  text: string;
  /** The practice customer it came from, if one did. */
  fromRunId: string | null;
};

/** Rules one business can have. More than this is a list nobody reads. */
const MAX_RULES = 30;

/** Why the owner turned a job down, as they'd say it. */
export const REASONS: Record<TurnDownKind, string> = {
  too_small: 'Too small',
  too_big: 'Too big',
  not_offered: 'Not something you do',
  too_far: 'Too far away',
  lead_time: 'Can’t fit it in',
  other: 'Something else',
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const days = (count: number) => (count === 1 ? '1 day' : `${count} days`);

function ruleFrom(row: Row): TurnDownRule {
  const unit = String(row.distance_unit ?? '');
  return {
    id: String(row.id),
    kind: row.kind as TurnDownKind,
    size: row.size === null ? null : Number(row.size),
    sizeUnit: String(row.size_unit ?? ''),
    priceCents: row.price_cents === null ? null : Number(row.price_cents),
    distance: row.distance === null ? null : Number(row.distance),
    distanceUnit: unit === 'mi' || unit === 'km' ? unit : null,
    days: row.days === null ? null : Number(row.days),
    text: String(row.text ?? ''),
    fromRunId: row.created_from_run_id ? String(row.created_from_run_id) : null,
  };
}

export async function turnDownRules(businessId: string, connection?: Sql) {
  return (
    await rows(
      'SELECT * FROM turn_down_rules WHERE business_id=? ORDER BY created_at,id',
      [businessId],
      connection,
    )
  ).map(ruleFrom);
}

/** "from Austin, TX", or the nearest of several. */
function fromWhere(locations: string[]) {
  if (!locations.length) return 'away';
  return locations.length === 1 ? `from ${locations[0]}` : 'from the nearest of your locations';
}

/**
 * The rule as the owner reads it in "Jobs you turn down", and as the customer chat reads it: the
 * same words, so what the owner sees is what it follows.
 */
export function ruleLine(rule: TurnDownRule, currency: Currency, locations: string[]): string {
  switch (rule.kind) {
    case 'too_small':
      return rule.priceCents !== null
        ? `Jobs that come to ${money(rule.priceCents, currency)} or less`
        : `Jobs of ${formatQuantity(rule.size ?? 0, rule.sizeUnit)} or less`;
    case 'too_big':
      return `Jobs of ${formatQuantity(rule.size ?? 0, rule.sizeUnit)} or more`;
    case 'not_offered':
      return upperFirst(rule.text);
    case 'too_far':
      return `More than about ${formatNumber(rule.distance ?? 0)} ${rule.distanceUnit ?? 'mi'} ${fromWhere(locations)}`;
    case 'lead_time':
      return `Anything sooner than ${days(rule.days ?? 0)} out`;
    case 'other':
      return upperFirst(rule.text);
  }
}

/** What the customer reads when a rule turns their request down. Plain, and it says why. */
export function customerLine(rule: TurnDownRule, businessName: string): string {
  switch (rule.kind) {
    case 'too_small':
      return `Sorry, ${businessName} doesn’t take on jobs this small. Thanks for asking.`;
    case 'too_big':
      return `Sorry, this is bigger than the jobs ${businessName} takes on. Thanks for asking.`;
    case 'not_offered':
      return `Sorry, ${businessName} doesn’t do ${lowerFirst(rule.text)}. Thanks for asking.`;
    case 'too_far':
      return `Sorry, that’s farther than ${businessName} travels. Thanks for asking.`;
    case 'lead_time':
      return `Sorry, ${businessName} can’t fit it in that soon. They book at least ${days(rule.days ?? 0)} out.`;
    case 'other':
      return `Sorry, ${businessName} can’t take this one on. Thanks for asking.`;
  }
}

/** "Turned down: too far away", as the owner sees a request in their list. */
export function turnedDownReason(rule: TurnDownRule, currency: Currency, locations: string[]) {
  return `Turned down: ${lowerFirst(REASONS[rule.kind])} (${lowerFirst(ruleLine(rule, currency, locations))}).`;
}

/** A size rule the job's own size breaks: known, in the rule's unit, and past its line. */
export function sizeTurnDown(rules: TurnDownRule[], spec: JobSpec | null) {
  if (!spec?.quantity || !spec.unit) return null;
  return (
    rules.find(
      (rule) =>
        rule.size !== null &&
        rule.sizeUnit === spec.unit &&
        ((rule.kind === 'too_small' && spec.quantity! <= rule.size) ||
          (rule.kind === 'too_big' && spec.quantity! >= rule.size)),
    ) ?? null
  );
}

/** A price rule the drafted total comes under. */
export function priceTurnDown(rules: TurnDownRule[], totalCents: number) {
  return (
    rules.find(
      (rule) =>
        rule.kind === 'too_small' &&
        rule.priceCents !== null &&
        totalCents > 0 &&
        totalCents <= rule.priceCents,
    ) ?? null
  );
}

/** The fewest days out they book, when a rule says, so quotes don't offer sooner. */
export function leadDays(rules: TurnDownRule[]) {
  const set = rules.filter((rule) => rule.kind === 'lead_time' && rule.days);
  return set.length ? Math.max(...set.map((rule) => rule.days!)) : null;
}

/** "In 7 days or later", what a quote says it can start when the owner books that far out. */
export const leadStart = (count: number) =>
  count === 1 ? 'Tomorrow or later' : `In ${count} days or later`;

/**
 * The too_far rule as miles, for what still reads one travel distance, like the practice
 * customer writer. Null for no limit.
 */
export function travelMiles(rules: TurnDownRule[]) {
  const far = rules.filter((rule) => rule.kind === 'too_far' && rule.distance);
  if (!far.length) return null;
  return Math.min(
    ...far.map((rule) =>
      rule.distanceUnit === 'km' ? Math.round(rule.distance! * 0.621371) : rule.distance!,
    ),
  );
}

const SIZE = z.number().positive().max(10_000_000);
const sizeUnit = z
  .string()
  .trim()
  .min(1, 'Say what the size is in.')
  .max(20)
  .transform((unit) => canonicalUnit(unit) ?? unit.toLowerCase());
const phrase = (max: number) =>
  z
    .string()
    .max(2000)
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(
      z.string().min(2, 'Write a few words.').max(max, `Keep it to ${max} characters or fewer.`),
    );

/** One rule, with only the values its kind uses. */
export const ruleInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('too_small'),
      size: SIZE.nullable().default(null),
      sizeUnit: sizeUnit.nullable().default(null),
      priceCents: z.number().int().min(100).max(100_000_000).nullable().default(null),
    })
    .strict(),
  z.object({ kind: z.literal('too_big'), size: SIZE, sizeUnit }).strict(),
  z.object({ kind: z.literal('not_offered'), text: phrase(120) }).strict(),
  z
    .object({
      kind: z.literal('too_far'),
      distance: z.number().positive().max(1000),
      distanceUnit: z.enum(['mi', 'km']),
    })
    .strict(),
  z.object({ kind: z.literal('lead_time'), days: z.number().int().min(1).max(180) }).strict(),
  z.object({ kind: z.literal('other'), text: phrase(200) }).strict(),
]);
export type RuleInput = z.infer<typeof ruleInput>;

/** A too_small rule needs one line: a size or a price. */
function checked(input: RuleInput): RuleInput {
  if (input.kind === 'too_small') {
    const sized = input.size !== null && Boolean(input.sizeUnit);
    if (sized === (input.priceCents !== null))
      throw new ApiError(
        422,
        'TURN_DOWN_LINE',
        'Give a size or a price for the jobs it turns down, not both.',
      );
  }
  return input;
}

function columns(input: RuleInput) {
  const base = {
    size: null as number | null,
    size_unit: null as string | null,
    price_cents: null as number | null,
    distance: null as number | null,
    distance_unit: null as string | null,
    days: null as number | null,
    text: null as string | null,
  };
  switch (input.kind) {
    case 'too_small':
      return input.priceCents !== null
        ? { ...base, price_cents: input.priceCents }
        : { ...base, size: input.size, size_unit: input.sizeUnit };
    case 'too_big':
      return { ...base, size: input.size, size_unit: input.sizeUnit };
    case 'too_far':
      return {
        ...base,
        distance: Math.round(input.distance * 10) / 10,
        distance_unit: input.distanceUnit,
      };
    case 'lead_time':
      return { ...base, days: input.days };
    default:
      return { ...base, text: input.text };
  }
}

/** Saves a rule. Locks the business so two can't both fit under the limit. */
export async function addTurnDown(
  connection: Sql,
  businessId: string,
  input: RuleInput,
  fromRunId: string | null = null,
) {
  checked(input);
  await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
  const [count] = await rows(
    'SELECT COUNT(*) AS count FROM turn_down_rules WHERE business_id=?',
    [businessId],
    connection,
  );
  if (Number(count.count) >= MAX_RULES)
    throw new ApiError(422, 'TURN_DOWN_LIMIT', `You can have up to ${MAX_RULES} of these.`);
  const id = randomUUID();
  const values = columns(input);
  await mutate(
    'INSERT INTO turn_down_rules (id,business_id,kind,size,size_unit,price_cents,distance,distance_unit,days,text,created_from_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      businessId,
      input.kind,
      values.size,
      values.size_unit,
      values.price_cents,
      values.distance,
      values.distance_unit,
      values.days,
      values.text,
      fromRunId,
    ],
    connection,
  );
  return id;
}

/** Changes a rule's line. Its reason stays: a different reason is a different rule. */
async function changeTurnDown(businessId: string, id: string, input: RuleInput) {
  checked(input);
  const values = columns(input);
  const updated = await mutate(
    'UPDATE turn_down_rules SET size=?,size_unit=?,price_cents=?,distance=?,distance_unit=?,days=?,text=? WHERE id=? AND business_id=? AND kind=?',
    [
      values.size,
      values.size_unit,
      values.price_cents,
      values.distance,
      values.distance_unit,
      values.days,
      values.text,
      id,
      businessId,
      input.kind,
    ],
  );
  if (!updated.affectedRows)
    throw new ApiError(404, 'TURN_DOWN_NOT_FOUND', 'That one isn’t here anymore.');
}

/** The least the owner charges for a job, or null when they haven't said. */
export async function minimumCharge(businessId: string, connection?: Sql) {
  const [business] = await rows(
    'SELECT minimum_cents FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  return business?.minimum_cents ? Number(business.minimum_cents) : null;
}

export const minimumInput = z.number().int().min(100).max(100_000_000).nullable();

export async function setMinimum(businessId: string, cents: number | null, connection?: Sql) {
  await mutate('UPDATE businesses SET minimum_cents=? WHERE id=?', [cents, businessId], connection);
}

/** "Charges at least $150 for any job", as What it knows and the practice card say it. */
export const minimumLine = (cents: number, currency: Currency) =>
  `Charges at least ${money(cents, currency)} for any job`;

/** Everything the owner sees and changes: each rule in their words, and their minimum. */
export async function turnDownView(businessId: string) {
  const [business] = await rows('SELECT currency,minimum_cents FROM businesses WHERE id=?', [
    businessId,
  ]);
  const currency = currencyOf(business?.currency);
  const locations = await businessLocations(businessId);
  return {
    rules: (await turnDownRules(businessId)).map((rule) => ({
      ...rule,
      reason: REASONS[rule.kind],
      line: ruleLine(rule, currency, locations),
    })),
    minimumCents: business?.minimum_cents ? Number(business.minimum_cents) : null,
    locations,
  };
}
export type TurnDownView = Awaited<ReturnType<typeof turnDownView>>;

/** The rules as the intake reads them: the same lines the owner sees, by code. */
export async function intakeTurnDowns(businessId: string) {
  const view = await turnDownView(businessId);
  return {
    rules: view.rules,
    turnDowns: view.rules.map((rule) => ({ kind: rule.kind, rule: rule.line })),
    locations: view.locations,
  };
}

export const turnDownsRouter = Router();
const ruleId = z.uuid();

turnDownsRouter.get('/onboarding/turn-downs', requireWorkspace, async (req, res) => {
  res.json(ok(await turnDownView(workspace(req).businessId)));
});

turnDownsRouter.post(
  '/onboarding/turn-downs',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const input = ruleInput.parse(req.body);
    const { businessId } = workspace(req);
    await transaction((connection) => addTurnDown(connection, businessId, input));
    await recordRequestEvent(req, businessId, 'turn_down_changed', {
      action: 'add',
      kind: input.kind,
    });
    res.status(201).json(ok(await turnDownView(businessId)));
  },
);

turnDownsRouter.put(
  '/onboarding/turn-downs/:id',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const input = ruleInput.parse(req.body);
    const { businessId } = workspace(req);
    await changeTurnDown(businessId, ruleId.parse(req.params.id), input);
    await recordRequestEvent(req, businessId, 'turn_down_changed', {
      action: 'edit',
      kind: input.kind,
    });
    res.json(ok(await turnDownView(businessId)));
  },
);

turnDownsRouter.delete('/onboarding/turn-downs/:id', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const id = ruleId.parse(req.params.id);
  const [rule] = await rows('SELECT kind FROM turn_down_rules WHERE id=? AND business_id=?', [
    id,
    businessId,
  ]);
  if (!rule) throw new ApiError(404, 'TURN_DOWN_NOT_FOUND', 'That one isn’t here anymore.');
  await mutate('DELETE FROM turn_down_rules WHERE id=? AND business_id=?', [id, businessId]);
  await recordRequestEvent(req, businessId, 'turn_down_changed', {
    action: 'remove',
    kind: String(rule.kind),
  });
  res.json(ok(await turnDownView(businessId)));
});

/** The least they charge, or null to take it off. */
turnDownsRouter.put(
  '/onboarding/minimum',
  rateLimit(20, 60_000),
  requireWorkspace,
  async (req, res) => {
    const { minimumCents } = z.object({ minimumCents: minimumInput }).strict().parse(req.body);
    const { businessId } = workspace(req);
    await setMinimum(businessId, minimumCents);
    await recordRequestEvent(req, businessId, 'minimum_changed', {
      minimum_cents: minimumCents,
    });
    res.json(ok(await turnDownView(businessId)));
  },
);
