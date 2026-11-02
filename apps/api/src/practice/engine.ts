import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { aiMode, type AiImage } from '../ai/index.js';
import { describeRate, replyAsPracticeCustomer, writePracticeScenario } from '../ai/practice.js';
import { generatePracticePhoto } from '../ai/practice-images.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { json, type Row } from '../models.js';
import { listPastJobs, photoUrl } from '../past-jobs.js';
import { AGREE_PERCENT, closePercentFor } from '../pricing/accuracy.js';
import { draftForBusiness } from '../pricing/draft.js';
import { refreshFormula } from '../pricing/formula-draft.js';
import { businessContext, examplesFor, loadPricingData } from '../pricing/history.js';
import { marketPricesEnabled, marketRate } from '../pricing/market.js';
import { chargesLine } from '../pricing/rates.js';
import { SIZE_FACT, specFromScenario } from '../pricing/spec.js';
import { formatQuantity } from '../pricing/units.js';
import { getPhoto, putPhoto } from '../storage.js';
import { withAiUsage } from '../usage.js';
import { demoDraftQuote, demoPhoto, demoRateLine, demoReply, demoScenario } from './demo.js';
import { focusSituation, planSituation } from './plan.js';
import {
  gapPercent,
  quoteDraftSchema,
  quoteTotal,
  type Insight,
  type PracticeScenario,
  type Quote,
  type QuoteDraft,
  type Shadow,
} from './types.js';

/** Practice quotes to finish before the AI counts as trained. More can follow later. */
export const PRACTICE_COUNT = 6;
const MAX_MESSAGES = 40;
const TONES = ['canary', 'pink', 'blue'] as const;
const centsFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const money = (cents: number) => centsFormat.format(cents / 100);
/**
 * Other businesses' combined rate for a practice job's service, next to the owner's own rate on
 * it. The card shows it only when the owner charged this much less, so they can see when they
 * charge less than most, and never to tell them they charge too much.
 */
type PracticeMarket = {
  trade: string;
  unit: string;
  businesses: number;
  centsPerUnit: number;
  ownerCentsPerUnit: number;
};
const UNDER_MARKET = 0.9;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const joinList = (items: string[]) =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export async function ensurePracticeRuns(businessId: string, count = PRACTICE_COUNT) {
  for (let position = 0; position < count; position++)
    await mutate('INSERT IGNORE INTO practice_runs (id,business_id,position) VALUES (?,?,?)', [
      randomUUID(),
      businessId,
      position,
    ]);
}

/** Practice customers one business can have in all, setup's included. */
export const MAX_PRACTICE_RUNS = { draft: 8, active: 50 };

/**
 * Another practice customer once setup's are done, for training whenever the owner likes,
 * and for one service if they pick it. If one is still being written or answered, that's the one:
 * the AI never writes two at once for a business.
 */
export async function addPracticeRun(
  businessId: string,
  { focus = null, draft = false }: { focus?: string | null; draft?: boolean } = {},
): Promise<string> {
  return transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const runs = await rows(
      'SELECT id,position,status FROM practice_runs WHERE business_id=? ORDER BY position',
      [businessId],
      connection,
    );
    const open = runs.find((run) => run.status !== 'finished');
    if (open) return String(open.id);
    if (runs.length >= (draft ? MAX_PRACTICE_RUNS.draft : MAX_PRACTICE_RUNS.active))
      throw new ApiError(
        409,
        'PRACTICE_LIMIT',
        draft
          ? 'That’s plenty for now. Create your account to keep practicing from the Train page.'
          : 'That’s a lot of practice. Your Charm keeps learning from the quotes you send and the jobs you add.',
      );
    const id = randomUUID();
    const position = runs.reduce((last, run) => Math.max(last, Number(run.position)), -1) + 1;
    await mutate(
      'INSERT INTO practice_runs (id,business_id,position,focus_service) VALUES (?,?,?,?)',
      [id, businessId, position, focus],
      connection,
    );
    return id;
  });
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

/** What the business has taught so far, for choosing what the next practice customer asks. */
async function nextSituation(
  businessId: string,
  position: number,
  services: string[],
  focus: string | null,
) {
  const data = await loadPricingData(businessId);
  if (focus) return focusSituation(focus, data.points);
  const runs = await rows(
    "SELECT scenario_json FROM practice_runs WHERE business_id=? AND status='finished' AND position<>? ORDER BY position",
    [businessId, position],
  );
  return planSituation({
    position,
    setupCount: PRACTICE_COUNT,
    services,
    examples: Object.fromEntries(
      services.map((service) => [service.toLowerCase(), examplesFor(data.history, service)]),
    ),
    asked: runs.map(
      (run) => json<PracticeScenario>(run.scenario_json, {} as PracticeScenario).situation ?? '',
    ),
  });
}

