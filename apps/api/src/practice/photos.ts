import { randomUUID } from 'node:crypto';
import { aiMode } from '../ai/index.js';
import { countWords, type ReadingProgress, type Walkaround } from '../ai/walkaround.js';
import { mutate, rows, transaction } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import {
  claimReading,
  measureStoredPhotos,
  photoReadingsAvailable,
  readingProgress,
  releaseReading,
} from '../live/photo-readings.js';
import { recordEvent } from '../metrics.js';
import { json, type Row } from '../models.js';
import { photoUrl } from '../past-jobs.js';
import { putPhoto } from '../storage.js';
import { withAiUsage } from '../usage.js';
import { demoPhotoReading } from './demo.js';
import {
  noFixes,
  ownerReading,
  readingNotes,
  reconcileScenario,
  type PhotoFixes,
} from './photo-facts.js';
import type { PracticeScenario } from './types.js';

/**
 * What the Charm saw in a practice customer's photos. The same reader as a customer's chat
 * (src/live/photo-readings.ts) reads the photos sent with the opener, outside the request, with a
 * lease and a status the chat shows, and the chat goes on once it's done. The customer's size and
 * counts then take what it found, so their answers match their photos. The owner can fix a count,
 * the size or add a note: the fix is kept as labeled photo data, goes into the customer's facts,
 * and is what the Charm's guess on this customer reads.
 */
export type StoredReading = {
  photoIds: string[];
  result: Walkaround | null;
  failure: string;
  /** Photos with what was counted drawn on, kept as the business's own photos. */
  drawn?: { label: string; photoId: string }[];
  fixes?: PhotoFixes;
};

/** How long one reading may hold a practice customer before another may pick it up. */
export const READ_SECONDS = 180;

/** The photos the customer opened with, which are the ones read. */
export function openerPhotoIds(messages: Row[]): string[] {
  const opener = messages.find((message) => message.sender === 'customer');
  return opener ? json<string[]>(opener.photo_ids_json, []) : [];
}

/** Whether this customer's photos are still to be read, which goes on behind the chat. */
export function photosUnread(run: Row, messages: Row[]): boolean {
  if (!photoReadingsAvailable() || run.status !== 'ready' || run.outcome) return false;
  if (run.photo_reading_json) return false;
  return openerPhotoIds(messages).length > 0;
}

/** Whether a reading holds this customer, or one is still to start. Reads photo_read_held. */
export function readingPhotos(run: Row, messages: Row[]): boolean {
  return Boolean(Number(run.photo_read_held)) || photosUnread(run, messages);
}

/** Columns for a run, with whether a reading's lease is still good, worked out by the database. */
export const RUN_COLUMNS = '*,(photo_read_until>UTC_TIMESTAMP(3)) AS photo_read_held';

/** Holds this customer's photos for one reading. Null when another reading has them. */
export const claimPracticeReading = (runId: string) =>
  claimReading('practice_runs', runId, READ_SECONDS);

/**
 * Reads the customer's opening photos while holding them, then squares their facts with what was
 * found. Never throws: a reading that fails says so on the card and the chat goes on.
 */
export async function readPracticePhotos(runId: string, token: string): Promise<void> {
  const progress = readingProgress('practice_runs', runId, token);
  try {
    const [run] = await rows('SELECT * FROM practice_runs WHERE id=? AND photo_read_token=?', [
      runId,
      token,
    ]);
    if (!run) return;
    const businessId = String(run.business_id);
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const photoIds = openerPhotoIds(
      await rows(
        "SELECT sender,photo_ids_json FROM practice_messages WHERE run_id=? AND sender='customer' ORDER BY created_at,id LIMIT 1",
        [runId],
      ),
    );
    if (!photoIds.length) return;
    const found = await rows(
      `SELECT id,storage_key FROM attachments WHERE business_id=? AND id IN (${photoIds.map(() => '?').join(',')})`,
      [businessId, ...photoIds],
    );
    const photos = photoIds.flatMap((id) => found.filter((photo) => photo.id === id));
    let stored: StoredReading;
    try {
      const drawn: { key: string; photoId: string }[] = [];
      const result =
        aiMode === 'demo'
          ? demoPhotoReading(scenario)
          : await withAiUsage(businessId, `practice-read:${runId}`, async () => {
              const [business] = await rows('SELECT * FROM businesses WHERE id=?', [businessId]);
              return measureStoredPhotos({
                business,
                serviceName: scenario.serviceName,
                photos,
                progress,
                // Kept as the business's own photos, so they go when the business does.
                saveOverlay: async (jpeg) => {
                  const id = randomUUID(),
                    key = `${id}.jpg`;
                  await putPhoto(key, jpeg);
                  await mutate(
                    "INSERT INTO attachments (id,business_id,conversation_id,purpose,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,'practice_overlay','counted.jpg','image/jpeg',?,0,0,?)",
                    [id, businessId, runId, key, jpeg.length],
                  );
                  drawn.push({ key, photoId: id });
                  return key;
                },
              });
            });
      stored = {
        photoIds,
        result: { ...result, overlays: [] },
        failure: '',
        drawn: result.overlays.flatMap((overlay) => {
          const photo = drawn.find((item) => item.key === overlay.storageKey);
          return photo ? [{ label: overlay.label, photoId: photo.photoId }] : [];
        }),
      };
    } catch (error) {
      if (!(error instanceof ApiError)) reportError(error, { event: 'practice_photo_read' });
      stored = {
        photoIds,
        result: null,
        failure:
          error instanceof ApiError
            ? error.message.slice(0, 300)
            : 'It couldn’t read these photos.',
      };
    }
    const changes = await saveReading(runId, token, stored);
    await recordEvent(
      undefined,
      businessId,
      'practice_photos_read',
      {
        photos: photoIds.length,
        read: Boolean(stored.result),
        counts: stored.result?.counts.length ?? 0,
        reconciled: changes.length,
      },
      { ref: runId },
    );
  } catch (error) {
    reportError(error, { event: 'practice_photo_read' });
  } finally {
    await releaseReading('practice_runs', runId, token);
  }
}

