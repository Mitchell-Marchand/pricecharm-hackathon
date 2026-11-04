import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { aiMode, aiProvider, type AiImage } from '../ai/index.js';
import {
  describeRate,
  replyAsPracticeCustomer,
  writePracticeScenario,
  type CustomerReply,
} from '../ai/practice.js';
import { generatePracticePhoto } from '../ai/practice-images.js';
import { mutate, rows, transaction, type Sql } from '../db.js';
import { businessLanguage, languageName } from '../languages.js';
import { photoReadingsAvailable } from '../live/photo-readings.js';
import { copyLibraryEntry, libraryEntryFor } from './library.js';
import { distanceOf, drawDistance, reconcileScenario } from './photo-facts.js';
import {
  fixPracticeReading,
  photoReadingView,
  practicePhotoNotes,
  READ_SECONDS,
  readPracticePhotos,
  resumePhotoReadings,
  RUN_COLUMNS,
  type StoredReading,
} from './photos.js';
import { reportError } from '../error-reporting.js';
import { recordEvent } from '../metrics.js';
import { ApiError } from '../http.js';
import { json, type Row } from '../models.js';
import { listPastJobs, photoUrl } from '../past-jobs.js';
import { AGREE_PERCENT, closePercentFor } from '../pricing/accuracy.js';
import { draftForBusiness } from '../pricing/draft.js';
import {
  currentFormula,
  formulaExamples,
  holdFormula,
  refreshFormula,
  releaseFormula,
} from '../pricing/formula-draft.js';
import {
  businessContext,
  examplesFor,
  loadPricingData,
  type PricingData,
} from '../pricing/history.js';
import { marketPricesEnabled, marketRate } from '../pricing/market.js';
import { chargesLine } from '../pricing/rates.js';
import { SIZE_FACT, specFromScenario } from '../pricing/spec.js';
import { knownSpec, saidSpec } from './known.js';
import { answerNote, answerQuestion, pickQuestion, type OwnerQuestion } from './owner-questions.js';
import { formatQuantity } from '../pricing/units.js';
import { getPhoto, putPhoto } from '../storage.js';
import { withAiUsage } from '../usage.js';
import {
  DECLINE_REPLY,
  demoDraftQuote,
  demoMiles,
  demoPhoto,
  demoPhotoReading,
  demoRateLine,
  demoReply,
  demoScenario,
} from './demo.js';
import {
  drawAskedPhoto,
  drawPhotoSet,
  openerForOnePhoto,
  photoSetsAvailable,
} from './photo-set.js';
import { focusLesson, focusSituation, pickedCustomer, planCustomer, type Lesson } from './plan.js';
import { pickJob } from '../pricing/next-job.js';
import { TRADE_DRIVERS } from './trade-drivers.js';
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
import { money as formatMoney, type Currency } from '../money.js';
import {
  addTurnDown,
  REASONS,
  ruleInput,
  setMinimum,
  turnDownView,
  type TurnDownKind,
  type TurnDownView,
} from '../turn-downs.js';
import { z } from 'zod';

/** Practice quotes to finish before the AI counts as trained. More can follow later. */
export const PRACTICE_COUNT = 6;
const MAX_MESSAGES = 40;
/** Photos one practice customer sends when asked, the prepared one included. */
export const PHOTO_ASKS = 2;
/** How long taking one asked-for photo may hold a customer: a made image takes 20 to 30 s. */
const PHOTO_ASK_SECONDS = 150;
const TONES = ['canary', 'pink', 'blue'] as const;
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
/** The owner's side of a turned-down customer's chat. Only the reason is kept. */
const DECLINED_LINE = 'Sorry, we can’t take this one on.';

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

/**
 * Practice customers one business can have in all, setup's included. Setup trains on practice
 * alone now, and about 12 customers is where the benchmark's prices settle, so a setup can go a
 * little past that before signing up.
 */
export const MAX_PRACTICE_RUNS = { draft: 15, active: 50 };

/** A business's customers in order, and whether the owner has started on each. */
const customersOf = (businessId: string, connection: Sql) =>
  rows(
    `SELECT r.id,r.position,r.status,r.outcome,r.focus_service,
     EXISTS(SELECT 1 FROM practice_messages m WHERE m.run_id=r.id AND m.sender='owner') AS started
     FROM practice_runs r WHERE r.business_id=? ORDER BY r.position`,
    [businessId],
    connection,
  );

/** Not answered yet. One the owner has answered is finishing in the background, not waiting. */
const isOpen = (run: Row) => run.status !== 'finished' && !run.outcome;

/**
 * Another practice customer once setup's are done, for training whenever the owner likes,
 * and for one service if they pick it. If one is still being written or answered, that's the one,
 * unless they asked for a service and all that's open is a spare made for something else. Then
 * the one they asked for goes first and the spare waits behind it.
 */
export async function addPracticeRun(
  businessId: string,
  { focus = null, draft = false }: { focus?: string | null; draft?: boolean } = {},
): Promise<string> {
  return transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const runs = await customersOf(businessId, connection);
    const open = runs.filter(isOpen);
    const fits = (run: Row) =>
      !focus || String(run.focus_service ?? '').toLowerCase() === focus.toLowerCase();
    const current = open.find(fits) ?? open.find((run) => Number(run.started));
    if (current) {
      // Asked for now, so coming back opens it rather than the one just answered.
      await mutate(
        'UPDATE practice_runs SET created_at=UTC_TIMESTAMP(3) WHERE id=?',
        [current.id],
        connection,
      );
      return String(current.id);
    }
    if (runs.length >= (draft ? MAX_PRACTICE_RUNS.draft : MAX_PRACTICE_RUNS.active))
      throw new ApiError(
        409,
        'PRACTICE_LIMIT',
        draft
          ? 'That’s plenty for now. Create your account to keep practicing from the Train page.'
          : 'That’s a lot of practice. Your Charm keeps learning from the quotes you send and the jobs you add.',
      );
    const id = randomUUID();
    const next = runs.reduce((last, run) => Math.max(last, Number(run.position)), -1) + 1;
    const [spare] = open;
    if (spare)
      await mutate('UPDATE practice_runs SET position=? WHERE id=?', [next, spare.id], connection);
    await mutate(
      'INSERT INTO practice_runs (id,business_id,position,focus_service) VALUES (?,?,?,?)',
      [id, businessId, spare ? spare.position : next, focus],
      connection,
    );
    return id;
  });
}

/**
 * Keeps the next customer ready past setup's first ones, so moving on never means a wait. Once the
 * owner has started on the last one waiting, one more is made behind it, so at most one sits
 * unused. Never fails what the owner is doing: at worst the next customer is written on request.
 */
