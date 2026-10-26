import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { tradeName } from '@quotefolk/trades';
import { aiMode, type AiImage } from '../ai/index.js';
import { describeRate, replyAsPracticeCustomer, writePracticeScenario } from '../ai/practice.js';
import { generatePracticePhoto } from '../ai/practice-images.js';
import { draftQuote, type PricingHistory } from '../ai/quote-engine.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { json, type Row } from '../models.js';
import { listPastJobs, photoUrl } from '../past-jobs.js';
import { getPhoto, putPhoto } from '../storage.js';
import { withAiUsage } from '../usage.js';
import { demoDraftQuote, demoPhoto, demoRateLine, demoReply, demoScenario } from './demo.js';
import {
  gapPercent,
  quoteDraftSchema,
  quoteTotal,
  type DraftedQuote,
  type Insight,
  type PracticeScenario,
  type Quote,
  type QuoteDraft,
  type Shadow,
} from './types.js';

/** Practice quotes to finish before the AI counts as trained. More can follow later. */
export const PRACTICE_COUNT = 3;
const MAX_MESSAGES = 40;
const TONES = ['canary', 'pink', 'blue'] as const;
/** Each practice customer covers a different kind of job, so the AI sees the range. */
const SITUATIONS = [
  'A typical, clear job for one of their main services, sized like their usual past jobs. Nothing unusual.',
  'A bigger job that combines two of their services or adds an extra, where the customer also asks about a discount, for example because a neighbor wants the same work.',
  'A trickier job: the photos and messages show something that could change the price a lot, like damage, hard access or unclear scope, so a careful owner might want to see it before pricing.',
  'A small job at the low end of what they do, from a customer in a hurry.',
  'A job near the edge of their service area, for a customer who wants it done soon.',
];

const centsFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const money = (cents: number) => centsFormat.format(cents / 100);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const joinList = (items: string[]) =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

async function businessContext(businessId: string, connection?: Sql) {
  const [business] = await rows(
    'SELECT name,trade_id,custom_trade,service_area,travel_radius_miles FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  if (!business) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This business is unavailable.');
  const services = (
    await rows(
      'SELECT name FROM offerings WHERE business_id=? ORDER BY position',
      [businessId],
      connection,
    )
  ).map((row) => String(row.name));
  return {
    name: String(business.name || ''),
    trade: tradeName(business.trade_id, business.custom_trade),
    services,
    area: String(business.service_area || ''),
    radiusMiles: business.travel_radius_miles ? Number(business.travel_radius_miles) : null,
  };
}

export async function ensurePracticeRuns(businessId: string, count = PRACTICE_COUNT) {
  for (let position = 0; position < count; position++)
    await mutate('INSERT IGNORE INTO practice_runs (id,business_id,position) VALUES (?,?,?)', [
      randomUUID(),
      businessId,
      position,
    ]);
}

/** Starts preparing customers that are waiting, earliest first, outside the request. */
export async function kickPreparation(businessId: string) {
  const due = await rows(
    "SELECT id FROM practice_runs WHERE business_id=? AND status='preparing' AND (prepare_until IS NULL OR prepare_until<UTC_TIMESTAMP(3)) ORDER BY position LIMIT 2",
    [businessId],
  );
  for (const run of due)
    void preparePracticeRun(String(run.id)).catch((error) =>
      reportError(error, { event: 'practice_prepare' }),
    );
}

