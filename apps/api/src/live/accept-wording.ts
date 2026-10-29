import { rows, type Sql } from '../db.js';
import type { Row } from '../models.js';

/**
 * The words PriceCharm tries on a quote's accept button when the owner hasn't chosen their own.
 * They say yes to the price without sounding like signing anything: the tap only asks where the
 * owner can reach them, and it's that answer which accepts the quote, bills it on the
 * accepted-quote plan and tells the Charm the price won. Each still has to mean yes. A question
 * like "Can we finalize this?" would catch people who meant to ask something, so it isn't one.
 * "Accept quote" and "Book it" were tried until 2026-10-29 and read as a commitment.
 */
export const ACCEPT_WORDINGS = [
  { id: 'looks_good', label: 'Looks good to me' },
  { id: 'works', label: 'Works for me' },
  { id: 'do_it', label: 'Let’s do it' },
] as const;
export type Wording = (typeof ACCEPT_WORDINGS)[number];
/** What quotes from before the test show. */
export const DEFAULT_ACCEPT_LABEL = ACCEPT_WORDINGS[0].label;

/** How long after seeing a quote a yes counts for the test. */
export const ANSWER_DAYS = 14;
/** The share of quotes that get any wording at random, so each one keeps being tried. */
const EXPLORE = 0.4;

export type WordingStats = { id: string; seen: number; accepted: number };

/** A standard normal draw. */
function normal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** A Gamma(shape, 1) draw for shape >= 1 (Marsaglia and Tsang). */
function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3,
    c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
      return d * v;
  }
}

/** A draw of how often customers say yes to a wording, given what they've done so far. */
function yesRate(stats: WordingStats | undefined, random: () => number): number {
  const yes = gamma(1 + (stats?.accepted ?? 0), random);
  return yes / (yes + gamma(1 + (stats?.seen ?? 0) - (stats?.accepted ?? 0), random));
}

/**
 * The wording for the next quote. Mostly the one that comes out best when each wording's yes rate
 * is drawn from what customers did with it (Thompson sampling), which starts out even and leans
 * towards what works as answers come in. Some quotes get any wording at all.
 */
export function pickWording(stats: WordingStats[], random: () => number = Math.random): Wording {
  if (random() < EXPLORE) {
    const any = Math.floor(random() * ACCEPT_WORDINGS.length);
    return ACCEPT_WORDINGS[Math.min(ACCEPT_WORDINGS.length - 1, any)];
  }
  let best: Wording = ACCEPT_WORDINGS[0],
    top = -1;
  for (const wording of ACCEPT_WORDINGS) {
    const draw = yesRate(
      stats.find((item) => item.id === wording.id),
      random,
    );
    if (draw > top) [best, top] = [wording, draw];
  }
  return best;
}

/**
 * For each wording: quotes customers saw that they've answered, or had two weeks to, and how
 * many of those they accepted within the two weeks. Owners' tests are never seen, so they and
 * the owners' own wordings don't count.
 */
export async function wordingStats(connection?: Sql): Promise<WordingStats[]> {
  const found = await rows(
    `SELECT accept_variant AS id,COUNT(*) AS seen,
       COALESCE(SUM(status='accepted' AND decided_at<=DATE_ADD(seen_at,INTERVAL ${ANSWER_DAYS} DAY)),0) AS accepted
     FROM live_quotes
     WHERE seen_at IS NOT NULL AND accept_variant IN (${ACCEPT_WORDINGS.map(() => '?').join(',')})
       AND (decided_at IS NOT NULL OR seen_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ${ANSWER_DAYS} DAY))
     GROUP BY accept_variant`,
    ACCEPT_WORDINGS.map((wording) => wording.id),
    connection,
  );
  return found.map((row) => ({
    id: String(row.id),
    seen: Number(row.seen),
    accepted: Number(row.accepted),
  }));
}

/** The words a quote's accept button shows: the owner's own, or one PriceCharm is trying. */
export async function chooseAcceptLabel(
  business: Row,
  connection?: Sql,
): Promise<{ label: string; variant: string }> {
  const own = String(business.accept_label ?? '').trim();
  if (own) return { label: own, variant: 'owner' };
  const wording = pickWording(await wordingStats(connection));
  return { label: wording.label, variant: wording.id };
}

/** How often each wording comes out best when every yes rate is drawn many times. */
export function chanceBest(stats: WordingStats[], draws = 4000, random = Math.random) {
  const wins = new Map<string, number>(ACCEPT_WORDINGS.map((wording) => [wording.id, 0]));
  for (let i = 0; i < draws; i++) {
    let best = '',
      top = -1;
    for (const wording of ACCEPT_WORDINGS) {
      const draw = yesRate(
        stats.find((item) => item.id === wording.id),
        random,
      );
      if (draw > top) [best, top] = [wording.id, draw];
    }
    wins.set(best, (wins.get(best) ?? 0) + 1);
  }
  return new Map([...wins].map(([id, count]) => [id, count / draws]));
}

/**
 * The accept button for the metrics report: each wording's results and its share of recent
 * quotes, and the wordings owners chose themselves.
 */
export async function wordingReport(since: Date, until: Date) {
  const stats = await wordingStats();
  const best = chanceBest(stats);
  const recent = await rows(
    `SELECT accept_variant AS id,COUNT(*) AS count FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE c.source<>'test' AND q.accept_variant IS NOT NULL AND q.sent_at>=? AND q.sent_at<? GROUP BY q.accept_variant`,
    [since, until],
  );
  const sent = recent.reduce((sum, row) => sum + Number(row.count), 0);
  const owners = await rows(
    `SELECT b.accept_label AS label,COUNT(DISTINCT b.id) AS businesses,
       COUNT(q.seen_at) AS seen,COALESCE(SUM(q.status='accepted' AND q.seen_at IS NOT NULL),0) AS accepted
     FROM businesses b LEFT JOIN live_quotes q ON q.business_id=b.id AND q.accept_variant='owner' AND q.accept_label=b.accept_label
     WHERE b.accept_label<>'' AND b.status='active' GROUP BY b.accept_label ORDER BY businesses DESC LIMIT 10`,
  );
  return {
    wordings: ACCEPT_WORDINGS.map((wording) => {
      const found = stats.find((item) => item.id === wording.id);
      const count = Number(recent.find((row) => row.id === wording.id)?.count ?? 0);
      return {
        label: wording.label,
        seen: found?.seen ?? 0,
        accepted: found?.accepted ?? 0,
        chanceBest: best.get(wording.id) ?? 0,
        share: sent ? count / sent : 0,
      };
    }),
    /** Quotes in the span that showed an owner's own wording. */
    ownWordingShare: sent ? Number(recent.find((row) => row.id === 'owner')?.count ?? 0) / sent : 0,
    owners: owners.map((row) => ({
      label: String(row.label),
      businesses: Number(row.businesses),
      seen: Number(row.seen),
      accepted: Number(row.accepted),
    })),
  };
}