/** Saves the reading, with the customer's facts squared with it, while the lease still holds. */
async function saveReading(runId: string, token: string, stored: StoredReading) {
  return transaction(async (connection) => {
    const [run] = await rows(
      'SELECT scenario_json,photo_read_token FROM practice_runs WHERE id=? FOR UPDATE',
      [runId],
      connection,
    );
    if (run?.photo_read_token !== token) return [];
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const reconciled = stored.result
      ? reconcileScenario(scenario, stored.result)
      : { scenario, changes: [] };
    await mutate(
      'UPDATE practice_runs SET photo_reading_json=?,scenario_json=? WHERE id=?',
      [JSON.stringify(stored), JSON.stringify(reconciled.scenario), runId],
      connection,
    );
    return reconciled.changes;
  });
}

/** Reads, outside the request, the photos of this business's customers that are waiting on it. */
export async function resumePhotoReadings(businessId: string) {
  if (!photoReadingsAvailable()) return;
  const waiting = await rows(
    `SELECT id FROM practice_runs WHERE business_id=? AND status='ready' AND outcome IS NULL
     AND photo_reading_json IS NULL AND (photo_read_until IS NULL OR photo_read_until<UTC_TIMESTAMP(3))`,
    [businessId],
  );
  for (const run of waiting) {
    const messages = await rows(
      'SELECT sender,photo_ids_json FROM practice_messages WHERE run_id=? ORDER BY created_at,id',
      [run.id],
    );
    if (!photosUnread({ ...run, status: 'ready', photo_reading_json: null }, messages)) continue;
    const token = await claimPracticeReading(String(run.id));
    if (token)
      void readPracticePhotos(String(run.id), token).catch((error) =>
        reportError(error, { event: 'practice_photo_read' }),
      );
  }
}

/** What the Charm's guess reads about the photos, fixes and note included. */
export function practicePhotoNotes(run: Row): string[] {
  const stored = json<StoredReading | null>(run.photo_reading_json, null);
  return stored?.result ? readingNotes(stored.result, stored.fixes) : [];
}

/** The card under the customer's photos: reading, read with what it saw, or couldn't read them. */
export function photoReadingView(run: Row, messages: Row[]) {
  const stored = json<StoredReading | null>(run.photo_reading_json, null);
  if (readingPhotos(run, messages))
    return {
      status: 'reading' as const,
      photoIds: openerPhotoIds(messages),
      progress: json<ReadingProgress | null>(run.photo_progress_json, null),
    };
  if (!stored) return null;
  if (!stored.result)
    return { status: 'failed' as const, photoIds: stored.photoIds, failure: stored.failure };
  const fixes = stored.fixes ?? noFixes();
  const read = stored.result;
  return {
    status: 'read' as const,
    photoIds: stored.photoIds,
    summary: read.summary,
    counts: read.counts
      .filter((item) => item.count > 0 || item.label in fixes.counts)
      .map((item) => ({
        label: item.label,
        unit: item.unit,
        count: fixes.counts[item.label] ?? item.count,
        read: item.count,
        atLeast: !(item.label in fixes.counts) && Boolean(item.atLeast),
        kinds: item.label in fixes.counts ? [] : (item.kinds ?? []),
        fixed: item.label in fixes.counts,
      })),
    area: read.area
      ? {
          surface: read.area.surface,
          unit: read.area.unit,
          low: fixes.area ?? read.area.low,
          high: fixes.area ?? read.area.high,
          fixed: fixes.area !== null,
        }
      : null,
    details: [
      read.material ?? '',
      read.condition,
      read.access,
      ...(read.findings ?? []).map((finding) =>
        finding.detail ? `${finding.what}: ${finding.detail}` : finding.what,
      ),
    ].filter((item) => item.trim()),
    note: fixes.note,
    found: countWords(read.counts),
    drawn: (stored.drawn ?? []).map((item) => ({ label: item.label, url: photoUrl(item.photoId) })),
  };
}
export type PhotoReadingView = ReturnType<typeof photoReadingView>;

