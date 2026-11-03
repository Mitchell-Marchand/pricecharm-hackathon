import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { hashingSecret } from './config.js';
import { mutate, rows, type Sql } from './db.js';
import { rateLimit } from './http.js';
import { queueEmail } from './integrations/email.js';
import { formatInsights, insightsReport } from './insights.js';
import { wordingReport } from './live/accept-wording.js';
import { SIGNUP_STEPS, queueSignupAlert, type SignupStep } from './signup-alerts.js';

/**
 * Product metrics, kept in our own database. Events say what happened and when, never names,
 * contact details or anything anyone typed. They're filed under the business's metrics_subject,
 * a random tag deleted along with the business, so a closed account's rows can't be traced back.
 */

/** Things a business does once. Only the first time counts. */
export type Milestone =
  | 'setup_started'
  | 'setup_step'
  | 'account_created'
  | 'email_verified'
  | 'billing_active'
  | 'went_live'
  | 'plan_chosen';
/** Things that keep happening: one row each, keyed by the chat or quote. */
export type Activity =
  'customer_chat' | 'quote_drafted' | 'quote_sent' | 'quote_seen' | 'quote_outcome';

export async function subjectOf(businessId: string, connection?: Sql): Promise<string | undefined> {
  const [business] = await rows(
    'SELECT metrics_subject FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  return business?.metrics_subject ? String(business.metrics_subject) : undefined;
}

export async function recordMilestone(
  connection: Sql | undefined,
  businessId: string,
  name: Milestone,
  detail = '',
  extra: { props?: EventProps; session?: string | null } = {},
): Promise<void> {
  const subject = await subjectOf(businessId, connection);
  if (!subject) return;
  const saved = await mutate(
    'INSERT IGNORE INTO product_events (id,subject,name,detail,dedupe_key,session,props) VALUES (?,?,?,?,?,?,?)',
    [
      randomUUID(),
      subject,
      name,
      detail,
      `${subject}:${name}:${detail}`,
      extra.session ?? null,
      extra.props ? JSON.stringify(cleanProps(extra.props)) : null,
    ],
    connection,
  );
  // The first setup, account and card also email us, with who it is.
  if (saved.affectedRows && SIGNUP_STEPS.has(name))
    await queueSignupAlert(connection, businessId, name as SignupStep);
}

/** The same milestone, for a step that only knows which owner took it. */
export async function recordOwnerMilestone(
  connection: Sql | undefined,
  userId: string,
  name: Milestone,
): Promise<void> {
  const [user] = await rows('SELECT business_id FROM users WHERE id=?', [userId], connection);
  if (user) await recordMilestone(connection, String(user.business_id), name);
}

export async function recordActivity(
  connection: Sql | undefined,
  businessId: string,
  name: Activity,
  input: { ref: string; detail?: string; value?: number },
): Promise<void> {
  const subject = await subjectOf(businessId, connection);
  if (!subject) return;
  await mutate(
    'INSERT IGNORE INTO product_events (id,subject,name,detail,ref,value,dedupe_key) VALUES (?,?,?,?,?,?,?)',
    [
      randomUUID(),
      subject,
      name,
      input.detail ?? '',
      input.ref,
      input.value ?? null,
      `${name}:${input.ref}`,
    ],
    connection,
  );
}

/**
 * What an event says about itself: counts, flags, amounts, steps and the owner's own labels, such
 * as a service name. Never names, contact details or what anyone wrote.
 */
export type EventProps = Record<string, string | number | boolean | null | undefined>;
export const PROP_KEY = /^[a-z][a-z_0-9]{0,39}$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

/** Drops anything malformed, and scrubs email addresses and phone numbers from text. */
export function cleanProps(props: EventProps): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(props).slice(0, 30)) {
    if (!PROP_KEY.test(key) || value === undefined) continue;
    if (typeof value === 'string')
      clean[key] = value.replace(EMAIL, '[email]').replace(PHONE, '[number]').slice(0, 300);
    else if (typeof value === 'number') clean[key] = Number.isFinite(value) ? value : null;
    else clean[key] = value;
  }
  return clean;
}

