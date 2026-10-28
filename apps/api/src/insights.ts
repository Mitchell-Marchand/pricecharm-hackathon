import { rows } from './db.js';

/**
 * The detail behind the weekly numbers: what kinds of businesses set up, how much they gave the
 * Charm, how long setup really took them, where the ones who left stopped and what they saw last,
 * what got in people's way, and the moments it worked.
 */

type Event = {
  subject: string | null;
  session: string | null;
  name: string;
  detail: string;
  path: string;
  props: Record<string, unknown>;
  at: number;
};

const parse = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};
const toEvent = (row: Record<string, unknown>): Event => ({
  subject: row.subject ? String(row.subject) : null,
  session: row.session ? String(row.session) : null,
  name: String(row.name),
  detail: String(row.detail ?? ''),
  path: String(row.path ?? ''),
  props: parse(row.props),
  at: new Date(row.created_at as string).getTime(),
});
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function tally(items: string[], limit = 10): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** How far a setup got, in order. */
const STAGES = [
  'started',
  'described their business',
  'got past the past jobs',
  'finished practice',
  'made an account',
  'confirmed their email',
  'added a card',
  'turned on their link',
  'got a customer request',
  'sent a customer a quote',
] as const;
function stageOf(events: Event[]): number {
  const has = (test: (event: Event) => boolean) => events.some(test);
  const reached = [
    true,
    has((e) => e.name === 'setup_step' && e.detail === 'jobs'),
    has((e) => e.name === 'setup_step' && e.detail === 'practice'),
    has((e) => e.name === 'setup_step' && e.detail === 'ready'),
    has((e) => e.name === 'account_created'),
    has((e) => e.name === 'email_verified'),
    has((e) => e.name === 'billing_active'),
    has((e) => e.name === 'went_live'),
    has((e) => e.name === 'customer_chat' && e.detail !== 'test'),
    has((e) => e.name === 'quote_sent' && e.detail !== 'test'),
  ];
  return reached.lastIndexOf(true);
}

async function chunked(
  sql: (marks: string) => string,
  ids: string[],
  extra: (string | Date)[] = [],
): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  for (let start = 0; start < ids.length; start += 500) {
    const part = ids.slice(start, start + 500);
    found.push(...(await rows(sql(part.map(() => '?').join(',')), [...part, ...extra])));
  }
  return found;
}