async function writeScenario(businessId: string, position: number): Promise<PracticeScenario> {
  const context = await businessContext(businessId);
  if (aiMode === 'demo') return demoScenario(position, context.services);
  const jobs = (await listPastJobs(businessId)).map((job) => ({
    service: job.serviceName,
    description: job.description,
    size: job.size,
  }));
  const earlier = (
    await rows(
      'SELECT scenario_json FROM practice_runs WHERE business_id=? AND position<>? AND scenario_json IS NOT NULL',
      [businessId, position],
    )
  ).map((row) => {
    const scenario = json<PracticeScenario>(row.scenario_json, {} as PracticeScenario);
    return { name: scenario.firstName, service: scenario.serviceName };
  });
  return withAiUsage(businessId, `practice:${position}`, () =>
    writePracticeScenario({
      trade: context.trade,
      businessName: context.name,
      services: context.services,
      area: context.area,
      radiusMiles: context.radiusMiles,
      jobs,
      situation: SITUATIONS[position % SITUATIONS.length],
      earlier,
    }),
  );
}

async function createPracticePhoto(
  businessId: string,
  runId: string,
  scenario: PracticeScenario,
  scene: string,
): Promise<string> {
  const bytes =
    aiMode === 'demo'
      ? await demoPhoto(scene)
      : (
          await withAiUsage(businessId, `practice-photo:${runId}`, () =>
            generatePracticePhoto(businessId, {
              title: `${scenario.serviceName} photo`,
              description: scene,
            }),
          )
        ).bytes;
  const metadata = await sharp(bytes).metadata();
  const id = randomUUID(),
    key = `${id}.jpg`;
  await putPhoto(key, bytes);
  await mutate(
    'INSERT INTO attachments (id,business_id,conversation_id,purpose,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      businessId,
      runId,
      'practice',
      'practice-photo.jpg',
      'image/jpeg',
      key,
      metadata.width ?? 0,
      metadata.height ?? 0,
      bytes.length,
    ],
  );
  return id;
}

/**
 * Writes the customer and their photos. Safe to call from anywhere: a lease keeps two requests
 * from preparing the same customer, and a stale lease is picked up again.
 */
export async function preparePracticeRun(runId: string): Promise<void> {
  const token = randomUUID();
  const claimed = await mutate(
    "UPDATE practice_runs SET prepare_token=?,prepare_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 180 SECOND),prepare_attempts=prepare_attempts+1 WHERE id=? AND status='preparing' AND (prepare_until IS NULL OR prepare_until<UTC_TIMESTAMP(3))",
    [token, runId],
  );
  if (!claimed.affectedRows) return;
  const [run] = await rows('SELECT * FROM practice_runs WHERE id=?', [runId]);
  const businessId = String(run.business_id);
  try {
    let scenario = json<PracticeScenario | null>(run.scenario_json, null);
    if (!scenario) {
      scenario = await writeScenario(businessId, Number(run.position));
      await mutate('UPDATE practice_runs SET scenario_json=? WHERE id=? AND prepare_token=?', [
        JSON.stringify(scenario),
        runId,
        token,
      ]);
    }
    const ready = scenario;
    const missing = [...ready.photos, ready.extraPhoto].filter((photo) => !photo.photoId);
    // A photo that fails leaves the request with fewer photos rather than no customer.
    await Promise.all(
      missing.map(async (photo) => {
        try {
          photo.photoId = await createPracticePhoto(businessId, runId, ready, photo.scene);
        } catch (error) {
          reportError(error, { event: 'practice_photo' });
        }
      }),
    );
    await transaction(async (connection) => {
      const [current] = await rows(
        'SELECT status,prepare_token FROM practice_runs WHERE id=? FOR UPDATE',
        [runId],
        connection,
      );
      if (current?.status !== 'preparing' || current.prepare_token !== token) return;
      await mutate(
        "UPDATE practice_runs SET scenario_json=?,status='ready',prepare_token=NULL,prepare_until=NULL,failure=NULL WHERE id=?",
        [JSON.stringify(ready), runId],
        connection,
      );
      await addMessage(connection, businessId, runId, 'customer', 'text', ready.opener, [
        ...ready.photos.flatMap((photo) => (photo.photoId ? [photo.photoId] : [])),
      ]);
    });
  } catch (error) {
    reportError(error, { event: 'practice_prepare' });
    const failure =
      error instanceof ApiError
        ? error.message
        : 'We couldn’t write this practice customer. Please try again.';
    await mutate(
      "UPDATE practice_runs SET status='failed',failure=?,prepare_token=NULL,prepare_until=NULL WHERE id=? AND prepare_token=?",
      [failure.slice(0, 300), runId, token],
    );
  }
}