async function keepNextCustomerReady(businessId: string, focus: string | null) {
  try {
    await transaction(async (connection) => {
      const [business] = await rows(
        'SELECT status FROM businesses WHERE id=? FOR UPDATE',
        [businessId],
        connection,
      );
      const runs = await customersOf(businessId, connection);
      const most = business.status === 'draft' ? MAX_PRACTICE_RUNS.draft : MAX_PRACTICE_RUNS.active;
      if (runs.length >= most || runs.some((run) => isOpen(run) && !Number(run.started))) return;
      await mutate(
        'INSERT INTO practice_runs (id,business_id,position,focus_service) VALUES (?,?,?,?)',
        [
          randomUUID(),
          businessId,
          runs.reduce((last, run) => Math.max(last, Number(run.position)), -1) + 1,
          focus,
        ],
        connection,
      );
    });
    await kickPreparation(businessId);
  } catch (error) {
    reportError(error, { event: 'practice_prepare' });
  }
}

/** The customer being answered and the next one are made ahead, and no more than that. */
const CUSTOMERS_AHEAD = 2;

/**
 * The first customer, from the moment setup knows the trade and its services, so the chat is
 * waiting when the owner gets there. It does nothing once one is made or being made.
 */
export async function startFirstCustomer(businessId: string) {
  await ensurePracticeRuns(businessId);
  await kickPreparation(businessId, 1);
}

/**
 * Takes away customers the owner hasn't started on that were made for a service they've turned
 * off. One still being written was told about that service, so it goes too. They're made again
 * from what's offered now.
 */
export async function dropCustomersOfOldServices(
  businessId: string,
  services: string[],
  connection: Sql,
) {
  const offered = new Set(services.map((name) => name.toLowerCase()));
  const waiting = await rows(
    `SELECT r.id,r.scenario_json,r.prepare_until FROM practice_runs r WHERE r.business_id=? AND r.outcome IS NULL
     AND NOT EXISTS(SELECT 1 FROM practice_messages m WHERE m.run_id=r.id AND m.sender='owner')`,
    [businessId],
    connection,
  );
  for (const run of waiting) {
    const scenario = json<PracticeScenario | null>(run.scenario_json, null);
    const old = scenario
      ? !offered.has(scenario.serviceName.toLowerCase())
      : Boolean(run.prepare_until);
    if (old) await mutate('DELETE FROM practice_runs WHERE id=?', [run.id], connection);
  }
}

/**
 * Starts preparing customers that are waiting, earliest first, outside the request. Everything
 * that checks on practice comes through here, polling included, so the ones already in hand
 * count. Otherwise one wait for the first customer would write all of setup's at once.
 */
export async function kickPreparation(businessId: string, ahead = CUSTOMERS_AHEAD) {
  const [held] = await rows(
    "SELECT COUNT(*) AS count FROM practice_runs WHERE business_id=? AND outcome IS NULL AND (status='ready' OR (status='preparing' AND prepare_until>=UTC_TIMESTAMP(3)))",
    [businessId],
  );
  const room = ahead - Number(held.count);
  const due =
    room > 0
      ? await rows(
          `SELECT id FROM practice_runs WHERE business_id=? AND status='preparing' AND (prepare_until IS NULL OR prepare_until<UTC_TIMESTAMP(3)) ORDER BY position LIMIT ${room}`,
          [businessId],
        )
      : [];
  for (const run of due) startPreparing(String(run.id));
  // Photos a restart left unread, or an asked-for photo it left untaken, are picked up again.
  await resumePhotoReadings(businessId);
  const asked = await rows(
    "SELECT id FROM practice_runs WHERE business_id=? AND status='ready' AND photo_ask_json IS NOT NULL AND (photo_ask_until IS NULL OR photo_ask_until<UTC_TIMESTAMP(3))",
    [businessId],
  );
  for (const run of asked) {
    const token = await claimPhotoAsk(String(run.id));
    if (token) void takeAskedPhoto(String(run.id), token);
  }
}

/**
 * Where this customer is: near one of the owner's locations, mostly the main one. The first is
 * kept in businesses.service_area too, which is all a business from before locations has.
 */
async function locationFor(businessId: string, area: string, random = Math.random) {
  const locations = (
    await rows('SELECT area FROM business_locations WHERE business_id=? ORDER BY position', [
      businessId,
    ])
  )
    .map((row) => String(row.area).trim())
    .filter(Boolean);
  if (!locations.length) return area.trim();
  return locations.length > 1 && random() < 0.3
    ? locations[1 + Math.floor(random() * (locations.length - 1))]
    : locations[0];
}

/** What the business has taught so far, for choosing what the next practice customer asks. */
async function nextCustomer(
  businessId: string,
  position: number,
  services: string[],
  focus: string | null,
): Promise<{ situation: string; lesson: Lesson; pick?: string }> {
  const data = await loadPricingData(businessId);
  if (focus) return { situation: focusSituation(focus, data.points), lesson: focusLesson(focus) };
  const runs = await rows(
    "SELECT scenario_json FROM practice_runs WHERE business_id=? AND status='finished' AND position<>? ORDER BY position",
    [businessId, position],
  );
  const [past] = await rows('SELECT COUNT(*) AS count FROM past_jobs WHERE business_id=?', [
    businessId,
  ]);
  const plan = planCustomer({
    position,
    setupCount: PRACTICE_COUNT,
    pastJobs: Number(past.count),
    services,
    examples: Object.fromEntries(
      services.map((service) => [service.toLowerCase(), examplesFor(data.history, service)]),
    ),
    asked: runs.map(
      (run) => json<PracticeScenario>(run.scenario_json, {} as PracticeScenario).situation ?? '',
    ),
  });
  if (!plan.everyday || process.env.PRACTICE_PICKER === 'off') return plan;
  const learned = await currentFormula(businessId, data).catch(() => null);
  if (!learned) return plan;
  const [business] = await rows('SELECT trade_id FROM businesses WHERE id=?', [businessId]);
  const asked = (
    await rows('SELECT owner_question_json FROM practice_runs WHERE business_id=?', [businessId])
  ).flatMap((run) => {
    const question = json<{ key: string } | null>(run.owner_question_json, null);
    return question ? [question.key] : [];
  });
  const job = pickJob({
    readings: [learned, ...(learned.also ?? [])].map((reading) => reading.formula),
    examples: learned.examples,
    extras: (TRADE_DRIVERS[String(business?.trade_id)] ?? []).filter(
      (driver) => driver.customer && !asked.includes(driver.key),
    ),
    used: runs.flatMap(
      (run) => json<PracticeScenario>(run.scenario_json, {} as PracticeScenario).pick ?? [],
    ),
  });
  return job ? pickedCustomer(job, learned.formula, position) : plan;
}