export async function insightsReport(days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const window = [since, now];

  // Setups started in the span, everything their businesses did, and every browser tab they used.
  const cohort = (
    await rows(
      "SELECT DISTINCT subject FROM product_events WHERE name='setup_started' AND created_at>=? AND created_at<?",
      window,
    )
  ).map((row) => String(row.subject));
  const own = (
    await chunked(
      (marks) =>
        `SELECT subject,session,name,detail,path,props,created_at FROM product_events WHERE subject IN (${marks}) ORDER BY created_at`,
      cohort,
    )
  ).map(toEvent);
  const sessionOwner = new Map<string, string>();
  for (const event of own)
    if (event.session && event.subject) sessionOwner.set(event.session, event.subject);
  const browser = (
    await chunked(
      (marks) =>
        `SELECT subject,session,name,detail,path,props,created_at FROM product_events WHERE source='browser' AND subject IS NULL AND session IN (${marks}) ORDER BY created_at`,
      [...sessionOwner.keys()],
    )
  ).map(toEvent);
  const bySubject = new Map<string, Event[]>(cohort.map((subject) => [subject, []]));
  for (const event of [...own, ...browser]) {
    const subject = event.subject ?? (event.session ? sessionOwner.get(event.session) : undefined);
    if (subject) bySubject.get(subject)?.push(event);
  }

  const setups = [...bySubject].map(([subject, events]) => {
    events.sort((a, b) => a.at - b.at);
    const facts = events.filter((e) => typeof e.props.trade === 'string' && e.props.trade);
    const trade = facts.length ? String(facts.at(-1)!.props.trade) : 'not chosen';
    const stage = stageOf(events);
    const jobs = Math.max(0, ...events.map((e) => num(e.props.jobs)));
    const invoiceJobs = Math.max(0, ...events.map((e) => num(e.props.invoice_jobs)));
    const services = Math.max(0, ...events.map((e) => num(e.props.services)));
    const setupScreens = events.filter(
      (e) => e.name === 'screen_left' && String(e.props.screen ?? '').startsWith('/start'),
    );
    const activeMs = setupScreens.reduce((sum, e) => sum + num(e.props.active_ms), 0);
    const started = events.find((e) => e.name === 'setup_started')?.at ?? 0;
    const account = events.find((e) => e.name === 'account_created')?.at;
    const screens = events.filter((e) => e.name === 'screen_viewed');
    const last = screens.at(-1);
    const lastClick = events.filter((e) => e.name === 'clicked').at(-1);
    const errors = events.filter((e) => e.name === 'error_shown' || e.name === 'api_error');
    const practice = events.filter((e) => e.name === 'practice_quoted');
    return {
      subject,
      trade,
      stage,
      jobs,
      invoiceJobs,
      services,
      activeMinutes: activeMs / 60_000,
      minutesToAccount: account ? (account - started) / 60_000 : null,
      lastScreen: last?.path ?? '',
      lastClick: lastClick ? String(lastClick.props.label ?? '') : '',
      lastError: errors.length
        ? String(errors.at(-1)!.props.text ?? errors.at(-1)!.props.code ?? '')
        : '',
      practice,
    };
  });

  const byTrade = new Map<string, typeof setups>();
  for (const setup of setups)
    byTrade.set(setup.trade, [...(byTrade.get(setup.trade) ?? []), setup]);
  const trades = [...byTrade]
    .map(([trade, group]) => ({
      trade,
      started: group.length,
      practiced: group.filter((s) => s.stage >= 3).length,
      accounts: group.filter((s) => s.stage >= 4).length,
      live: group.filter((s) => s.stage >= 7).length,
      medianJobs: median(group.map((s) => s.jobs)),
    }))
    .sort((a, b) => b.started - a.started);

  const left = setups.filter((s) => s.stage < 4);
  const practiceQuotes = setups.flatMap((s) => s.practice);
  const gaps = practiceQuotes
    .map((e) => e.props.gap_pct)
    .filter((gap): gap is number => typeof gap === 'number');

  // Everyone in the span, setup or not.
  const recent = (
    await rows(
      'SELECT subject,session,name,detail,path,props,created_at FROM product_events WHERE created_at>=? AND created_at<? AND name IN (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        ...window,
        'error_shown',
        'api_error',
        'network_error',
        'api_slow',
        'rage_click',
        'clicked_nothing',
        'js_error',
        'screen_left',
        'ai_call',
        'ai_failed',
        'customer_chat',
        'customer_contact_given',
        'customer_verified',
        'customer_code_failed',
        'quote_approved',
        'session_started',
      ],
    )
  ).map(toEvent);
  const named = (name: string) => recent.filter((e) => e.name === name);
  const screenTime = new Map<string, number[]>();
  for (const e of named('screen_left')) {
    const screen = String(e.props.screen ?? '');
    screenTime.set(screen, [...(screenTime.get(screen) ?? []), num(e.props.active_ms)]);
  }
  const aiCalls = named('ai_call');
  const byOperation = new Map<string, Event[]>();
  for (const call of aiCalls) {
    const operation = String(call.props.operation ?? '');
    byOperation.set(operation, [...(byOperation.get(operation) ?? []), call]);
  }
  const approvals = named('quote_approved').filter((e) => !e.props.test);
  const realChats = named('customer_chat').filter((e) => e.detail !== 'test');

  return {
    days,
    since: since.toISOString(),
    until: now.toISOString(),
    setups: {
      started: setups.length,
      trades,
      medianJobs: median(setups.map((s) => s.jobs)),
      medianInvoiceJobs: median(setups.map((s) => s.invoiceJobs)),
      medianServices: median(setups.map((s) => s.services)),
      // Time with the tab open and someone working, not time the tab sat there.
      medianActiveMinutes: median(setups.map((s) => s.activeMinutes).filter((m) => m > 0)),
      medianMinutesToAccount: median(
        setups.map((s) => s.minutesToAccount).filter((m): m is number => m !== null),
      ),
      stages: STAGES.map((label, index) => ({
        label,
        count: setups.filter((s) => s.stage >= index).length,
      })),
      leftWithoutAccount: left.length,
      lastScreens: tally(left.map((s) => s.lastScreen || '(no screen recorded)')),
      lastClicks: tally(left.map((s) => s.lastClick).filter(Boolean)),
      lastErrors: tally(left.map((s) => s.lastError).filter(Boolean)),
    },
    practice: {
      quotes: practiceQuotes.length,
      medianGapPct: median(gaps),
      // The Charm's own guess within 10% of the owner's price: the moment it clicks.
      within10: gaps.filter((gap) => gap <= 10).length,
      within25: gaps.filter((gap) => gap <= 25).length,
      aiWantedVisit: practiceQuotes.filter((e) => e.props.ai_wanted_visit).length,
    },
    screens: [...screenTime]
      .map(([screen, times]) => ({
        screen,
        views: times.length,
        medianSeconds: Math.round((median(times) ?? 0) / 1000),
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 15),
    struggles: {
      errorsShown: tally(named('error_shown').map((e) => String(e.props.text ?? ''))),
      failedRequests: tally(
        named('api_error').map((e) => `${e.props.method} ${e.props.endpoint} ${e.props.code}`),
      ),
      networkErrors: named('network_error').length,
      slowRequests: tally(named('api_slow').map((e) => `${e.props.method} ${e.props.endpoint}`)),
      rageClicks: tally(
        named('rage_click').map((e) => `${e.path}: ${e.props.label || e.props.element}`),
      ),
      deadClicks: tally(
        named('clicked_nothing').map((e) => `${e.path}: ${e.props.label || e.props.element}`),
      ),
      pageCrashes: tally(named('js_error').map((e) => String(e.props.message ?? ''))),
    },
    owners: {
      approved: approvals.length,
      edited: approvals.filter((e) => e.props.edited).length,
      medianChangePct: median(
        approvals.map((e) => e.props.change_pct).filter((v): v is number => typeof v === 'number'),
      ),
      medianWaitMinutes: median(approvals.map((e) => num(e.props.waited_minutes))),
      fromEmailLink: approvals.filter((e) => e.props.via === 'email').length,
    },
    customers: {
      chats: realChats.length,
      fromWidget: realChats.filter((e) => e.detail === 'widget').length,
      gaveContact: named('customer_contact_given').filter((e) => e.props.source !== 'test').length,
      verified: named('customer_verified').filter((e) => e.props.source !== 'test').length,
      codeFailures: named('customer_code_failed').filter((e) => e.props.source !== 'test').length,
    },
    ai: {
      calls: aiCalls.length,
      failures: tally(named('ai_failed').map((e) => `${e.props.operation}: ${e.props.reason}`)),
      operations: [...byOperation]
        .map(([operation, calls]) => ({
          operation,
          calls: calls.length,
          medianSeconds: Math.round((median(calls.map((c) => num(c.props.ms))) ?? 0) / 100) / 10,
          inputTokens: calls.reduce((sum, c) => sum + num(c.props.input_tokens), 0),
          outputTokens: calls.reduce((sum, c) => sum + num(c.props.output_tokens), 0),
        }))
        .sort((a, b) => b.calls - a.calls),
    },
    visits: {
      sessions: named('session_started').length,
      devices: tally(named('session_started').map((e) => String(e.props.device ?? ''))),
      landing: tally(named('session_started').map((e) => String(e.props.landing ?? ''))),
    },
  };
}

export type InsightsReport = Awaited<ReturnType<typeof insightsReport>>;

const minutes = (value: number | null) => (value === null ? '–' : `${Math.round(value)} min`);
const share = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '–';

export function formatInsights(report: InsightsReport): string {
  const lines: string[] = [];
  const list = (title: string, items: { label: string; count: number }[]) => {
    if (!items.length) return;
    lines.push('', title);
    for (const item of items) lines.push(`  ${String(item.count).padStart(4)}  ${item.label}`);
  };
  const { setups, practice, struggles, owners, customers, ai, visits } = report;
  lines.push('SETUP', `Started: ${setups.started}`);
  for (const stage of setups.stages.slice(1))
    lines.push(
      `  ${stage.label.padEnd(26)}${String(stage.count).padStart(5)}  ${share(stage.count, setups.started)}`,
    );
  lines.push(
    `Median past jobs given: ${setups.medianJobs ?? '–'} (from invoices: ${setups.medianInvoiceJobs ?? '–'})`,
    `Median services listed: ${setups.medianServices ?? '–'}`,
    `Median time actually working in setup: ${minutes(setups.medianActiveMinutes)}`,
    `Median time from start to account: ${minutes(setups.medianMinutesToAccount)}`,
  );
  if (setups.trades.length) {
    lines.push('', 'By trade                      started  practiced  account  live  jobs');
    for (const trade of setups.trades)
      lines.push(
        `  ${trade.trade.padEnd(28)}${String(trade.started).padStart(5)}${String(trade.practiced).padStart(11)}${String(trade.accounts).padStart(9)}${String(trade.live).padStart(6)}${String(trade.medianJobs ?? '–').padStart(6)}`,
      );
  }
  lines.push('', `Left before making an account: ${setups.leftWithoutAccount}`);
  list('  Last screen they saw', setups.lastScreens);
  list('  Last thing they clicked', setups.lastClicks);
  list('  Last error they hit', setups.lastErrors);

  lines.push(
    '',
    'PRACTICE',
    `Practice quotes: ${practice.quotes}`,
    `Charm's guess within 10% of the owner's price: ${practice.within10} (${share(practice.within10, practice.quotes)}), within 25%: ${practice.within25}`,
    `Median gap between guess and owner: ${practice.medianGapPct ?? '–'}%`,
  );

  if (report.screens.length) {
    lines.push('', 'SCREENS (views, median seconds actually working)');
    for (const screen of report.screens)
      lines.push(
        `  ${String(screen.views).padStart(5)}  ${String(screen.medianSeconds).padStart(4)}s  ${screen.screen}`,
      );
  }

  lines.push('', 'WHERE PEOPLE STRUGGLED');
  list('  Error messages shown', struggles.errorsShown);
  list('  Requests that failed', struggles.failedRequests);
  list('  Slow requests (over 4s)', struggles.slowRequests);
  list('  Rage clicks', struggles.rageClicks);
  list('  Clicks on things that do nothing', struggles.deadClicks);
  list('  Page crashes', struggles.pageCrashes);
  if (struggles.networkErrors) lines.push(`  Lost connections: ${struggles.networkErrors}`);

  lines.push(
    '',
    'OWNERS AND THEIR CUSTOMERS',
    `Quotes the owner approved: ${owners.approved}, changed first: ${owners.edited}, median change ${owners.medianChangePct ?? '–'}%`,
    `Median wait for the owner: ${minutes(owners.medianWaitMinutes)}, approved from the email link: ${owners.fromEmailLink}`,
    `Customer requests: ${customers.chats} (website button: ${customers.fromWidget})`,
    `  gave an email: ${customers.gaveContact}, confirmed it: ${customers.verified}, wrong codes: ${customers.codeFailures}`,
  );

  lines.push('', 'AI', `Calls: ${ai.calls}`);
  for (const operation of ai.operations)
    lines.push(
      `  ${operation.operation.padEnd(24)}${String(operation.calls).padStart(5)} calls  ${operation.medianSeconds}s median  ${operation.inputTokens} in / ${operation.outputTokens} out`,
    );
  list('  Failures', ai.failures);

  lines.push('', `VISITS: ${visits.sessions} browser sessions`);
  list('  Devices', visits.devices);
  list('  Landed on', visits.landing);
  return lines.join('\n');
}