async function addMessage(
  connection: Sql | undefined,
  businessId: string,
  runId: string,
  sender: 'customer' | 'owner',
  kind: 'text' | 'quote' | 'site_visit',
  text: string,
  photoIds: string[] = [],
) {
  const id = randomUUID();
  await mutate(
    'INSERT INTO practice_messages (id,business_id,run_id,sender,kind,text,photo_ids_json,created_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [id, businessId, runId, sender, kind, text, JSON.stringify(photoIds)],
    connection,
  );
  return id;
}

function customerOf(scenario: PracticeScenario, position: number) {
  return {
    name: `${scenario.firstName} ${scenario.lastInitial}.`,
    firstName: scenario.firstName,
    initials: `${scenario.firstName[0] ?? ''}${scenario.lastInitial}`.toUpperCase(),
    place: scenario.place,
    tone: TONES[position % TONES.length],
  };
}

function runView(run: Row, messages: Row[]) {
  const scenario = json<PracticeScenario | null>(run.scenario_json, null);
  const position = Number(run.position);
  const quote = json<Quote | null>(run.quote_json, null);
  const shadow = run.outcome ? json<Shadow | null>(run.shadow_json, null) : null;
  return {
    id: String(run.id),
    position,
    status: run.status as 'preparing' | 'ready' | 'failed' | 'finished',
    failure: run.status === 'failed' ? String(run.failure || '') : null,
    customer: scenario ? customerOf(scenario, position) : null,
    serviceName: scenario?.serviceName ?? null,
    suggestions: scenario?.suggestions ?? [],
    messages:
      run.status === 'preparing'
        ? []
        : messages.map((message) => ({
            id: String(message.id),
            from: message.sender as 'customer' | 'owner',
            text: message.kind === 'text' ? String(message.text) : '',
            photos: json<string[]>(message.photo_ids_json, []).map((id) => ({
              id,
              url: photoUrl(id),
            })),
            quote: message.kind === 'quote' ? quote : null,
            siteVisit: message.kind === 'site_visit' ? String(message.text) : null,
          })),
    outcome: run.outcome === 'site_visit' ? ('site-visit' as const) : (run.outcome ?? null),
    quote,
    siteVisitReason: run.site_visit_reason ?? null,
    shadow: shadow
      ? {
          cents: shadow.cents,
          siteVisit: shadow.decision === 'site_visit',
          reason: shadow.reason,
          confidence: shadow.confidence,
        }
      : null,
    insights: json<(Insight & { edited?: boolean })[]>(run.insights_json, []).map(
      ({ id, text }) => ({ id, text }),
    ),
    finished: run.status === 'finished',
  };
}
export type RunView = ReturnType<typeof runView>;

export type PracticeResult = {
  runId: string;
  customer: string;
  guessCents: number | null;
  ownerCents: number | null;
  gap: number | null;
  agree: boolean;
  siteVisit: boolean;
  aiFlagged: boolean;
};

/** How close the AI's private guesses were to the owner's real answers. */
export function practiceResults(views: RunView[]): PracticeResult[] {
  return views
    .filter((run) => run.finished)
    .map((run) => {
      const guessCents = run.shadow?.cents || null;
      const aiFlagged = Boolean(run.shadow?.siteVisit);
      if (run.outcome === 'site-visit')
        return {
          runId: run.id,
          customer: run.customer?.name ?? '',
          guessCents,
          ownerCents: null,
          gap: null,
          agree: aiFlagged,
          siteVisit: true,
          aiFlagged,
        };
      const ownerCents = run.quote ? quoteTotal(run.quote) : 0;
      const gap = guessCents ? gapPercent(guessCents, ownerCents) : null;
      return {
        runId: run.id,
        customer: run.customer?.name ?? '',
        guessCents,
        ownerCents,
        gap,
        agree: gap !== null && gap <= 15,
        siteVisit: false,
        aiFlagged,
      };
    });
}