/** The language an owner works in, when it isn't English. English customers change nothing. */
async function practiceLanguage(businessId: string) {
  const [business] = await rows('SELECT language FROM businesses WHERE id=?', [businessId]);
  const language = business ? businessLanguage(business) : 'en';
  return language === 'en' ? undefined : languageName(language);
}

/** Roughly where a business is from its currency, for a customer made before they've said. */
const COUNTRIES: Partial<Record<Currency, string>> = {
  CAD: 'Canada',
  AUD: 'Australia',
  NZD: 'New Zealand',
  GBP: 'the United Kingdom',
  EUR: 'Europe',
  INR: 'India',
  NGN: 'Nigeria',
  KES: 'Kenya',
  ZAR: 'South Africa',
  BRL: 'Brazil',
  MXN: 'Mexico',
  PHP: 'the Philippines',
};

async function writeScenario(
  businessId: string,
  position: number,
  focus: string | null,
): Promise<PracticeScenario> {
  const context = await businessContext(businessId);
  const { situation, lesson, pick } = await nextCustomer(
    businessId,
    position,
    context.services,
    focus,
  );
  const location = await locationFor(businessId, context.area);
  if (aiMode === 'demo') {
    const scenario = demoScenario(position, focus ? [focus] : context.services);
    return {
      ...scenario,
      situation,
      distance: distanceOf(demoMiles(scenario), context.currency, location),
    };
  }
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
  const language = await practiceLanguage(businessId);
  const scenario = await withAiUsage(businessId, `practice:${position}`, () =>
    writePracticeScenario({
      trade: context.trade,
      businessName: context.name,
      services: context.services,
      location: location || (COUNTRIES[context.currency] ?? ''),
      distanceUnit: context.currency === 'USD' ? 'mi' : 'km',
      radiusMiles: context.radiusMiles,
      jobs,
      situation,
      lesson,
      earlier,
      language,
    }),
  );
  // Practice for one service counts toward that service, whatever the AI called it.
  return {
    ...scenario,
    serviceName: focus ?? scenario.serviceName,
    situation,
    ...(pick ? { pick } : {}),
    distance: scenario.distance
      ? { ...scenario.distance, ...(location ? { from: location } : {}) }
      : drawDistance(context.currency, location),
  };
}

/** A checked library customer for this slot, copied in as the owner's own, if one fits. */
async function libraryScenario(
  businessId: string,
  runId: string,
  position: number,
  focus: string | null,
) {
  // The library's customers write English.
  if (await practiceLanguage(businessId)) return null;
  const found = await libraryEntryFor(businessId, position, focus);
  if (!found) return null;
  try {
    const copied = await copyLibraryEntry(businessId, runId, found);
    const context = await businessContext(businessId);
    const location = await locationFor(businessId, context.area);
    return {
      scenario: { ...copied.scenario, distance: drawDistance(context.currency, location) },
      reading: copied.reading,
    };
  } catch (error) {
    // One is written for them instead.
    reportError(error, { event: 'practice_library' });
    return null;
  }
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
  return savePracticePhoto(businessId, runId, bytes);
}

async function savePracticePhoto(businessId: string, runId: string, bytes: Buffer) {
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
 * The photo the owner asked for, made from the customer's other photos of that place, so it's the
 * same place. It's null if it doesn't pass. With nothing to work from, it's drawn from words.
 */
async function createAskedPhoto(
  businessId: string,
  runId: string,
  scenario: PracticeScenario,
  ask: { scene: string; place?: number },
) {
  const place = ask.place ?? 0;
  const own = scenario.photos.filter((photo) => photo.photoId && (photo.place ?? 0) === place);
  const shown = own.length ? own : scenario.photos.filter((photo) => photo.photoId);
  if (aiMode === 'demo' || !photoSetsAvailable() || !shown.length)
    return createPracticePhoto(businessId, runId, scenario, ask.scene);
  const stored = await rows(
    `SELECT id,storage_key FROM attachments WHERE business_id=? AND id IN (${shown.map(() => '?').join(',')})`,
    [businessId, ...shown.map((photo) => photo.photoId)],
  );
  const keys = new Map(stored.map((row) => [String(row.id), String(row.storage_key)]));
  const references = await Promise.all(
    shown.flatMap((photo) => {
      const key = keys.get(String(photo.photoId));
      return key ? [getPhoto(key).then((bytes) => ({ scene: photo.scene, bytes }))] : [];
    }),
  );
  const bytes = await drawAskedPhoto({
    owner: businessId,
    project: scenario.project,
    references,
    view: ask.scene,
    place,
    spend: (task) => withAiUsage(businessId, `practice-photo:${runId}`, task),
  });
  return bytes ? savePracticePhoto(businessId, runId, bytes) : null;
}

/** Whether a new photo can be made here: demo mode has bundled ones, live needs an image key. */
function canTakePhotos() {
  if (aiMode === 'demo') return true;
  return Boolean(aiProvider === 'meta' ? process.env.META_API_KEY : process.env.OPENAI_API_KEY);
}

/** Holds an asked-for photo that a restart left untaken, to take it again. */
async function claimPhotoAsk(runId: string): Promise<string | null> {
  const token = randomUUID();
  const claimed = await mutate(
    `UPDATE practice_runs SET photo_ask_token=?,photo_ask_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${PHOTO_ASK_SECONDS} SECOND)
     WHERE id=? AND photo_ask_json IS NOT NULL AND (photo_ask_until IS NULL OR photo_ask_until<UTC_TIMESTAMP(3))`,
    [token, runId],
  );
  return claimed.affectedRows ? token : null;
}

/**
 * Takes the photo the owner asked for and sends it, with what the customer says about it. If it
 * can't be made, the prepared photo goes instead, or the customer says that's all they have and
 * the ask doesn't count. Never throws: the chat always goes on.
 */
export function takeAskedPhoto(runId: string, token: string): Promise<void> {
  return takePhoto(runId, token).catch((error) =>
    reportError(error, { event: 'practice_asked_photo' }),
  );
}

async function takePhoto(runId: string, token: string) {
  const [run] = await rows('SELECT * FROM practice_runs WHERE id=? AND photo_ask_token=?', [
    runId,
    token,
  ]);
  if (!run) return;
  const businessId = String(run.business_id);
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const ask = json<{ scene: string; text: string; place?: number } | null>(
    run.photo_ask_json,
    null,
  );
  let photoId: string | null = null;
  try {
    if (ask) photoId = await createAskedPhoto(businessId, runId, scenario, ask);
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'practice_asked_photo' });
  }
  const fallback = !photoId && scenario.extraPhoto.photoId && !run.photo_sent;
  await transaction(async (connection) => {
    const [current] = await rows(
      'SELECT photo_ask_token,outcome FROM practice_runs WHERE id=? FOR UPDATE',
      [runId],
      connection,
    );
    if (current?.photo_ask_token !== token) return;
    await mutate(
      `UPDATE practice_runs SET photo_ask_json=NULL,photo_ask_token=NULL,photo_ask_until=NULL,
       photo_sent=photo_sent OR ?,photo_asks=GREATEST(0,photo_asks-?) WHERE id=?`,
      [Boolean(fallback), photoId || fallback ? 0 : 1, runId],
      connection,
    );
    if (current.outcome) return;
    if (photoId)
      await addMessage(connection, businessId, runId, 'customer', 'text', ask!.text, [photoId]);
    else if (fallback)
      await addMessage(
        connection,
        businessId,
        runId,
        'customer',
        'text',
        scenario.extraPhoto.text,
        [scenario.extraPhoto.photoId!],
      );
    else
      await addMessage(
        connection,
        businessId,
        runId,
        'customer',
        'text',
        'Sorry, I couldn’t get a good one of that. Hope the others help.',
      );
  });
}