/** The browser tab an API call came from. The web app sends it with every request. */
export function requestSession(req: Request): string | null {
  const value = req.get('x-pc-session') ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

/** Something that happened on the server, with the facts at that moment. */
export async function recordEvent(
  connection: Sql | undefined,
  businessId: string | null,
  name: string,
  props: EventProps = {},
  options: { session?: string | null; ref?: string; value?: number } = {},
): Promise<void> {
  const subject = businessId ? ((await subjectOf(businessId, connection)) ?? null) : null;
  if (!subject && !options.session) return;
  await mutate(
    'INSERT INTO product_events (id,subject,name,ref,value,session,props) VALUES (?,?,?,?,?,?,?)',
    [
      randomUUID(),
      subject,
      name,
      options.ref ?? null,
      options.value ?? null,
      options.session ?? null,
      JSON.stringify(cleanProps(props)),
    ],
    connection,
  );
}

/** The same, from a route: the business and browser tab come from the request. */
export function recordRequestEvent(
  req: Request,
  businessId: string | null,
  name: string,
  props: EventProps = {},
  options: { ref?: string; value?: number } = {},
): Promise<void> {
  return recordEvent(undefined, businessId, name, props, {
    ...options,
    session: requestSession(req),
  });
}

/**
 * Where a setup stands. Saved with each step, so the numbers outlive a setup that's deleted
 * unfinished, which takes its own rows with it.
 */
export async function setupFacts(businessId: string, connection?: Sql): Promise<EventProps> {
  const [row] = await rows(
    `SELECT b.trade_id,b.custom_trade,b.travel_radius_miles,b.service_area,
       (SELECT COUNT(*) FROM offerings o WHERE o.business_id=b.id) AS services,
       (SELECT COUNT(*) FROM offerings o WHERE o.business_id=b.id AND o.custom) AS custom_services,
       (SELECT COUNT(*) FROM past_jobs j WHERE j.business_id=b.id) AS jobs,
       (SELECT COUNT(*) FROM past_jobs j WHERE j.business_id=b.id AND j.source='invoice') AS invoice_jobs,
       (SELECT COUNT(*) FROM practice_runs p WHERE p.business_id=b.id AND p.status='finished') AS practice_done
     FROM businesses b WHERE b.id=?`,
    [businessId],
    connection,
  );
  if (!row) return {};
  return {
    trade: row.trade_id ? String(row.trade_id) : row.custom_trade ? 'custom' : '',
    custom_trade: row.custom_trade ? String(row.custom_trade) : '',
    radius: row.travel_radius_miles === null ? null : Number(row.travel_radius_miles),
    has_area: Boolean(row.service_area),
    services: Number(row.services),
    custom_services: Number(row.custom_services),
    jobs: Number(row.jobs),
    invoice_jobs: Number(row.invoice_jobs),
    practice_done: Number(row.practice_done),
  };
}

/** What an owner filled in for one past job, without the words. */
export function jobFacts(job: {
  serviceName: string;
  description: string;
  priceCents: number;
  size: string;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: { kind: string; value: number } | null;
  notes: string;
  source: string;
  slot: string | null;
  photoIds?: string[];
}): EventProps {
  return {
    service: job.serviceName,
    price_cents: job.priceCents,
    has_size: Boolean(job.size),
    has_duration: Boolean(job.duration),
    has_when: Boolean(job.when),
    has_materials: job.materialsCents !== null,
    discount: job.discount?.kind ?? '',
    description_chars: job.description.length,
    notes_chars: job.notes.length,
    photos: job.photoIds?.length ?? 0,
    source: job.source,
    slot: job.slot ?? '',
  };
}

/** The public pages whose visits are counted. */
export const COUNTED_PAGES = ['/', '/pricing', '/demo', '/start', '/privacy', '/terms'] as const;

/** A keyed hash of the visitor's address and browser that changes every day. */
function visitorKey(ip: string, userAgent: string, day: string): string | undefined {
  const key = hashingSecret();
  if (!key) return undefined;
  const context = createHmac('sha256', key).update('quotient-page-visit-v1').digest();
  const address = ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return createHmac('sha256', context)
    .update(`${day}\n${isIP(address) ? address : 'unavailable'}\n${userAgent.slice(0, 300)}`)
    .digest('hex');
}

const visit = z
  .object({
    path: z.enum(COUNTED_PAGES),
    // Only the site that sent them, such as google.com, and a utm_source if the link had one.
    referrer: z
      .string()
      .max(100)
      .regex(/^[a-z0-9.-]*$/)
      .default(''),
    campaign: z
      .string()
      .max(60)
      .regex(/^[a-z0-9_.-]*$/)
      .default(''),
  })
  .strict();

export const visitsRouter = Router();
visitsRouter.post('/visits', rateLimit(30, 60_000), async (req, res) => {
  const input = visit.parse(req.body);
  const day = new Date().toISOString().slice(0, 10);
  const visitor = visitorKey(req.ip ?? '', req.get('user-agent') ?? '', day);
  if (visitor)
    await mutate(
      'INSERT IGNORE INTO page_visits (day,path,visitor,referrer,campaign) VALUES (?,?,?,?,?)',
      [day, input.path, visitor, input.referrer, input.campaign],
    );
  res.status(204).end();
});

/** Visit counts and browser events go after 400 days. Milestones and server events stay. */
export async function pruneVisits(connection?: Sql): Promise<void> {
  await mutate(
    'DELETE FROM page_visits WHERE day<DATE_SUB(UTC_DATE(),INTERVAL 400 DAY)',
    [],
    connection,
  );
  await mutate(
    "DELETE FROM product_events WHERE source='browser' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 400 DAY) LIMIT 20000",
    [],
    connection,
  );
}

// Setup's steps: practice comes straight after the business now. Before November 2026 past jobs
// came between them, as the 'jobs' step, reached once the trade and name were in.
const FUNNEL = [
  ['Started setup', "name='setup_started'"],
  ['Picked their trade', "name='setup_step' AND detail IN ('services','jobs')"],
  ['Described their business', "name='setup_step' AND detail='practice'"],
  ['Finished practice', "name='setup_step' AND detail='ready'"],
  ['Made an account', "name='account_created'"],
  ['Confirmed their email', "name='email_verified'"],
  ['Added a card', "name='billing_active'"],
  ['Turned on their quote link', "name='went_live'"],
  ['Got a customer request', "name='customer_chat' AND detail<>'test'"],
  ['Sent a customer a quote', "name='quote_sent' AND detail<>'test'"],
] as const;

type Count = { label: string; count: number; previous: number };

async function between(since: Date, until: Date) {
  const range = [since, until];
  const count = async (sql: string, parameters: (string | Date)[] = []) =>
    Number((await rows(sql, [...parameters, ...range]))[0]?.count ?? 0);
  const event = (where: string) =>
    count(
      `SELECT COUNT(*) AS count FROM product_events WHERE ${where} AND created_at>=? AND created_at<?`,
    );
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const visits = Number(
    (
      await rows(
        'SELECT COUNT(DISTINCT day,visitor) AS count FROM page_visits WHERE day>? AND day<=?',
        [day(since), day(until)],
      )
    )[0]?.count ?? 0,
  );
  return {
    visitors: visits,
    setups: await event("name='setup_started'"),
    accounts: await event("name='account_created'"),
    live: await event("name='went_live'"),
    chats: await event("name='customer_chat' AND detail<>'test'"),
    widgetChats: await event("name='customer_chat' AND detail='widget'"),
    drafted: await event("name='quote_drafted' AND detail<>'test'"),
    sentAuto: await event("name='quote_sent' AND detail='auto'"),
    sentOwner: await event("name='quote_sent' AND detail='owner'"),
    // Sent by the owner for a different total than the Charm drafted.
    priceChanged: await count(
      `SELECT COUNT(*) AS count FROM product_events s JOIN product_events d ON d.ref=s.ref AND d.name='quote_drafted'
       WHERE s.name='quote_sent' AND s.detail='owner' AND s.value<>d.value AND s.created_at>=? AND s.created_at<?`,
    ),
    accepted: await event("name='quote_outcome' AND detail='accepted'"),
    visit: await event("name='quote_outcome' AND detail='visit'"),
    lost: await event("name='quote_outcome' AND detail='lost'"),
    // Dollars only: rupees and dollars don't add up to one number.
    sentValue: await count(
      `SELECT COALESCE(SUM(value),0) AS count FROM product_events WHERE name='quote_sent' AND detail<>'test' AND created_at>=? AND created_at<? AND subject IN (SELECT metrics_subject FROM businesses WHERE currency='USD')`,
    ),
    activeBusinesses: await count(
      `SELECT COUNT(DISTINCT subject) AS count FROM product_events WHERE name='customer_chat' AND detail<>'test' AND created_at>=? AND created_at<?`,
    ),
  };
}

/**
 * The numbers for the last `days` days, with the same span before for comparison, and the funnel
 * for setups started in the span: how far each of them has got by now.
 */
export async function metricsReport(days: number, now = new Date()) {
  const span = days * 86_400_000;
  const since = new Date(now.getTime() - span);
  const current = await between(since, now);
  const previous = await between(new Date(since.getTime() - span), since);
  const funnel: { label: string; count: number }[] = [];
  for (const [label, where] of FUNNEL)
    funnel.push({
      label,
      count: Number(
        (
          await rows(
            `SELECT COUNT(DISTINCT e.subject) AS count FROM product_events e
             WHERE ${where} AND e.subject IN (SELECT subject FROM product_events WHERE name='setup_started' AND created_at>=? AND created_at<?)`,
            [since, now],
          )
        )[0]?.count ?? 0,
      ),
    });
  // Each visitor counts once a day, for the page they arrived on.
  const sources = await rows(
    `SELECT IF(v.campaign<>'',v.campaign,IF(v.referrer<>'',v.referrer,'direct')) AS source,COUNT(DISTINCT v.day,v.visitor) AS count
     FROM page_visits v JOIN (
       SELECT day,visitor,MIN(created_at) AS first FROM page_visits WHERE day>? AND day<=? GROUP BY day,visitor
     ) arrival ON arrival.day=v.day AND arrival.visitor=v.visitor AND arrival.first=v.created_at
     GROUP BY source ORDER BY count DESC LIMIT 5`,
    [since.toISOString().slice(0, 10), now.toISOString().slice(0, 10)],
  );
  const pair = (label: string, key: keyof typeof current): Count => ({
    label,
    count: current[key],
    previous: previous[key],
  });
  return {
    days,
    since: since.toISOString(),
    until: now.toISOString(),
    totals: [
      pair('Visitors', 'visitors'),
      pair('Setups started', 'setups'),
      pair('Accounts made', 'accounts'),
      pair('Quote links turned on', 'live'),
      pair('Businesses with customer requests', 'activeBusinesses'),
      pair('Customer requests', 'chats'),
      pair('  from a website button', 'widgetChats'),
      pair('Quotes drafted', 'drafted'),
      pair('Quotes sent on their own', 'sentAuto'),
      pair('Quotes sent by the owner', 'sentOwner'),
      pair('  owner changed the price', 'priceChanged'),
      pair('Accepted', 'accepted'),
      pair('Asked for a visit', 'visit'),
      pair('Turned down', 'lost'),
    ],
    sentValueCents: current.sentValue,
    previousSentValueCents: previous.sentValue,
    funnel,
    sources: sources.map((item) => ({ source: String(item.source), count: Number(item.count) })),
    acceptButton: await wordingReport(since, now),
  };
}

export type MetricsReport = Awaited<ReturnType<typeof metricsReport>>;

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** The report as plain text, for the terminal and the weekly email. */
export function formatReport(report: MetricsReport): string {
  const width = Math.max(...report.totals.map((item) => item.label.length), 26) + 2;
  const change = (now: number, before: number) =>
    before ? ` (${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%)` : '';
  const span = report.days === 1 ? 'day' : `${report.days} days`;
  const lines = [
    `PriceCharm, the last ${span}`,
    `${report.since.slice(0, 10)} to ${report.until.slice(0, 10)}, compared with the ${span} before`,
    '',
    ...report.totals.map(
      (item) =>
        `${item.label.padEnd(width)}${String(item.count).padStart(6)}   was ${item.previous}${change(item.count, item.previous)}`,
    ),
    `${'Value of USD quotes sent'.padEnd(width)}${dollars(report.sentValueCents).padStart(6)}   was ${dollars(report.previousSentValueCents)}`,
    '',
    `Setups started in that time, and how far they've got`,
  ];
  const started = report.funnel[0]?.count ?? 0;
  for (const step of report.funnel)
    lines.push(
      `${step.label.padEnd(width)}${String(step.count).padStart(6)}${started ? `   ${Math.round((step.count / started) * 100)}%` : ''}`,
    );
  if (report.sources.length) {
    lines.push('', 'Where visitors came from');
    for (const item of report.sources)
      lines.push(`${item.source.padEnd(width)}${String(item.count).padStart(6)}`);
  }
  const button = report.acceptButton;
  lines.push('', 'The accept button: quotes customers saw, and the yeses within two weeks');
  for (const item of button.wordings)
    lines.push(
      `${item.label.padEnd(width)}${String(item.seen).padStart(6)} seen${String(item.accepted).padStart(5)} yes${item.seen ? `  ${Math.round((item.accepted / item.seen) * 100)}%` : ''}   ${Math.round(item.chanceBest * 100)}% likely best, on ${Math.round(item.share * 100)}% of new quotes`,
    );
  if (button.owners.length) {
    lines.push(
      '',
      `Owners' own wordings, on ${Math.round(button.ownWordingShare * 100)}% of new quotes`,
    );
    for (const item of button.owners)
      lines.push(
        `${`“${item.label}”`.padEnd(width)}${String(item.businesses).padStart(6)} ${item.businesses === 1 ? 'business' : 'businesses'}, ${item.seen} seen, ${item.accepted} yes`,
      );
  }
  return lines.join('\n');
}

/** Monday mornings (UTC), the week's report goes to METRICS_EMAIL, if it's set. */
export async function queueWeeklyReport(now = new Date()): Promise<void> {
  const to = z.email().safeParse(process.env.METRICS_EMAIL?.trim());
  if (!to.success || now.getUTCDay() !== 1 || now.getUTCHours() < 12) return;
  const dedupeKey = `metrics-week:${now.toISOString().slice(0, 10)}`;
  if ((await rows('SELECT id FROM email_outbox WHERE dedupe_key=?', [dedupeKey])).length) return;
  const report = await metricsReport(7, now);
  const total = (label: string) => report.totals.find((item) => item.label === label)?.count ?? 0;
  const sent = total('Quotes sent on their own') + total('Quotes sent by the owner');
  await queueEmail({
    to: to.data,
    dedupeKey,
    subject: `PriceCharm this week: ${total('Setups started')} setups, ${sent} quotes sent`,
    text: `${formatReport(report)}\n\n${formatInsights(await insightsReport(7, now))}`.slice(
      0,
      29_000,
    ),
  });
}