async function writeScenario(
  businessId: string,
  position: number,
  focus: string | null,
): Promise<PracticeScenario> {
  const context = await businessContext(businessId);
  const situation = await nextSituation(businessId, position, context.services, focus);
  if (aiMode === 'demo')
    return { ...demoScenario(position, focus ? [focus] : context.services), situation };
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
  const scenario = await withAiUsage(businessId, `practice:${position}`, () =>
    writePracticeScenario({
      trade: context.trade,
      businessName: context.name,
      services: context.services,
      area: context.area,
      radiusMiles: context.radiusMiles,
      jobs,
      situation,
      earlier,
    }),
  );
  // Practice for one service counts toward that service, whatever the AI called it.
  return { ...scenario, serviceName: focus ?? scenario.serviceName, situation };
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
      scenario = await writeScenario(
        businessId,
        Number(run.position),
        run.focus_service ? String(run.focus_service) : null,
      );
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
  const market = json<PracticeMarket | null>(run.market_json, null);
  return {
    id: String(run.id),
    position,
    status: run.status as 'preparing' | 'ready' | 'failed' | 'finished',
    failure: run.status === 'failed' ? String(run.failure || '') : null,
    customer: scenario ? customerOf(scenario, position) : null,
    serviceName: scenario?.serviceName ?? null,
    /** The service the owner asked to practice, known before the customer is written. */
    focus: run.focus_service ? String(run.focus_service) : null,
    suggestions: scenario?.suggestions ?? [],
    messages:
      run.status === 'preparing'
        ? []
        : messages.map((message) => ({
            id: String(message.id),
            from: message.sender as 'customer' | 'owner',
            text:
              message.kind === 'quote' || message.kind === 'site_visit' ? '' : String(message.text),
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
    market: market && market.ownerCentsPerUnit < market.centsPerUnit * UNDER_MARKET ? market : null,
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

/** How close the AI's private guesses were to the owner's real answers, within the owner's percent. */
export function practiceResults(views: RunView[], closePercent = AGREE_PERCENT): PracticeResult[] {
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
        agree: gap !== null && gap <= closePercent,
        siteVisit: false,
        aiFlagged,
      };
    });
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
  const closePercent = await closePercentFor(businessId);
  const results = practiceResults(views, closePercent);
  return {
    count: PRACTICE_COUNT,
    runs: views,
    current: firstOpen === -1 ? Math.max(0, views.length - 1) : firstOpen,
    finished: views.filter((run) => run.finished).length,
    results,
    closePercent,
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
      'That’s a long conversation. Send a quote with what you have.',
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
                text: message.kind === 'quote' ? '[quote]' : String(message.text),
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
  if (reply.visitAsk) {
    // Kept out of the AI's guess, which is made from the request and not from the owner's answer.
    await mutate("UPDATE practice_messages SET kind='visit_ask' WHERE id=?", [ownerId]);
    // The customer asks once for a rough price from the photos, like anyone shopping online would.
    // An owner who still wants to see the job has given their answer for this one.
    if (before.some((message) => message.kind === 'visit_ask'))
      return {
        run: await finishRun(businessId, runId, {
          siteVisit: reply.visitReason || scenario.siteVisitCue,
        }),
        nudge: false,
        visitAsk: true,
      };
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
  return {
    run: await viewOf(businessId, runId),
    nudge: reply.mentionsPrice || reply.visitAsk,
    visitAsk: reply.visitAsk,
  };
}

async function businessContextName(businessId: string) {
  const [business] = await rows('SELECT name FROM businesses WHERE id=?', [businessId]);
  return String(business?.name ?? '');
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
  // Demo customers keep their fixed pattern, which knows each one's size and add-ons.
  const demo = async () => {
    const prior = await rows(
      "SELECT scenario_json,quote_json FROM practice_runs WHERE business_id=? AND status='finished' AND id<>? ORDER BY position",
      [businessId, runId],
    );
    const jobs = await listPastJobs(businessId);
    return () =>
      demoDraftQuote({
        scenario,
        jobs,
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
  };
  const { drafted, engine } = await withAiUsage(businessId, `practice:${runId}`, async () =>
    draftForBusiness({
      businessId,
      serviceName: scenario.serviceName,
      conversation: messages.map((message) => ({
        from: message.sender as 'customer' | 'owner',
        text: String(message.text),
      })),
      spec: specFromScenario(scenario),
      images: aiMode === 'demo' ? [] : await runImages(businessId, runId, messages),
      history: { excludeRunId: runId },
      demo: aiMode === 'demo' ? await demo() : undefined,
    }),
  );
  const shadow: Shadow = { ...drafted, cents: quoteTotal(drafted), engine };
  await mutate('UPDATE practice_runs SET shadow_json=? WHERE id=? AND shadow_json IS NULL', [
    JSON.stringify(shadow),
    runId,
  ]);
  const [saved] = await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [runId]);
  return json<Shadow>(saved.shadow_json, shadow);
}

async function insightsFor(
  businessId: string,
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
        // The AI sometimes writes the whole phrase, "Asks about the window count", as the label.
        const label = fact?.label.replace(/^\s*asks about\s+/i, '').trim();
        return label ? [label] : [];
      }),
    ),
  ];
  const items: string[] = [];
  if (labels.length) items.push(`Asks about ${joinList(labels)}`);
  if ('quote' in outcome) {
    const quote = outcome.quote;
    if (!labels.length) items.push('Quotes straight from the photos when a job looks clear');
    const main = quote.lines[0];
    // With a size it's simple division, the same size the rate card reads. The AI only words it
    // when there's no size to divide by.
    const spec = specFromScenario(scenario);
    // A price the same as the least they've charged for another job is likely their minimum,
    // which says nothing about a rate, so it's said as it is.
    const others = (await loadPricingData(businessId, { excludeRunId: runId })).points;
    const atMinimum =
      others.length > 0 && main.amountCents <= Math.min(...others.map((point) => point.cents));
    let rate = '';
    try {
      rate =
        aiMode === 'demo'
          ? demoRateLine(scenario, main.amountCents)
          : spec.quantity && spec.unit && atMinimum
            ? `Charges ${money(main.amountCents)} for ${lowerFirst(scenario.serviceName)}, ${formatQuantity(spec.quantity, spec.unit)}`
            : spec.quantity && spec.unit
              ? `${chargesLine(main.amountCents, spec.quantity, spec.unit)} for ${lowerFirst(scenario.serviceName)}`
              : await withAiUsage(businessId, `practice:${runId}`, () =>
                  describeRate({
                    trade,
                    serviceName: scenario.serviceName,
                    mainLine: { label: main.label, amountCents: main.amountCents },
                    sizeAnswer:
                      scenario.facts.find((fact) => SIZE_FACT.test(fact.key))?.answer ?? '',
                  }),
                );
    } catch (error) {
      // Out of AI allowance is expected; the plain line below covers it.
      if (!(error instanceof ApiError)) reportError(error, { event: 'practice_rate' });
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
    items.push(`Wants to see ${outcome.siteVisit || 'jobs like this'} before giving a price`);
    items.push(
      scenario.siteVisitCue
        ? `Won’t send a price for ${scenario.siteVisitCue} until you’ve looked`
        : 'Sends jobs like this to you instead of quoting',
    );
  }
  return items.map((text, index) => ({ id: `${runId.slice(0, 8)}-${index}`, text }));
}

/** Other businesses' combined rate for this job's service, only where the Terms allow it. */
async function marketBeside(
  businessId: string,
  context: { tradeId: string | null; trade: string },
  scenario: PracticeScenario,
  quote: QuoteDraft,
): Promise<PracticeMarket | null> {
  const spec = specFromScenario(scenario);
  const main = quote.lines[0];
  if (!marketPricesEnabled() || !context.tradeId || !spec.quantity || !spec.unit || !main)
    return null;
  const market = await marketRate({
    businessId,
    tradeId: context.tradeId,
    serviceName: scenario.serviceName,
    unit: spec.unit,
  });
  return market
    ? {
        trade: context.trade,
        unit: market.unit,
        businesses: market.businesses,
        centsPerUnit: market.centsPerUnit,
        ownerCentsPerUnit: main.amountCents / spec.quantity,
      }
    : null;
}

async function finishRun(
  businessId: string,
  runId: string,
  outcome: { quote: QuoteDraft } | { siteVisit: string },
) {
  // The AI's private guess only measures how close it gets. If it can't be made, the owner's
  // answer still goes through, and this run just has no guess.
  await computeShadow(businessId, runId).catch((error) => {
    if (error instanceof ApiError && error.code === 'PRACTICE_CLOSED') throw error;
    reportError(error, { event: 'practice_guess' });
  });
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
      // No message for this: the owner asked for the visit in the chat.
      await mutate(
        "UPDATE practice_runs SET outcome='site_visit',site_visit_reason=? WHERE id=?",
        [outcome.siteVisit, runId],
        connection,
      );
    }
    return scenario;
  });
  const [run] = await rows('SELECT asked_json FROM practice_runs WHERE id=?', [runId]);
  const insights = await insightsFor(
    businessId,
    runId,
    scenario,
    json<string[]>(run.asked_json, []),
    outcome,
    context.trade,
  );
  const market =
    'quote' in outcome
      ? await marketBeside(businessId, context, scenario, outcome.quote).catch((error) => {
          reportError(error, { event: 'practice_market' });
          return null;
        })
      : null;
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
      "UPDATE practice_runs SET insights_json=?,market_json=?,status='finished',finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [JSON.stringify(insights), market && JSON.stringify(market), runId],
      connection,
    );
  });
  refreshFormula(businessId);
  await kickPreparation(businessId);
  return viewOf(businessId, runId);
}

export async function sendPracticeQuote(businessId: string, runId: string, body: unknown) {
  return finishRun(businessId, runId, { quote: quoteDraftSchema.parse(body) });
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

/** Takes back a correction: the line stays on the practice result but stops teaching the AI. */
export async function forgetInsight(businessId: string, runId: string, insightId: string) {
  await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    const insights = json<(Insight & { edited?: boolean })[]>(run.insights_json, []);
    const insight = insights.find((item) => item.id === insightId && item.edited);
    if (!insight) throw new ApiError(404, 'INSIGHT_NOT_FOUND', 'That line isn’t here anymore.');
    insight.edited = false;
    await mutate(
      'UPDATE practice_runs SET insights_json=? WHERE id=?',
      [JSON.stringify(insights), runId],
      connection,
    );
  });
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