const startPreparing = (runId: string) =>
  void preparePracticeRun(runId).catch((error) =>
    reportError(error, { event: 'practice_prepare' }),
  );

/** Starts this customer now, however many are ready: the owner is waiting on this one. */
export async function prepareNow(businessId: string, runId: string) {
  startPreparing(runId);
  await kickPreparation(businessId);
}

/**
 * The photo a customer holds back until they're asked. It's made after they open, so nobody waits
 * on a photo they may never see. If it isn't there when asked for, one is taken instead.
 */
async function makeHeldPhoto(businessId: string, runId: string, scenario: PracticeScenario) {
  if (scenario.extraPhoto.photoId || !scenario.extraPhoto.scene) return;
  try {
    const photoId = await createPracticePhoto(
      businessId,
      runId,
      scenario,
      scenario.extraPhoto.scene,
    );
    await transaction(async (connection) => {
      const [run] = await rows(
        'SELECT scenario_json FROM practice_runs WHERE id=? FOR UPDATE',
        [runId],
        connection,
      );
      const current = json<PracticeScenario | null>(run?.scenario_json, null);
      if (!current) return;
      current.extraPhoto.photoId = photoId;
      await mutate(
        'UPDATE practice_runs SET scenario_json=? WHERE id=?',
        [JSON.stringify(current), runId],
        connection,
      );
    });
  } catch (error) {
    reportError(error, { event: 'practice_photo' });
  }
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
    let reading = json<StoredReading | null>(run.photo_reading_json, null);
    if (!scenario) {
      const position = Number(run.position);
      const focus = run.focus_service ? String(run.focus_service) : null;
      const library = await libraryScenario(businessId, runId, position, focus);
      scenario = library?.scenario ?? (await writeScenario(businessId, position, focus));
      reading = library?.reading ?? null;
      await mutate(
        'UPDATE practice_runs SET scenario_json=?,photo_reading_json=? WHERE id=? AND prepare_token=?',
        [JSON.stringify(scenario), reading && JSON.stringify(reading), runId, token],
      );
    }
    let ready = scenario;
    const missing = ready.photos.filter((photo) => !photo.photoId);
    if (ready.project && missing.length && aiMode !== 'demo' && photoSetsAvailable()) {
      const shots = await drawPhotoSet({
        owner: businessId,
        title: `${ready.serviceName} photo`,
        project: ready.project,
        photos: ready.photos,
        spend: (task) => withAiUsage(businessId, `practice-photo:${runId}`, task),
      });
      for (const [index, shot] of shots.entries())
        if (shot) ready.photos[index].photoId = await savePracticePhoto(businessId, runId, shot);
      const kept = ready.photos.filter((photo) => photo.photoId);
      ready = {
        ...ready,
        photos: kept,
        opener:
          kept.length === 1 && ready.photos.length > 1
            ? openerForOnePhoto(ready.opener)
            : ready.opener,
      };
    } else
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
    const photoIds = ready.photos.flatMap((photo) => (photo.photoId ? [photo.photoId] : []));
    // The photos are read behind the chat, for the Charm's guess. Demo mode's stand-in reading is
    // instant, so it's saved with the customer. A real one starts once they're ready.
    const toRead = !reading && photoIds.length > 0 && photoReadingsAvailable();
    if (toRead && aiMode === 'demo') {
      reading = { photoIds, result: demoPhotoReading(ready), failure: '' };
      ready = reconcileScenario(ready, reading.result!).scenario;
    }
    const readToken = toRead && aiMode !== 'demo' ? randomUUID() : null;
    const opened = await transaction(async (connection) => {
      const [current] = await rows(
        'SELECT status,prepare_token FROM practice_runs WHERE id=? FOR UPDATE',
        [runId],
        connection,
      );
      if (current?.status !== 'preparing' || current.prepare_token !== token) return false;
      await mutate(
        `UPDATE practice_runs SET scenario_json=?,photo_reading_json=?,photo_read_token=?,
         photo_read_until=IF(? IS NULL,NULL,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${READ_SECONDS} SECOND)),
         status='ready',prepare_token=NULL,prepare_until=NULL,failure=NULL WHERE id=?`,
        [JSON.stringify(ready), reading && JSON.stringify(reading), readToken, readToken, runId],
        connection,
      );
      await addMessage(connection, businessId, runId, 'customer', 'text', ready.opener, photoIds);
      return true;
    });
    // Still outside the request: preparation runs on its own.
    if (opened)
      await Promise.all([
        readToken ? readPracticePhotos(runId, readToken) : null,
        makeHeldPhoto(businessId, runId, ready),
      ]);
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
  kind: 'text' | 'quote' | 'site_visit' | 'declined',
  text: string,
  photoIds: string[] = [],
  /** Saved in the same moment as the message before it, and sorted after it. */
  after = false,
) {
  const id = randomUUID();
  await mutate(
    `INSERT INTO practice_messages (id,business_id,run_id,sender,kind,text,photo_ids_json,created_at) VALUES (?,?,?,?,?,?,?,${after ? 'DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1000 MICROSECOND)' : 'UTC_TIMESTAMP(3)'})`,
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
    /** How far the job is from the owner: miles for US dollar businesses, km otherwise. */
    distance: scenario.distance ?? null,
    tone: TONES[position % TONES.length],
  };
}

/** What the owner chose when they turned a practice customer down. */
type SavedTurnDown = { reason: TurnDownKind; ruleId?: string; minimumCents?: number };

/**
 * A turned-down customer's reason, and the rule or minimum it saved as it stands now: changed or
 * removed since from What it knows or Settings, the card says so.
 */
