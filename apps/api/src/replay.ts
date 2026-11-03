import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiMode, aiProvider, modelFor, type AiImage } from './ai/index.js';
import { draftGenericQuote } from './ai/quote-engine.js';
import { closeDatabase, rows } from './db.js';
import { json } from './models.js';
import { pooledChat } from './channels/pooled.js';
import { compareDraft, AGREE_PERCENT } from './pricing/accuracy.js';
import { draftForBusiness } from './pricing/draft.js';
import { businessContext, type HistoryOptions } from './pricing/history.js';
import { median } from './pricing/rates.js';
import { describeSpec, specFromScenario, type JobSpec } from './pricing/spec.js';
import {
  quoteTotal,
  type DraftedQuote,
  type PracticeScenario,
  type Quote,
} from './practice/types.js';
import { getPhoto } from './storage.js';

/**
 * Replays quotes owners already priced, with a model of your choice, and reports how close it
 * gets. Each one is drafted from only what the business had taught it before that quote, so it's
 * a fair test. Use it to pick the drafting model. With --generic, each one is also priced by the
 * same model with none of the business's history: the baseline the owner's Charm has to beat.
 * It calls the model once per quote (twice with --generic), so it costs money; with
 * AI_PROVIDER=demo it measures the rate card alone, for free.
 *
 *   npm run replay --workspace @pricecharm/api -- --model gpt-5 --limit 20 [--business <id>] [--generic]
 *
 * It prints quote numbers and percentages only, never customer details.
 */

export type ReplayResult = {
  businessId: string;
  kind: 'live' | 'practice';
  number: number;
  ownerCents: number | null;
  draftCents: number | null;
  gap: number | null;
  agree: boolean;
  /** Whether it would have quoted or asked the owner to see the job first. */
  decision?: DraftedQuote['decision'];
  /** Its lines added up, even when it wanted a visit: its best price either way. */
  linesCents?: number | null;
};

/** A job the owner priced, with what the AI had to go on before they did. */
export type ReplayCase = {
  businessId: string;
  kind: 'live' | 'practice';
  number: number;
  /** What the owner charged, or null when they wanted to see the job first. */
  ownerCents: number | null;
  serviceName: string;
  conversation: { from: 'customer' | 'owner'; text: string }[];
  spec: JobSpec | null;
  images: AiImage[];
  /** Only what the business had taught it before this job. */
  history: HistoryOptions;
};

export function summarize(results: ReplayResult[]) {
  const gaps = results.flatMap((result) => (result.gap === null ? [] : [result.gap]));
  return {
    quotes: results.length,
    priced: gaps.length,
    agreed: results.filter((result) => result.agree).length,
    medianGap: gaps.length ? Math.round(median(gaps)) : null,
  };
}