/** Quotes go out on their own once the AI's last two guesses agreed with the owner. */
export function autoSendReady(results: PracticeResult[]): boolean {
  const lastTwo = results.slice(-2);
  return lastTwo.length === 2 && lastTwo.every((result) => result.agree);
}

export async function practiceState(businessId: string) {
  const runs = await rows('SELECT * FROM practice_runs WHERE business_id=? ORDER BY position', [
    businessId,
  ]);
  const messages = await rows(
    'SELECT * FROM practice_messages WHERE business_id=? ORDER BY created_at,id',
    [businessId],
  );
  const views = runs.map((run) =>
    runView(
      run,
      messages.filter((message) => message.run_id === run.id),
    ),
  );
  const firstOpen = views.findIndex((run) => !run.finished);
  const results = practiceResults(views);
  return {
    count: PRACTICE_COUNT,
    runs: views,
    current: firstOpen === -1 ? Math.max(0, views.length - 1) : firstOpen,
    finished: views.filter((run) => run.finished).length,
    results,
    autoSendReady: autoSendReady(results),
  };
}

async function loadRun(businessId: string, runId: string, connection?: Sql, lock = false) {
  const [run] = await rows(
    `SELECT * FROM practice_runs WHERE id=? AND business_id=?${lock ? ' FOR UPDATE' : ''}`,
    [runId, businessId],
    connection,
  );
  if (!run) throw new ApiError(404, 'PRACTICE_NOT_FOUND', 'This practice customer isn’t here.');
  return run;
}

async function runMessages(runId: string, connection?: Sql) {
  return rows(
    'SELECT * FROM practice_messages WHERE run_id=? ORDER BY created_at,id',
    [runId],
    connection,
  );
}

function openRun(run: Row) {
  if (run.status !== 'ready' || run.outcome)
    throw new ApiError(409, 'PRACTICE_CLOSED', 'This practice request is already done.');
}

async function viewOf(businessId: string, runId: string) {
  const run = await loadRun(businessId, runId);
  return runView(run, await runMessages(runId));
}

export async function sendOwnerMessage(businessId: string, runId: string, text: string) {
  const run = await loadRun(businessId, runId);
  openRun(run);
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const before = await runMessages(runId);
  if (before.length >= MAX_MESSAGES)
    throw new ApiError(
      422,
      'PRACTICE_LONG',
      'That’s a long conversation. Send a quote, or ask to see the job first.',
    );
  const ownerId = await addMessage(undefined, businessId, runId, 'owner', 'text', text);
  const turn = before.filter((message) => message.sender === 'owner').length;
  const photoAvailable = Boolean(scenario.extraPhoto.photoId) && !run.photo_sent;
  const businessName = await businessContextName(businessId);
  let reply;
  try {
    reply =
      aiMode === 'demo'
        ? demoReply(scenario, text, { photoSent: !photoAvailable, turn })
        : await withAiUsage(businessId, `practice:${runId}`, () =>
            replyAsPracticeCustomer({
              businessName,
              scenario,
              messages: before.map((message) => ({
                from: message.sender as 'customer' | 'owner',
                text: message.kind === 'text' ? String(message.text) : '[quote]',
              })),
              ownerMessage: text,
              photoAvailable,
            }),
          );
  } catch (error) {
    // Take the message back, so the owner can send it again cleanly.
    await mutate('DELETE FROM practice_messages WHERE id=?', [ownerId]);
    throw error;
  }
  const sendPhoto = reply.sendPhoto && photoAvailable;
  const asked = [...new Set([...json<string[]>(run.asked_json, []), ...reply.askedKeys])];
  await transaction(async (connection) => {
    await addMessage(
      connection,
      businessId,
      runId,
      'customer',
      'text',
      reply.reply,
      sendPhoto && scenario.extraPhoto.photoId ? [scenario.extraPhoto.photoId] : [],
    );
    await mutate(
      'UPDATE practice_runs SET asked_json=?,photo_sent=photo_sent OR ? WHERE id=?',
      [JSON.stringify(asked), sendPhoto, runId],
      connection,
    );
  });
  return { run: await viewOf(businessId, runId), nudge: reply.mentionsPrice };
}