/**
 * The owner's fixes to what their Charm saw. Each change is kept as labeled photo data. A count or
 * size the customer's facts give takes the owner's number, and the Charm's guess, if one was made,
 * is made again from the fixed reading.
 */
export async function fixPracticeReading(
  businessId: string,
  runId: string,
  input: { counts?: Record<string, number>; area?: number | null; note?: string },
) {
  await transaction(async (connection) => {
    const [run] = await rows(
      'SELECT * FROM practice_runs WHERE id=? AND business_id=? FOR UPDATE',
      [runId, businessId],
      connection,
    );
    if (!run) throw new ApiError(404, 'PRACTICE_NOT_FOUND', 'This practice customer isn’t here.');
    if (run.status !== 'ready' || run.outcome)
      throw new ApiError(409, 'PRACTICE_CLOSED', 'This practice request is already done.');
    const stored = json<StoredReading | null>(run.photo_reading_json, null);
    const read = stored?.result;
    if (!stored || !read)
      throw new ApiError(409, 'PRACTICE_NOT_READ', 'There’s nothing read in these photos to fix.');
    const before = stored.fixes ?? noFixes();
    const fixes: PhotoFixes = {
      counts: { ...before.counts },
      area: before.area,
      note: input.note === undefined ? before.note : input.note.trim(),
    };
    for (const [label, count] of Object.entries(input.counts ?? {})) {
      const item = read.counts.find((entry) => entry.label === label);
      if (!item) throw new ApiError(422, 'PHOTO_COUNT', 'That count isn’t in what it saw.');
      if (count === item.count) delete fixes.counts[label];
      else fixes.counts[label] = count;
    }
    if (input.area !== undefined) {
      if (input.area !== null && !read.area)
        throw new ApiError(422, 'PHOTO_AREA', 'It didn’t size anything in these photos.');
      const unchanged =
        input.area === null ||
        (read.area && read.area.low === read.area.high && read.area.low === input.area);
      fixes.area = unchanged ? null : input.area;
    }
    const labels = [
      ...read.counts
        .filter(
          (item) => (before.counts[item.label] ?? null) !== (fixes.counts[item.label] ?? null),
        )
        .map((item) => ({
          kind: 'count',
          name: item.label,
          unit: item.unit,
          read: item.count,
          fixed: fixes.counts[item.label] ?? item.count,
          readText: '',
          fixedText: '',
        })),
      ...(read.area && before.area !== fixes.area
        ? [
            {
              kind: 'area',
              name: read.area.surface,
              unit: read.area.unit,
              read: (read.area.low + read.area.high) / 2,
              fixed: fixes.area ?? (read.area.low + read.area.high) / 2,
              readText: '',
              fixedText: '',
            },
          ]
        : []),
      ...(before.note !== fixes.note
        ? [
            {
              kind: 'note',
              name: '',
              unit: '',
              read: null,
              fixed: null,
              readText: read.summary.slice(0, 600),
              fixedText: fixes.note.slice(0, 600),
            },
          ]
        : []),
    ];
    if (!labels.length) return;
    const scenario = json<PracticeScenario>(run.scenario_json, {} as PracticeScenario);
    const next = reconcileScenario(scenario, ownerReading(read, fixes), { exact: true }).scenario;
    // The guess goes again from the fixed reading when the owner next opens the quote builder.
    await mutate(
      'UPDATE practice_runs SET photo_reading_json=?,scenario_json=?,shadow_json=NULL WHERE id=?',
      [JSON.stringify({ ...stored, fixes }), JSON.stringify(next), runId],
      connection,
    );
    const [business] = await rows(
      'SELECT trade_id FROM businesses WHERE id=?',
      [businessId],
      connection,
    );
    for (const label of labels)
      await mutate(
        'INSERT INTO photo_labels (id,business_id,run_id,trade_id,service_name,photo_ids_json,kind,name,unit,read_value,fixed_value,read_text,fixed_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          randomUUID(),
          businessId,
          runId,
          business?.trade_id ?? null,
          scenario.serviceName.slice(0, 120),
          JSON.stringify(stored.photoIds),
          label.kind,
          label.name.slice(0, 80),
          label.unit.slice(0, 20),
          label.read,
          label.fixed,
          label.readText,
          label.fixedText,
        ],
        connection,
      );
  });
}