function declinedView(run: Row, known: TurnDownView | undefined) {
  const saved = json<SavedTurnDown | null>(run.turn_down_json, null);
  if (!saved) return null;
  const rule = saved.ruleId
    ? (known?.rules.find((item) => item.id === saved.ruleId) ?? null)
    : null;
  const minimum = saved.minimumCents !== undefined;
  return {
    reason: saved.reason,
    reasonText: REASONS[saved.reason],
    rule,
    minimumCents: minimum ? (known?.minimumCents ?? null) : null,
    /** Taken out since, so live chats don't follow it anymore. */
    removed: saved.ruleId ? !rule : minimum && !known?.minimumCents,
  };
}

/** Says why the customer can't take a message or a quote yet: they're taking a photo. */
function assertIdle(run: Row) {
  if (run.photo_ask_json)
    throw new ApiError(409, 'PRACTICE_PHOTO', 'They’re still taking that photo.');
}

/** The owner's question as the card shows it, their "no" answer last. */
function questionView(question: OwnerQuestion | null) {
  if (!question) return null;
  return {
    ask: question.ask,
    answers: [...question.answers, question.no],
    answer: question.answer ?? null,
    skipped: Boolean(question.skipped),
    /** The note it saved, as the formula reads it. */
    note: question.answer ? answerNote(question, question.answer) : null,
  };
}

function runView(run: Row, messages: Row[], known?: TurnDownView) {
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
              message.kind === 'quote' || message.kind === 'site_visit'
                ? ''
                : message.kind === 'declined'
                  ? DECLINED_LINE
                  : String(message.text),
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
          withheld: shadow.withheld ?? null,
          toGo: shadow.toGo ?? null,
        }
      : null,
    insights: json<(Insight & { edited?: boolean })[]>(run.insights_json, []).map(
      ({ id, text }) => ({ id, text }),
    ),
    market: market && market.ownerCentsPerUnit < market.centsPerUnit * UNDER_MARKET ? market : null,
    /** Set once the owner turned this one down. */
    turnDown: declinedView(run, known),
    /** What the Charm saw in the photos the customer opened with, or that it's still looking. */
    photoReading: run.status === 'preparing' ? null : photoReadingView(run, messages),
    /** The customer is taking a photo the owner asked for. */
    takingPhoto: run.status === 'ready' && !run.outcome && Boolean(run.photo_ask_json),
    /** What the Charm asked the owner about their prices once they'd sent the quote. */
    question: questionView(json<OwnerQuestion | null>(run.owner_question_json, null)),
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
  // A job the owner turned down has no price to hold a guess to.
  return views
    .filter((run) => run.finished && run.outcome !== 'declined')
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
  const runs = await rows(
    `SELECT ${RUN_COLUMNS} FROM practice_runs WHERE business_id=? ORDER BY position`,
    [businessId],
  );
  await resumeFinishing(businessId, runs);
  const messages = await rows(
    'SELECT * FROM practice_messages WHERE business_id=? ORDER BY created_at,id',
    [businessId],
  );
  const known = runs.some((run) => run.turn_down_json) ? await turnDownView(businessId) : undefined;
  const views = runs.map((run) =>
    runView(
      run,
      messages.filter((message) => message.run_id === run.id),
      known,
    ),
  );
  const firstOpen = views.findIndex((run) => !run.finished);
  // Once a customer is answered the next is already waiting. Until the owner starts on it, coming
  // back opens the one they just answered, with what the Charm picked up. One they asked for since
  // then, like a customer for one service, opens instead.
  const stayBack =
    firstOpen > 0 &&
    !views[firstOpen].messages.some((message) => message.from === 'owner') &&
    Boolean(runs[firstOpen - 1].finished_at) &&
    new Date(runs[firstOpen].created_at) <= new Date(runs[firstOpen - 1].finished_at);
  const closePercent = await closePercentFor(businessId);
  const results = practiceResults(views, closePercent);
  return {
    count: PRACTICE_COUNT,
    runs: views,
    current:
      firstOpen === -1 ? Math.max(0, views.length - 1) : stayBack ? firstOpen - 1 : firstOpen,
    finished: views.filter((run) => run.finished).length,
    results,
    closePercent,
  };
}