async function businessContextName(businessId: string) {
  const [business] = await rows('SELECT name FROM businesses WHERE id=?', [businessId]);
  return String(business?.name ?? '');
}

/** Everything the business has taught the AI so far, leaving out one practice run if asked. */
export async function pricingHistory(
  businessId: string,
  excludeRunId?: string,
): Promise<PricingHistory> {
  const context = await businessContext(businessId);
  const jobs = await listPastJobs(businessId);
  const runs = await rows(
    "SELECT * FROM practice_runs WHERE business_id=? AND status='finished' ORDER BY position",
    [businessId],
  );
  const notes: string[] = [];
  const practice = [];
  for (const run of runs) {
    if (run.id === excludeRunId) continue;
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const quote = json<Quote | null>(run.quote_json, null);
    const conversation = (await runMessages(String(run.id)))
      .filter((message) => message.kind === 'text')
      .map((message) => `${message.sender === 'owner' ? 'Owner' : 'Customer'}: ${message.text}`)
      .join('\n')
      .slice(0, 1500);
    practice.push({
      service: scenario.serviceName,
      request: conversation,
      outcome: run.outcome === 'site_visit' ? ('site_visit' as const) : ('quote' as const),
      lines: quote?.lines.map(({ label, amountCents }) => ({ label, amountCents })) ?? [],
      discount: quote?.discount ?? null,
      start: quote?.start ?? '',
      duration: quote?.duration ?? '',
      note: quote?.note ?? '',
      siteVisitReason: String(run.site_visit_reason ?? ''),
    });
    for (const insight of json<(Insight & { edited?: boolean })[]>(run.insights_json, []))
      if (insight.edited) notes.push(insight.text);
  }
  return {
    business: {
      name: context.name,
      trade: context.trade,
      services: context.services,
      area: context.area,
      radiusMiles: context.radiusMiles,
    },
    pastJobs: jobs.map((job) => ({
      service: job.serviceName,
      description: job.description,
      priceCents: job.priceCents,
      size: job.size,
      duration: job.duration,
      when: job.when,
      materialsCents: job.materialsCents,
      discount: job.discount,
      notes: job.notes,
    })),
    practice,
    notes,
  };
}

async function runImages(businessId: string, runId: string, messages: Row[]): Promise<AiImage[]> {
  const ids = messages
    .filter((message) => message.sender === 'customer')
    .flatMap((message) => json<string[]>(message.photo_ids_json, []))
    .slice(0, 3);
  const images: AiImage[] = [];
  for (const id of ids) {
    const [photo] = await rows('SELECT storage_key FROM attachments WHERE id=? AND business_id=?', [
      id,
      businessId,
    ]);
    if (photo)
      images.push({
        mimeType: 'image/jpeg',
        dataBase64: (await getPhoto(String(photo.storage_key))).toString('base64'),
      });
  }
  return images;
}

/**
 * The AI's private guess for this request, made from everything except the owner's answer to it.
 * It's computed before the owner's quote is saved, and kept once made.
 */
