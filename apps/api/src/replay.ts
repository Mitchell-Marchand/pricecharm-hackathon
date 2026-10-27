import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiMode, aiProvider, modelFor, type AiImage } from './ai/index.js';
import { closeDatabase, rows } from './db.js';
import { json } from './models.js';
import { compareDraft, AGREE_PERCENT } from './pricing/accuracy.js';
import { draftForBusiness } from './pricing/draft.js';
import { median } from './pricing/rates.js';
import { specFromScenario, type JobSpec } from './pricing/spec.js';
import { quoteTotal, type PracticeScenario, type Quote } from './practice/types.js';
import { getPhoto } from './storage.js';

/**
 * Replays quotes owners already priced, with a model of your choice, and reports how close it
 * gets. Each one is drafted from only what the business had taught it before that quote, so it's
 * a fair test. Use it to pick the drafting model. It calls the model once per quote, so it costs
 * money; with AI_PROVIDER=demo it measures the rate card alone, for free.
 *
 *   npm run replay --workspace @quotefolk/api -- --model gpt-5 --limit 20 [--business <id>]
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

async function replayLive(businessId: string, model: string | undefined, limit: number) {
  const quotes = await rows(
    `SELECT q.id,q.number,q.chat_id,q.quote_json,q.created_at,c.service_name,c.spec_json
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND q.sent_by='owner' AND c.source<>'test'
       AND q.status IN ('sent','accepted','visit_requested','lost','expired')
     ORDER BY q.created_at DESC LIMIT ${limit}`,
    [businessId],
  );
  const results: ReplayResult[] = [];
  for (const quote of quotes) {
    const before = new Date(quote.created_at);
    const messages = await rows(
      "SELECT sender,text FROM lead_messages WHERE chat_id=? AND kind='text' AND text<>'' AND created_at<=? ORDER BY created_at,id",
      [quote.chat_id, before],
    );
    const { drafted } = await draftForBusiness({
      businessId,
      serviceName: String(quote.service_name),
      conversation: messages.map((message) => ({
        from: message.sender === 'customer' ? ('customer' as const) : ('owner' as const),
        text: String(message.text),
      })),
      spec: json<JobSpec | null>(quote.spec_json, null),
      images: await photos(businessId, String(quote.chat_id)),
      history: { excludeQuoteId: String(quote.id), before },
      model,
    });
    const ownerCents = quoteTotal(json<Quote>(quote.quote_json, {} as Quote));
    results.push({
      businessId,
      kind: 'live',
      number: Number(quote.number),
      ownerCents,
      ...compareDraft(drafted, ownerCents),
    });
  }
  return results;
}

async function replayPractice(businessId: string, model: string | undefined, limit: number) {
  const runs = await rows(
    `SELECT id,position,scenario_json,quote_json,outcome,finished_at FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position DESC LIMIT ${limit}`,
    [businessId],
  );
  const results: ReplayResult[] = [];
  for (const run of runs) {
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const messages = await rows(
      "SELECT sender,text FROM practice_messages WHERE run_id=? AND kind='text' ORDER BY created_at,id",
      [run.id],
    );
    const { drafted } = await draftForBusiness({
      businessId,
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
      model,
    });
    const quote = json<Quote | null>(run.quote_json, null);
    // A site visit agrees when the AI also wanted one.
    if (run.outcome === 'site_visit')
      results.push({
        businessId,
        kind: 'practice',
        number: Number(run.position) + 1,
        ownerCents: null,
        draftCents: null,
        gap: null,
        agree: drafted.decision === 'site_visit',
      });
    else if (quote) {
      const ownerCents = quoteTotal(quote);
      results.push({
        businessId,
        kind: 'practice',
        number: Number(run.position) + 1,
        ownerCents,
        ...compareDraft(drafted, ownerCents),
      });
    }
  }
  return results;
}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const model = option('model');
  const limit = Math.min(Math.max(Number(option('limit') ?? 20) || 20, 1), 200);
  const only = option('business');
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
  const all: ReplayResult[] = [];
  for (const business of businesses) {
    const id = String(business.id);
    const results = [
      ...(await replayLive(id, model, limit)),
      ...(await replayPractice(id, model, limit)),
    ];
    if (!results.length) continue;
    all.push(...results);
    const summary = summarize(results);
    console.info(
      `${id}: ${summary.agreed} of ${summary.quotes} within ${AGREE_PERCENT}%, median gap ${summary.medianGap ?? '-'}%`,
    );
    for (const result of results)
      console.info(
        `  ${result.kind} #${result.number}: ${result.gap === null ? (result.agree ? 'agreed on a site visit' : 'no comparable price') : `${result.gap}% apart`}`,
      );
  }
  const overall = summarize(all);
  console.info(
    `All: ${overall.agreed} of ${overall.quotes} within ${AGREE_PERCENT}% (${overall.priced} priced), median gap ${overall.medianGap ?? '-'}%`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error('Replay failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
