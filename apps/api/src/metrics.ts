import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { hashingSecret } from './config.js';
import { mutate, rows, type Sql } from './db.js';
import { rateLimit } from './http.js';
import { queueEmail } from './integrations/email.js';

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
export type Activity = 'customer_chat' | 'quote_drafted' | 'quote_sent' | 'quote_outcome';

async function subjectOf(businessId: string, connection?: Sql): Promise<string | undefined> {
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
): Promise<void> {
  const subject = await subjectOf(businessId, connection);
  if (!subject) return;
  await mutate(
    'INSERT IGNORE INTO product_events (id,subject,name,detail,dedupe_key) VALUES (?,?,?,?,?)',
    [randomUUID(), subject, name, detail, `${subject}:${name}:${detail}`],
    connection,
  );
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

/** Visit counts older than this go in the daily maintenance. */
export async function pruneVisits(connection?: Sql): Promise<void> {
  await mutate(
    'DELETE FROM page_visits WHERE day<DATE_SUB(UTC_DATE(),INTERVAL 400 DAY)',
    [],
    connection,
  );
}

const FUNNEL = [
  ['Started setup', "name='setup_started'"],
  ['Described their business', "name='setup_step' AND detail='jobs'"],
  ['Added past jobs', "name='setup_step' AND detail='practice'"],
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
    sentValue: await count(
      `SELECT COALESCE(SUM(value),0) AS count FROM product_events WHERE name='quote_sent' AND detail<>'test' AND created_at>=? AND created_at<?`,
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
    `${'Value of quotes sent'.padEnd(width)}${dollars(report.sentValueCents).padStart(6)}   was ${dollars(report.previousSentValueCents)}`,
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
    text: formatReport(report),
  });
}
