import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tradeName } from '@pricecharm/trades';
import { aiMode, aiProvider } from '../ai/index.js';
import {
  measurePhotos,
  type ReadingProgress,
  type ReportProgress,
  type Walkaround,
} from '../ai/walkaround.js';
import { mutate, rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { recordEvent } from '../metrics.js';
import { json, type Row } from '../models.js';
import { getPhoto, putPhoto } from '../storage.js';
import { withAiUsage, withCustomerAiUsage } from '../usage.js';
import type { Asker } from './chat.js';
import { priceUnits } from './videos.js';

/**
 * The customer's photos, read like a walk-around video (src/ai/walkaround.ts): what's in them,
 * counted, and the state and quality of what matters for the price. Like a video, it runs outside
 * the request: the chat shows it's looking, and the assistant carries on once it's done. It reads
 * all of the chat's photos together, again whenever another comes in, so two photos of the same
 * window count it once.
 */
type Stored = { photoIds: string[]; result: Walkaround | null; failure: string };

/** How long one reading may hold a chat before another may pick it up. */
const LEASE_SECONDS = 300;
/** A reading covers this many of the chat's photos, the first ones sent. */
const PHOTOS_READ = 3;

/** Photos are read where SAM 3.1 runs: on Meta, or the labelled demo reading. */
export const photoReadingsAvailable = () => aiProvider === 'meta' || aiMode === 'demo';

async function chatPhotos(businessId: string, chatId: string) {
  return rows(
    `SELECT id,storage_key FROM attachments WHERE business_id=? AND conversation_id=? ORDER BY created_at,id LIMIT ${PHOTOS_READ}`,
    [businessId, chatId],
  );
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, at) => id === b[at]);

/** The chat's photos when some of them aren't read yet, or null when every one is. */
async function unreadPhotos(chat: Row) {
  const photos = await chatPhotos(String(chat.business_id), String(chat.id));
  const photoIds = photos.map((photo) => String(photo.id));
  if (!photoIds.length) return null;
  const readIds = json<Stored | null>(chat.photo_reading_json, null)?.photoIds ?? [];
  return same(readIds, photoIds) ? null : photos;
}

/**
 * Where a reading and its lease are kept: a customer's chat, or a practice customer
 * (src/practice/photos.ts). Both have the same photo_read_* columns.
 */
export type ReadingTable = 'lead_chats' | 'practice_runs';

/** Holds the photos for one reading, wherever it runs: the API or the worker. */
export async function claimReading(
  table: ReadingTable,
  id: string,
  seconds = LEASE_SECONDS,
): Promise<string | null> {
  const token = randomUUID();
  const claimed = await mutate(
    `UPDATE ${table} SET photo_read_token=?,photo_read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ${Math.round(seconds)} SECOND)
     WHERE id=? AND (photo_read_until IS NULL OR photo_read_until<UTC_TIMESTAMP(3))`,
    [token, id],
  );
  return claimed.affectedRows ? token : null;
}
const claim = (chatId: string) => claimReading('lead_chats', chatId);

/** Saves how far the reading holding the photos has got, so the chat can show it. */
export function readingProgress(table: ReadingTable, id: string, token: string): ReportProgress {
  const shown: ReadingProgress = { step: 'watching' };
  return async (update) => {
    Object.assign(shown, update);
    await mutate(`UPDATE ${table} SET photo_progress_json=? WHERE id=? AND photo_read_token=?`, [
      JSON.stringify(shown),
      id,
      token,
    ]).catch(() => {});
  };
}
const progressFor = (chatId: string, token: string) => readingProgress('lead_chats', chatId, token);

/** How far the chat's photo reading has got, while one holds it. */
export function photoProgress(chat: Row): ReadingProgress | null {
  return json<ReadingProgress | null>(chat.photo_progress_json, null);
}

/** Lets go of the photos once the reading is done, or has failed. */
export async function releaseReading(table: ReadingTable, id: string, token: string) {
  await mutate(
    `UPDATE ${table} SET photo_read_token=NULL,photo_read_until=NULL,photo_progress_json=NULL WHERE id=? AND photo_read_token=?`,
    [id, token],
  );
}
const release = (chatId: string, token: string) => releaseReading('lead_chats', chatId, token);

/**
 * Stored photos read for a business's service, the same way a customer's chat has them read.
 * The photos are attachments rows (id and storage_key), oldest first.
 */
export async function measureStoredPhotos(input: {
  business: Row;
  serviceName: string;
  photos: Row[];
  progress: ReportProgress;
  /** Keeps a photo with what was counted drawn on, and returns its storage key. */
  saveOverlay?: (jpeg: Buffer) => Promise<string>;
}): Promise<Walkaround> {
  const businessId = String(input.business.id);
  const services = (
    await rows('SELECT name FROM offerings WHERE business_id=? ORDER BY position', [businessId])
  ).map((row) => String(row.name));
  return measurePhotos({
    business: {
      name: String(input.business.name),
      trade: tradeName(input.business.trade_id, input.business.custom_trade),
      services,
    },
    serviceName: input.serviceName,
    priceUnits: await priceUnits(businessId),
    progress: input.progress,
    photos: await Promise.all(
      input.photos.map(async (photo) => ({
        id: String(photo.id),
        image: {
          mimeType: 'image/jpeg',
          dataBase64: (await getPhoto(String(photo.storage_key))).toString('base64'),
        },
      })),
    ),
    saveOverlay:
      input.saveOverlay ??
      (async (jpeg) => {
        const key = `${randomUUID()}.jpg`;
        await putPhoto(key, jpeg);
        return key;
      }),
  });
}