async function loadRun(businessId: string, runId: string, connection?: Sql, lock = false) {
  const [run] = await rows(
    `SELECT ${RUN_COLUMNS} FROM practice_runs WHERE id=? AND business_id=?${lock ? ' FOR UPDATE' : ''}`,
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
  const known = run.turn_down_json ? await turnDownView(businessId) : undefined;
  return runView(run, await runMessages(runId), known);
}

export async function sendOwnerMessage(businessId: string, runId: string, text: string) {
  const run = await loadRun(businessId, runId);
  openRun(run);
  // On to the next customer: the last one's question isn't being answered now.
  releaseFormula(businessId);
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const before = await runMessages(runId);
  assertIdle(run);
  if (before.length >= MAX_MESSAGES)
    throw new ApiError(
      422,
      'PRACTICE_LONG',
      'That’s a long conversation. Send a quote with what you have.',
    );
  const ownerId = await addMessage(undefined, businessId, runId, 'owner', 'text', text);
  const turn = before.filter((message) => message.sender === 'owner').length;
  if (!turn) await keepNextCustomerReady(businessId, run.focus_service ?? null);
  // Up to two photos when asked: the prepared one straight away, or one taken of what they asked.
  const preparedPhoto = Boolean(scenario.extraPhoto.photoId) && !run.photo_sent;
  const photoAvailable =
    Number(run.photo_asks ?? 0) < PHOTO_ASKS && (preparedPhoto || canTakePhotos());
  const businessName = await businessContextName(businessId);
  const language = await practiceLanguage(businessId);
  let reply: CustomerReply;
  try {
    reply =
      aiMode === 'demo'
        ? demoReply(scenario, text, { photoAvailable, preparedPhoto, turn })
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
              preparedPhoto,
              language,
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
  // A new photo is taken for what they asked, unless the prepared one is what they asked for
  // or none can be made here. If taking it fails, the prepared one goes instead.
  const take = sendPhoto && Boolean(reply.photoScene) && canTakePhotos();
  const prepared = sendPhoto && !take && preparedPhoto;
  const asked = [...new Set([...json<string[]>(run.asked_json, []), ...reply.askedKeys])];
  const photoToken = take ? randomUUID() : null;
  await transaction(async (connection) => {
    await addMessage(
      connection,
      businessId,
      runId,
      'customer',
      'text',
      prepared
        ? scenario.extraPhoto.text
        : sendPhoto && !take
          ? 'That’s all the photos I have right now.'
          : reply.reply,
      prepared && scenario.extraPhoto.photoId ? [scenario.extraPhoto.photoId] : [],
    );
    await mutate(
      `UPDATE practice_runs SET asked_json=?,photo_sent=photo_sent OR ?,photo_asks=photo_asks+?,
       photo_ask_json=?,photo_ask_token=?,
       photo_ask_until=IF(? IS NULL,NULL,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${PHOTO_ASK_SECONDS} SECOND))
       WHERE id=?`,
      [
        JSON.stringify(asked),
        prepared,
        take || prepared ? 1 : 0,
        take
          ? JSON.stringify({
              scene: reply.photoScene,
              text: reply.photoText,
              place: reply.photoPlace,
            })
          : null,
        photoToken,
        photoToken,
        runId,
      ],
      connection,
    );
  });
  // Made outside the request: an image takes 20 to 30 seconds. The chat shows it's being taken.
  if (photoToken) void takeAskedPhoto(runId, photoToken);
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
/** Priced customers before the Charm guesses: what its formula needs to be worked out. */
export const FIRST_GUESS_AFTER = 3;
/** How long a guess waits for the owner's first formula to be worked out. */
const FORMULA_WAIT_MS = 90_000;
/** How long a guess waits for the customer's photos to be read. */
const READ_WAIT_MS = 30_000;
/** One guess per customer at a time, however many requests ask for it. */
const guessing = new Map<string, Promise<Shadow>>();

/**
 * The Charm's own price for a practice job, before it sees the owner's. Asked for as the owner
 * opens the quote form and again as their quote goes in, it's worked out once: a second request
 * waits on the first instead of paying for another.
 */
export function computeShadow(businessId: string, runId: string): Promise<Shadow> {
  let pending = guessing.get(runId);
  if (!pending) {
    pending = guessFor(businessId, runId).finally(() => guessing.delete(runId));
    guessing.set(runId, pending);
  }
  return pending;
}

/** A practice job's price the Charm doesn't give yet, and why. */
const withheld = (why: NonNullable<Shadow['withheld']>, toGo = 0): Shadow => ({
  decision: 'quote',
  reason: '',
  lines: [],
  discount: null,
  start: '',
  duration: '',
  confidence: 'low',
  reasoning: '',
  cents: 0,
  withheld: why,
  ...(toGo ? { toGo } : {}),
});

/**
 * Whether the owner has a formula to guess from. Their first takes a couple of minutes to work out
 * after their third quote, so this waits for it, a little. One that's a quote or a note behind is
 * fine: a guess comes from what the Charm knows so far, and a slow one only means no guess.
 */
async function formulaReady(businessId: string, data: PricingData) {
  const until = Date.now() + FORMULA_WAIT_MS;
  for (;;) {
    if (await currentFormula(businessId, data, { anyNotes: true })) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * The photos are read behind the chat, and the owner never waits on that. A guess goes on what was
 * read, as a live quote does, so it's the one thing that waits, out of their sight, and not for
 * long: a reading takes about 20 seconds, and one that stalled shouldn't hold up a guess.
 */
async function photosRead(runId: string) {
  const until = Date.now() + READ_WAIT_MS;
  for (;;) {
    const [run] = await rows(
      'SELECT (photo_read_until>UTC_TIMESTAMP(3)) AS held FROM practice_runs WHERE id=?',
      [runId],
    );
    if (!Number(run?.held) || Date.now() > until) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function guessFor(businessId: string, runId: string): Promise<Shadow> {
  await photosRead(runId);
  const run = await loadRun(businessId, runId);
  const existing = json<Shadow | null>(run.shadow_json, null);
  if (existing) return existing;
  if (run.status === 'finished')
    throw new ApiError(409, 'PRACTICE_CLOSED', 'This practice request is already done.');
  const all = await runMessages(runId);
  if (!run.outcome) assertIdle(run);
  // No guess until it comes from what this owner taught: a formula worked out from enough of
  // their own quotes. A stranger's guess on the first customers says nothing about them.
  const taught = await loadPricingData(businessId, { excludeRunId: runId });
  const examples = formulaExamples(taught.history).length;
  if (examples < FIRST_GUESS_AFTER) {
    const shadow = withheld('learning', FIRST_GUESS_AFTER - examples);
    await keepShadow(runId, shadow);
    return shadow;
  }
  if (aiMode !== 'demo' && !(await formulaReady(businessId, taught))) return withheld('working');
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  // Only the chat up to the owner's answer: it can be guessed after their quote goes in, but never
  // from it or from what the customer said back.
  const answered = all.findIndex((message) => message.kind !== 'text');
  const messages = (answered === -1 ? all : all.slice(0, answered)).filter(
    (message) => message.kind === 'text',
  );
  const readingAt = JSON.stringify(run.photo_reading_json ?? null);
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
      // Only the size the customer said. What the photos show comes from the Charm's reading of
      // them, as a live customer's does, never from what the pretend customer knows.
      spec: saidSpec(scenario, json<string[]>(run.asked_json, [])),
      // What it saw in the photos, with any fixes.
      media: practicePhotoNotes(run),
      images: aiMode === 'demo' ? [] : await runImages(businessId, runId, messages),
      history: { excludeRunId: runId },
      anyNotes: true,
      demo: aiMode === 'demo' ? await demo() : undefined,
    }),
  );
  // Not priced by the formula, like a service it hasn't seen priced: the AI's own guess is a
  // stranger's, so it isn't given.
  const shadow: Shadow =
    aiMode !== 'demo' && !engine?.formula
      ? withheld('service')
      : { ...drafted, cents: quoteTotal(drafted), engine };
  // A fix to the reading while this was drafting makes it again next time, from the fix.
  const [now] = await rows('SELECT photo_reading_json FROM practice_runs WHERE id=?', [runId]);
  if (JSON.stringify(now?.photo_reading_json ?? null) !== readingAt) return shadow;
  return keepShadow(runId, shadow);
}

/** Saves a guess unless one is already saved, and gives back the one that's kept. */
async function keepShadow(runId: string, shadow: Shadow): Promise<Shadow> {
  await mutate('UPDATE practice_runs SET shadow_json=? WHERE id=? AND shadow_json IS NULL', [
    JSON.stringify(shadow),
    runId,
  ]);
  const [saved] = await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [runId]);
  return json<Shadow>(saved.shadow_json, shadow);
}

/** What the owner asked this customer about, as "Asks about ___" reads it. */
function askedLabels(scenario: PracticeScenario, asked: string[]) {
  return [
    ...new Set(
      asked.flatMap((key) => {
        const fact = scenario.facts?.find((item) => item.key === key);
        // The AI sometimes writes the whole phrase, "Asks about the window count", as the label.
        const label = fact?.label.replace(/^\s*asks about\s+/i, '').trim();
        return label ? [label] : [];
      }),
    ),
  ];
}

async function insightsFor(
  businessId: string,
  runId: string,
  scenario: PracticeScenario,
  asked: string[],
  outcome: { quote: QuoteDraft } | { siteVisit: string },
  trade: string,
): Promise<Insight[]> {
  const labels = askedLabels(scenario, asked);
  const items: string[] = [];
  if (labels.length) items.push(`Asks about ${joinList(labels)}`);
  if ('quote' in outcome) {
    const quote = outcome.quote;
    if (!labels.length) items.push('Quotes straight from the photos when a job looks clear');
    const main = quote.lines[0];
    // With a size it's simple division, the same size the rate card reads: the size the owner
    // knew. The AI only words it when there's no size to divide by.
    const spec = knownSpec(scenario, asked);
    // A price at or under the least they've charged for this service is likely their minimum,
    // which says nothing about a rate, so it's said as it is. Other services' minimums can be
    // lower, so they're only used when this service has no other prices.
    const data = await loadPricingData(businessId, { excludeRunId: runId });
    const others = data.points;
    const { currency } = data.history.business;
    const money = (cents: number) => formatMoney(cents, currency);
    const service = scenario.serviceName.trim().toLowerCase();
    const sameService = others.filter((point) => point.service.trim().toLowerCase() === service);
    const compared = sameService.length ? sameService : others;
    const atMinimum =
      compared.length > 0 && main.amountCents <= Math.min(...compared.map((point) => point.cents));
    let rate = '';
    try {
      rate =
        aiMode === 'demo'
          ? demoRateLine(scenario, main.amountCents)
          : spec.quantity && spec.unit && atMinimum
            ? `Charges ${money(main.amountCents)} for ${lowerFirst(scenario.serviceName)}, ${formatQuantity(spec.quantity, spec.unit)}`
            : spec.quantity && spec.unit
              ? `${chargesLine(main.amountCents, spec.quantity, spec.unit, currency)} for ${lowerFirst(scenario.serviceName)}`
              : await withAiUsage(businessId, `practice:${runId}`, () =>
                  describeRate({
                    trade,
                    serviceName: scenario.serviceName,
                    mainLine: { label: main.label, amountCents: main.amountCents },
                    currency,
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
  asked: string[],
): Promise<PracticeMarket | null> {
  const spec = knownSpec(scenario, asked);
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

/** How long finishing a practice customer in the background holds it before it's tried again. */
const FINISH_SECONDS = 180;
/**
 * How long the formula waits for the owner to answer the question a practice quote asks, before
 * it's worked out without the answer. It's short because the next guess waits on the formula. An
 * answer after that works it out again, and moving on to the next customer ends the wait.
 */
const QUESTION_HOLD_MS = 20_000;

/**
 * The owner's answer, in at once with the customer's reply. What the Charm would have charged and
 * what it picked up follow in the background (completeRun), and the card waits for them, so
 * sending never waits on the guess.
 */
async function finishRun(
  businessId: string,
  runId: string,
  outcome: { quote: QuoteDraft } | { siteVisit: string },
) {
  let focus: string | null = null;
  const question = await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    openRun(run);
    focus = run.focus_service ?? null;
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
    await addMessage(
      connection,
      businessId,
      runId,
      'customer',
      'text',
      'quote' in outcome ? scenario.acceptReply : scenario.siteVisitReply,
      [],
      true,
    );
    await mutate(
      `UPDATE practice_runs SET finish_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${FINISH_SECONDS} SECOND) WHERE id=?`,
      [runId],
      connection,
    );
    // Once they've priced it, one question about how they price, while it's on their mind.
    return 'quote' in outcome ? pickQuestion(connection, businessId, runId) : null;
  });
  // Their answer changes their notes, so the formula waits for it and is worked out once for both.
  if (question) holdFormula(businessId, QUESTION_HOLD_MS);
  await keepNextCustomerReady(businessId, focus);
  void completeRun(businessId, runId).catch((error) =>
    reportError(error, { event: 'practice_finish' }),
  );
  return viewOf(businessId, runId);
}

/** One finish per customer at a time in this process. The lease covers other processes. */
const completing = new Map<string, Promise<void>>();

/**
 * The rest of a practice customer once the owner has answered: the Charm's guess, what it picked
 * up, then the customer counts as done. A restart part way through picks it up again.
 */
function completeRun(businessId: string, runId: string): Promise<void> {
  let pending = completing.get(runId);
  if (!pending) {
    pending = complete(businessId, runId).finally(() => completing.delete(runId));
    completing.set(runId, pending);
  }
  return pending;
}

/** How long what the Charm picked up waits for its guess, so the two can show together. */
const GUESS_HEAD_START_MS = 3000;

async function complete(businessId: string, runId: string) {
  // The AI's private guess only measures how close it gets, and it waits on the formula, so it can
  // take a while. Nobody waits for it: the owner can move on already, and what it picked up shows
  // without it. If it can't be made, this run just has no guess.
  const guess = computeShadow(businessId, runId).catch((error) => {
    if (!(error instanceof ApiError && error.code === 'PRACTICE_CLOSED'))
      reportError(error, { event: 'practice_guess' });
  });
  await Promise.race([guess, new Promise((resolve) => setTimeout(resolve, GUESS_HEAD_START_MS))]);
  const run = await loadRun(businessId, runId);
  if (run.status === 'finished' || !run.outcome) return;
  const context = await businessContext(businessId);
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const asked = json<string[]>(run.asked_json, []);
  const quote = json<Quote | null>(run.quote_json, null);
  const outcome: { quote: Quote } | { siteVisit: string } =
    run.outcome === 'quote' && quote
      ? { quote }
      : { siteVisit: String(run.site_visit_reason ?? '') };
  // A finish picked up again keeps what's already there, and anything the owner did to it.
  if (!run.insights_json) {
    const insights = await insightsFor(businessId, runId, scenario, asked, outcome, context.trade);
    const market =
      'quote' in outcome
        ? await marketBeside(businessId, context, scenario, outcome.quote, asked).catch((error) => {
            reportError(error, { event: 'practice_market' });
            return null;
          })
        : null;
    await mutate('UPDATE practice_runs SET insights_json=?,market_json=? WHERE id=?', [
      JSON.stringify(insights),
      market && JSON.stringify(market),
      runId,
    ]);
  }
  // Only now does the quote count, so the guess is always from before the owner's answer.
  await guess;
  await keepShadow(runId, withheld('working'));
  const [settled] = await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [runId]);
  // How close the Charm's own guess came to the owner's price: the moment it clicks, or doesn't.
  const guessed = json<Shadow | null>(settled.shadow_json, null);
  const priced = json<Quote | null>(run.quote_json, null);
  if (priced && guessed) {
    const ownerCents = quoteTotal(priced);
    const guess = guessed.withheld || guessed.decision === 'site_visit' ? null : guessed.cents;
    await recordEvent(
      undefined,
      businessId,
      'practice_guess_compared',
      {
        guess_cents: guess,
        owner_cents: ownerCents,
        gap_pct: guess === null ? null : gapPercent(guess, ownerCents),
        withheld: guessed.withheld ?? '',
        formula: Boolean(guessed.engine?.formula),
      },
      { ref: runId, value: ownerCents },
    ).catch(() => {});
  }
  await mutate(
    "UPDATE practice_runs SET status='finished',finished_at=UTC_TIMESTAMP(3),finish_until=NULL WHERE id=?",
    [runId],
  );
  refreshFormula(businessId);
  await kickPreparation(businessId);
}

/** Customers answered but not done, whose finish stopped, as at a restart: finished again. */
async function resumeFinishing(businessId: string, runs: Row[]) {
  for (const run of runs) {
    if (!run.outcome || run.status === 'finished') continue;
    if (run.finish_until && new Date(run.finish_until) > new Date()) continue;
    await mutate(
      `UPDATE practice_runs SET finish_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${FINISH_SECONDS} SECOND) WHERE id=?`,
      [run.id],
    );
    void completeRun(businessId, String(run.id)).catch((error) =>
      reportError(error, { event: 'practice_finish' }),
    );
  }
}

export async function sendPracticeQuote(businessId: string, runId: string, body: unknown) {
  const quote = quoteDraftSchema.parse(body);
  const run = await loadRun(businessId, runId);
  if (!run.outcome) assertIdle(run);
  return finishRun(businessId, runId, { quote });
}

/** The owner's fix to what their Charm saw in this customer's photos. */
export async function fixPhotoReading(
  businessId: string,
  runId: string,
  fixes: { counts?: Record<string, number>; area?: number | null; note?: string },
) {
  await fixPracticeReading(businessId, runId, fixes);
  return viewOf(businessId, runId);
}

/** Why the owner turns a job down: a rule the live chat follows, or the least they charge. */
export const declineInput = z.union([
  ruleInput,
  z
    .object({
      kind: z.literal('minimum'),
      minimumCents: z.number().int().min(100).max(100_000_000),
    })
    .strict(),
]);
export type DeclineInput = z.infer<typeof declineInput>;

/**
 * The owner turns this customer down. It saves the rule they chose, or their minimum for a job
 * that's too small, and the customer says no worries. There's no price, so the guess isn't held
 * to anything and the score stays as it was, but it's a finished customer: the next one comes.
 */
export async function declinePracticeRun(businessId: string, runId: string, body: unknown) {
  const input = declineInput.parse(body);
  const scenario = await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    openRun(run);
    // Not while a photo is still being taken, as for a reply or a quote.
    assertIdle(run);
    let saved: SavedTurnDown;
    if (input.kind === 'minimum') {
      await setMinimum(businessId, input.minimumCents, connection);
      saved = { reason: 'too_small', minimumCents: input.minimumCents };
    } else
      saved = {
        reason: input.kind,
        ruleId: await addTurnDown(connection, businessId, input, runId),
      };
    await mutate(
      "UPDATE practice_runs SET outcome='declined',turn_down_json=? WHERE id=?",
      [JSON.stringify(saved), runId],
      connection,
    );
    await addMessage(connection, businessId, runId, 'owner', 'declined', saved.reason);
    return json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  });
  const [run] = await rows('SELECT asked_json,focus_service FROM practice_runs WHERE id=?', [
    runId,
  ]);
  const labels = askedLabels(scenario, json<string[]>(run.asked_json, []));
  const insights = labels.length
    ? [{ id: `${runId.slice(0, 8)}-0`, text: `Asks about ${joinList(labels)}` }]
    : [];
  await transaction(async (connection) => {
    await addMessage(
      connection,
      businessId,
      runId,
      'customer',
      'text',
      scenario.declineReply?.trim() || DECLINE_REPLY,
    );
    await mutate(
      "UPDATE practice_runs SET insights_json=?,status='finished',finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [JSON.stringify(insights), runId],
      connection,
    );
  });
  await keepNextCustomerReady(businessId, run.focus_service ?? null);
  return viewOf(businessId, runId);
}

const distanceSchema = z.object({ value: z.number().positive(), unit: z.enum(['mi', 'km']) });

/**
 * What the "Why not?" sheet fills in from this customer: the job's size, the service and the
 * extras on it, and how far away they are. The size is only shown once the owner turns them down.
 */
export async function declinePrefill(businessId: string, runId: string) {
  const run = await loadRun(businessId, runId);
  openRun(run);
  const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
  const spec = knownSpec(scenario, json<string[]>(run.asked_json, []));
  const written = scenario as PracticeScenario & {
    distance?: unknown;
    customer?: { distance?: unknown };
  };
  const distance = distanceSchema.safeParse(written.distance ?? written.customer?.distance);
  return {
    size: spec.quantity && spec.unit ? { quantity: spec.quantity, unit: spec.unit } : null,
    service: scenario.serviceName ?? '',
    // The first suggestion is the main work. The rest are the extras on this job.
    extras: (scenario.suggestions ?? []).slice(1, 5),
    distance: distance.success ? distance.data : null,
  };
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

/**
 * Why the owner priced a practice quote the way they did, added after they sent it: a tree that
 * needed a climber, a repeat customer, a long drive. It's saved on the quote, where the formula and
 * the drafts read it with that job, and shows on the card as what the Charm remembers.
 */
export async function explainPracticeQuote(businessId: string, runId: string, text: string) {
  await transaction(async (connection) => {
    const run = await loadRun(businessId, runId, connection, true);
    const quote = json<Quote | null>(run.quote_json, null);
    if (run.outcome !== 'quote' || !quote)
      throw new ApiError(409, 'PRACTICE_NOT_QUOTED', 'Only a quote you sent can have a reason.');
    const insights = json<(Insight & { edited?: boolean })[]>(run.insights_json, []).filter(
      (item) => item.id !== 'why',
    );
    insights.push({ id: 'why', text: `Remembers why: “${text}”` });
    await mutate(
      'UPDATE practice_runs SET quote_json=?,insights_json=? WHERE id=?',
      [JSON.stringify({ ...quote, note: text }), JSON.stringify(insights), runId],
      connection,
    );
  });
  // The quote it learns from changed, so the formula is worked out again in the background.
  refreshFormula(businessId);
  return viewOf(businessId, runId);
}

/** The owner's answer to the question a practice quote asked, or their skip. */
export async function answerPracticeQuestion(
  businessId: string,
  runId: string,
  reply: { answer: string } | { skip: true },
) {
  await transaction(async (connection) => {
    await loadRun(businessId, runId, connection, true);
    await answerQuestion(connection, businessId, runId, reply);
  });
  // The formula waited for this, and is worked out now with the answer.
  if (!releaseFormula(businessId)) refreshFormula(businessId);
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
  await prepareNow(businessId, runId);
}