export async function computeShadow(businessId: string, runId: string): Promise<Shadow> {
  const run = await loadRun(businessId, runId);
  const existing = json<Shadow | null>(run.shadow_json, null);
  if (existing) return existing;
  if (run.outcome)
    throw new ApiError(409, 'PRACTICE_CLOSED', 'This practice request is already done.');
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const messages = (await runMessages(runId)).filter((message) => message.kind === 'text');
  let drafted: DraftedQuote;
  if (aiMode === 'demo') {
    const prior = await rows(
      "SELECT scenario_json,quote_json FROM practice_runs WHERE business_id=? AND status='finished' AND id<>? ORDER BY position",
      [businessId, runId],
    );
    drafted = demoDraftQuote({
      scenario,
      jobs: await listPastJobs(businessId),
      prior: prior.flatMap((row) => {
        const quote = json<Quote | null>(row.quote_json, null);
        return quote
          ? [
              {
                scenario: json<PracticeScenario>(row.scenario_json, scenario),
                lines: quote.lines,
                discount: quote.discount,
              },
            ]
          : [];
      }),
    });
  } else {
    const history = await pricingHistory(businessId, runId);
    const images = await runImages(businessId, runId, messages);
    drafted = await withAiUsage(businessId, `practice:${runId}`, () =>
      draftQuote({
        history,
        request: {
          serviceName: scenario.serviceName,
          conversation: messages.map((message) => ({
            from: message.sender as 'customer' | 'owner',
            text: String(message.text),
          })),
        },
        images,
      }),
    );
  }
  const shadow: Shadow = { ...drafted, cents: quoteTotal(drafted) };
  await mutate('UPDATE practice_runs SET shadow_json=? WHERE id=? AND shadow_json IS NULL', [
    JSON.stringify(shadow),
    runId,
  ]);
  const [saved] = await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [runId]);
  return json<Shadow>(saved.shadow_json, shadow);
}

async function insightsFor(
  runId: string,
  scenario: PracticeScenario,
  asked: string[],
  outcome: { quote: QuoteDraft } | { siteVisit: string },
  trade: string,
): Promise<Insight[]> {
  const labels = [
    ...new Set(
      asked.flatMap((key) => {
        const fact = scenario.facts.find((item) => item.key === key);
        return fact ? [fact.label] : [];
      }),
    ),
  ];
  const items: string[] = [];
  if (labels.length) items.push(`Asks about ${joinList(labels)}`);
  if ('quote' in outcome) {
    const quote = outcome.quote;
    if (!labels.length) items.push('Quotes straight from the photos when a job looks clear');
    const main = quote.lines[0];
    let rate = '';
    try {
      rate =
        aiMode === 'demo'
          ? demoRateLine(scenario, main.amountCents)
          : await describeRate({
              trade,
              serviceName: scenario.serviceName,
              mainLine: { label: main.label, amountCents: main.amountCents },
              sizeAnswer: scenario.facts.find((fact) => fact.key === 'size')?.answer ?? '',
            });
    } catch (error) {
      reportError(error, { event: 'practice_rate' });
    }
    items.push(rate || `Prices ${lowerFirst(main.label)} at ${money(main.amountCents)}`);
    for (const line of quote.lines.slice(1))
      items.push(`Adds ${lowerFirst(line.label)} for ${money(line.amountCents)}`);
    if (quote.discount) {
      const reason = quote.discount.reason.trim()
        ? ` (${lowerFirst(quote.discount.reason.trim())})`
        : '';
      items.push(
        quote.discount.kind === 'percent'
          ? `Gives ${quote.discount.value}% off${reason}`
          : `Takes ${money(quote.discount.value)} off${reason}`,
      );
    }
    if (quote.start) {
      const onSite = quote.duration.trim()
        ? `, about ${quote.duration.trim().replace(/^about\s+/i, '')} on site`
        : '';
      items.push(`Can usually start ${lowerFirst(quote.start)}${onSite}`);
    }
    if (quote.note.trim()) items.push(`Remembers why: “${quote.note.trim()}”`);
  } else {
    items.push(`Asks to see jobs like this first: “${outcome.siteVisit}”`);
    items.push(
      scenario.siteVisitCue
        ? `Won’t send a price for ${scenario.siteVisitCue} until you’ve looked`
        : 'Sends jobs like this to you instead of quoting',
    );
  }
  return items.map((text, index) => ({ id: `${runId.slice(0, 8)}-${index}`, text }));
}