/** Reads the chat's photos if some aren't read yet. Says whether it read them. */
async function readOnce(ip: string, chatId: string, progress: ReportProgress): Promise<boolean> {
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [chatId]);
  if (!chat) return false;
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [chat.business_id]);
  if (!business) return false;
  const businessId = String(business.id);
  const photos = await unreadPhotos(chat);
  if (!photos) return false;
  const photoIds = photos.map((photo) => String(photo.id));
  // Each pass starts over: it reads all the chat's photos again.
  await progress({ step: 'watching', seen: undefined, counting: undefined, found: undefined });
  let stored: Stored;
  try {
    const task = () =>
      measureStoredPhotos({ business, serviceName: String(chat.service_name), photos, progress });
    const result =
      chat.source === 'test'
        ? await withAiUsage(businessId, chatId, task)
        : await withCustomerAiUsage({ businessId, sessionId: chatId, ip }, task);
    stored = { photoIds, result, failure: '' };
    await recordEvent(
      undefined,
      businessId,
      'photos_read',
      {
        photos: photoIds.length,
        counts: result.counts.length,
        counted: result.counts.reduce((sum, item) => sum + item.count, 0),
        graded: result.counts.filter((item) => item.kinds?.length).length,
        findings: result.findings?.length ?? 0,
      },
      { ref: chatId },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'photo_read' });
    stored = {
      photoIds,
      // What the earlier photos showed still stands.
      result: json<Stored | null>(chat.photo_reading_json, null)?.result ?? null,
      failure:
        error instanceof ApiError ? error.message.slice(0, 300) : 'We couldn’t read these photos.',
    };
  }
  await mutate('UPDATE lead_chats SET photo_reading_json=? WHERE id=?', [
    JSON.stringify(stored),
    chatId,
  ]);
  return true;
}

/**
 * Reads the chat's photos that aren't read yet, then, if it read any, runs `then` (the assistant
 * carrying on from them) while still holding the chat, so the chat shows it's looking until the
 * answer is in. Safe to call as often as you like: only one runs per chat, and a photo that comes
 * in meanwhile is read before it lets go. Says whether it read anything.
 */
export async function readPhotos(
  asker: Asker,
  chatId: string,
  then?: () => Promise<void>,
): Promise<boolean> {
  if (!photoReadingsAvailable()) return false;
  // Taken now: by the time a reading runs, the request that started it may be gone.
  const ip = String(asker.ip || asker.socket?.remoteAddress || 'unknown');
  const token = await claim(chatId);
  if (!token) return false;
  let read = false;
  const progress = progressFor(chatId, token);
  try {
    for (let pass = 0; pass < PHOTOS_READ && (await readOnce(ip, chatId, progress)); pass++)
      read = true;
    if (read && then) {
      await progress({ step: 'replying' });
      await then();
    }
  } catch (error) {
    reportError(error, { event: 'photo_read' });
  } finally {
    await release(chatId, token);
  }
  return read;
}

/** Whether a reading holds the chat's photos, and whether some of them aren't read yet. */
async function photoState(chat: Row) {
  const [lease] = await rows(
    'SELECT photo_read_until>UTC_TIMESTAMP(3) AS held FROM lead_chats WHERE id=?',
    [chat.id],
  );
  return { held: Boolean(Number(lease?.held)), unread: (await unreadPhotos(chat)) !== null };
}

/** Whether the chat is waiting on its photos: some aren't read yet, or the Charm hasn't answered. */
export async function readingPhotos(chat: Row): Promise<boolean> {
  if (!photoReadingsAvailable()) return false;
  const { held, unread } = await photoState(chat);
  return held || unread;
}

/** Whether the chat has photos no reading has picked up, as when a restart cut one short. */
export async function photosLeftUnread(chat: Row): Promise<boolean> {
  if (!photoReadingsAvailable()) return false;
  const { held, unread } = await photoState(chat);
  return !held && unread;
}

/** What was read in the chat's photos, or null when nothing has been. */
export function photoReading(chat: Row): Walkaround | null {
  return json<Stored | null>(chat.photo_reading_json, null)?.result ?? null;
}

/** What the owner sees of the chat's photos: what was found, and the photos it was drawn on. */
export async function ownerPhotoReading(businessId: string, chatId: string, quoteId: string) {
  const [chat] = await rows(
    'SELECT photo_reading_json FROM lead_chats WHERE id=? AND business_id=?',
    [chatId, businessId],
  );
  const stored = json<Stored | null>(chat?.photo_reading_json, null);
  if (!stored) return null;
  const result = stored.result;
  return {
    status: result ? 'measured' : 'failed',
    failure: stored.failure,
    summary: result?.summary ?? '',
    counts: result?.counts ?? [],
    area: result?.area ?? null,
    material: result?.material ?? '',
    findings: result?.findings ?? [],
    overlays: (result?.overlays ?? []).map((overlay, index) => ({
      label: overlay.label,
      url: `/api/v1/app/quotes/${quoteId}/photo-overlays/${index}`,
    })),
  };
}

/** A photo with what was counted drawn on, for the owner. */
export async function photoOverlayFile(businessId: string, quoteId: string, index: number) {
  const [quote] = await rows(
    `SELECT c.photo_reading_json FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.id=? AND q.business_id=?`,
    [z.uuid().parse(quoteId), businessId],
  );
  const overlay = json<Stored | null>(quote?.photo_reading_json, null)?.result?.overlays[index];
  if (!overlay) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
  return getPhoto(overlay.storageKey);
}