async function photos(businessId: string, conversationId: string): Promise<AiImage[]> {
  const found = await rows(
    'SELECT storage_key FROM attachments WHERE business_id=? AND conversation_id=? ORDER BY created_at LIMIT 3',
    [businessId, conversationId],
  );
  const images: AiImage[] = [];
  for (const photo of found) {
    try {
      const bytes = await getPhoto(String(photo.storage_key));
      images.push({ mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') });
    } catch {
      // A photo that's gone only means the replay sees less than the original draft did.
    }
  }
  return images;
}

/** Quotes the owner checked before they went to a real customer, newest first. */
export async function liveCases(businessId: string, limit: number): Promise<ReplayCase[]> {
  const quotes = await rows(
    `SELECT q.id,q.number,q.chat_id,q.quote_json,q.created_at,c.service_name,c.spec_json
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND q.sent_by='owner' AND ${pooledChat('c')}
       AND q.status IN ('sent','accepted','visit_requested','lost','expired')
     ORDER BY q.created_at DESC LIMIT ${limit}`,
    [businessId],
  );
  const cases: ReplayCase[] = [];
  for (const quote of quotes) {
    const before = new Date(quote.created_at);
    const messages = await rows(
      "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' AND text<>'' AND created_at<=? ORDER BY created_at,id",
      [quote.chat_id, before],
    );
    cases.push({
      businessId,
      kind: 'live',
      number: Number(quote.number),
      ownerCents: quoteTotal(json<Quote>(quote.quote_json, {} as Quote)),
      serviceName: String(quote.service_name),
      conversation: messages.map((message) => ({
        from: message.sender === 'customer' ? ('customer' as const) : ('owner' as const),
        text: String(message.text),
      })),
      spec: json<JobSpec | null>(quote.spec_json, null),
      images: await photos(businessId, String(quote.chat_id)),
      history: { excludeQuoteId: String(quote.id), before },
    });
  }
  return cases;
}

/** Practice customers the owner answered, latest first. */
export async function practiceCases(businessId: string, limit: number): Promise<ReplayCase[]> {
  const runs = await rows(
    `SELECT id,position,scenario_json,quote_json,outcome,finished_at FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position DESC LIMIT ${limit}`,
    [businessId],
  );
  const cases: ReplayCase[] = [];
  for (const run of runs) {
    const quote = json<Quote | null>(run.quote_json, null);
    if (run.outcome !== 'site_visit' && !quote) continue;
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const messages = await rows(
      "SELECT sender,text FROM practice_messages WHERE run_id=? AND kind='text' ORDER BY created_at,id",
      [run.id],
    );
    cases.push({
      businessId,
      kind: 'practice',
      number: Number(run.position) + 1,
      ownerCents: run.outcome === 'site_visit' || !quote ? null : quoteTotal(quote),
      serviceName: scenario.serviceName,
      conversation: messages.map((message) => ({
        from: message.sender as 'customer' | 'owner',
        text: String(message.text),
      })),
      spec: specFromScenario(scenario),
      images: await photos(businessId, String(run.id)),
      history: {
        excludeRunId: String(run.id),
        before: run.finished_at ? new Date(run.finished_at) : undefined,
      },
    });
  }
  return cases;
}

function scored(job: ReplayCase, drafted: DraftedQuote): ReplayResult {
  const base = {
    businessId: job.businessId,
    kind: job.kind,
    number: job.number,
    ownerCents: job.ownerCents,
    decision: drafted.decision,
    linesCents: drafted.lines.length ? quoteTotal(drafted) : null,
  };
  // A site visit agrees when the AI also wanted one.
  if (job.ownerCents === null)
    return { ...base, draftCents: null, gap: null, agree: drafted.decision === 'site_visit' };
  return { ...base, ...compareDraft(drafted, job.ownerCents) };
}

/** The owner's Charm on this job, as it would have drafted it then. */
export async function replayCharm(job: ReplayCase, model?: string): Promise<ReplayResult> {
  const { drafted } = await draftForBusiness({
    businessId: job.businessId,
    serviceName: job.serviceName,
    conversation: job.conversation,
    spec: job.spec,
    images: job.images,
    history: job.history,
    model,
  });
  return scored(job, drafted);
}

/**
 * The same model with none of the business's history. A job the owner wanted to see first has no
 * price to compare it with, so it's skipped. Needs a live model.
 */
export async function replayGeneric(job: ReplayCase, model?: string): Promise<ReplayResult | null> {
  if (job.ownerCents === null) return null;
  const business = await businessContext(job.businessId);
  const drafted = await draftGenericQuote({
    business: {
      trade: business.trade,
      services: business.services,
      area: business.area,
      currency: business.currency,
    },
    request: {
      serviceName: job.serviceName,
      conversation: job.conversation,
      details: describeSpec(job.spec) || undefined,
    },
    images: job.images,
    model,
  });
  return scored(job, drafted);
}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function line(label: string, results: ReplayResult[]) {
  const summary = summarize(results);
  return `${label}: ${summary.agreed} of ${summary.quotes} within ${AGREE_PERCENT}% (${summary.priced} priced), median gap ${summary.medianGap ?? '-'}%`;
}

async function main() {
  const model = option('model');
  const limit = Math.min(Math.max(Number(option('limit') ?? 20) || 20, 1), 200);
  const only = option('business');
  const generic = process.argv.includes('--generic') && aiMode !== 'demo';
  if (process.argv.includes('--generic') && !generic)
    console.info('The generic baseline needs a live model, so it’s skipped with AI_PROVIDER=demo.');
  const businesses = only
    ? [{ id: only }]
    : await rows(
        "SELECT id FROM businesses WHERE status='active' AND deletion_requested_at IS NULL ORDER BY created_at",
      );
  const engine =
    aiMode === 'demo'
      ? 'the rate card alone (AI_PROVIDER=demo)'
      : `${aiProvider} ${model ?? modelFor('draft_quote')}`;
  console.info(`Replaying up to ${limit} quotes per business with ${engine}.`);
  const charm: ReplayResult[] = [];
  const baseline: ReplayResult[] = [];
  for (const business of businesses) {
    const id = String(business.id);
    const jobs = [...(await liveCases(id, limit)), ...(await practiceCases(id, limit))];
    if (!jobs.length) continue;
    const results: ReplayResult[] = [];
    const generics: ReplayResult[] = [];
    for (const job of jobs) {
      const [own, other] = await Promise.all([
        replayCharm(job, model),
        generic ? replayGeneric(job, model) : null,
      ]);
      results.push(own);
      if (other) generics.push(other);
      console.info(
        `  ${own.kind} #${own.number}: ${own.gap === null ? (own.agree ? 'agreed on a site visit' : 'no comparable price') : `${own.gap}% apart`}${other ? `, generic ${other.gap === null ? 'no price' : `${other.gap}% apart`}` : ''}`,
      );
    }
    charm.push(...results);
    baseline.push(...generics);
    console.info(line(id, results));
    if (generic) console.info(line(`${id} generic`, generics));
  }
  console.info(line('All', charm));
  if (generic) console.info(line('All, generic', baseline));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error('Replay failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