async function finishRun(
  businessId: string,
  runId: string,
  outcome: { quote: QuoteDraft } | { siteVisit: string },
) {
  await computeShadow(businessId, runId);
  const context = await businessContext(businessId);
  const scenario = await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    openRun(run);
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    if ('quote' in outcome) {
      const [business] = await rows(
        'SELECT next_quote_number FROM businesses WHERE id=? FOR UPDATE',
        [businessId],
        connection,
      );
      const number = Number(business.next_quote_number);
      await mutate(
        'UPDATE businesses SET next_quote_number=? WHERE id=?',
        [number + 1, businessId],
        connection,
      );
      const quote: Quote = {
        ...outcome.quote,
        number,
        customer: `${scenario.firstName} ${scenario.lastInitial}.`,
        place: scenario.place,
        issuedAt: new Date().toISOString(),
      };
      await mutate(
        "UPDATE practice_runs SET outcome='quote',quote_json=? WHERE id=?",
        [JSON.stringify(quote), runId],
        connection,
      );
      await addMessage(connection, businessId, runId, 'owner', 'quote', '');
    } else {
      await mutate(
        "UPDATE practice_runs SET outcome='site_visit',site_visit_reason=? WHERE id=?",
        [outcome.siteVisit, runId],
        connection,
      );
      await addMessage(connection, businessId, runId, 'owner', 'site_visit', outcome.siteVisit);
    }
    return scenario;
  });
  const [run] = await rows('SELECT asked_json FROM practice_runs WHERE id=?', [runId]);
  const insights = await insightsFor(
    runId,
    scenario,
    json<string[]>(run.asked_json, []),
    outcome,
    context.trade,
  );
  await transaction(async (connection) => {
    await addMessage(
      connection,
      businessId,
      runId,
      'customer',
      'text',
      'quote' in outcome ? scenario.acceptReply : scenario.siteVisitReply,
    );
    await mutate(
      "UPDATE practice_runs SET insights_json=?,status='finished',finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [JSON.stringify(insights), runId],
      connection,
    );
  });
  await kickPreparation(businessId);
  return viewOf(businessId, runId);
}

export async function sendPracticeQuote(businessId: string, runId: string, body: unknown) {
  return finishRun(businessId, runId, { quote: quoteDraftSchema.parse(body) });
}

export async function askForSiteVisit(businessId: string, runId: string, reason: string) {
  return finishRun(businessId, runId, { siteVisit: reason });
}

/** The owner's correction. It goes to the AI as something they taught it. */
export async function editInsight(
  businessId: string,
  runId: string,
  insightId: string,
  text: string,
) {
  await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    const insights = json<(Insight & { edited?: boolean })[]>(run.insights_json, []);
    const insight = insights.find((item) => item.id === insightId);
    if (!insight) throw new ApiError(404, 'INSIGHT_NOT_FOUND', 'That line isn’t here anymore.');
    insight.text = text;
    insight.edited = true;
    await mutate(
      'UPDATE practice_runs SET insights_json=? WHERE id=?',
      [JSON.stringify(insights), runId],
      connection,
    );
  });
  return viewOf(businessId, runId);
}

export async function retryPracticeRun(businessId: string, runId: string) {
  const updated = await mutate(
    "UPDATE practice_runs SET status='preparing',failure=NULL,prepare_until=NULL WHERE id=? AND business_id=? AND status='failed'",
    [runId, businessId],
  );
  if (!updated.affectedRows)
    throw new ApiError(409, 'PRACTICE_NOT_FAILED', 'This practice customer is fine.');
  await kickPreparation(businessId);
}
