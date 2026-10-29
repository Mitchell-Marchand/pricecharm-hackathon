import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { tradeName } from '@pricecharm/trades';
import { aiMode, type AiImage } from '../ai/index.js';
import { deleteMetaFile, uploadMetaFile } from '../ai/meta-media.js';
import { measureWalkaround, type Walkaround } from '../ai/walkaround.js';
import { mutate, rows, transaction } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { recordEvent } from '../metrics.js';
import { json, type Row } from '../models.js';
import { fitRates } from '../pricing/rates.js';
import { loadPricingData } from '../pricing/history.js';
import { deletePhoto, getPhoto, putPhoto } from '../storage.js';
import { imageKind } from '../uploads.js';
import { withAiUsage, withCustomerAiUsage } from '../usage.js';
import { addMessage, continueAfterVideo, type Asker } from './chat.js';

/**
 * Customers' walk-around videos. One comes in with a few stills the customer's browser took from
 * it, is saved, and is measured outside the request (it takes longer than a request may wait).
 * The chat shows it as measuring until then, and the assistant carries on once it's done.
 */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_STILLS = 6;
const VIDEOS_PER_CHAT = 2;
const MEASURE_ATTEMPTS = 2;

export const videoUpload: RequestHandler = (req, res, next) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 + MAX_STILLS, fields: 4, parts: 12 },
    fileFilter: (_req, file, callback) => {
      if (file.fieldname === 'video' && ['video/mp4', 'video/quicktime'].includes(file.mimetype))
        return callback(null, true);
      if (file.fieldname === 'stills' && ['image/jpeg', 'image/webp'].includes(file.mimetype))
        return callback(null, true);
      callback(new ApiError(415, 'UNSUPPORTED_VIDEO', 'Send an MP4 or MOV video.'));
    },
  }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'stills', maxCount: MAX_STILLS },
  ])(req, res, (error) => {
    if (error instanceof multer.MulterError)
      return next(
        new ApiError(413, 'UPLOAD_LIMIT', 'Send a video under 100 MB, about a minute long.'),
      );
    next(error);
  });

/** MP4 and MOV files open with a box such as "ftyp", "moov" or "wide" four bytes in. */
export function videoKind(bytes: Buffer): 'mp4' | 'mov' | null {
  if (bytes.length < 12) return null;
  const box = bytes.toString('ascii', 4, 8);
  if (box === 'ftyp') return bytes.toString('ascii', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
  return ['moov', 'wide', 'mdat', 'free'].includes(box) ? 'mov' : null;
}

const uploadFields = z.object({
  durationMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 60_000)
    .optional(),
  // Where in the video each still was taken, in the order they were sent.
  stillTimes: z
    .string()
    .max(200)
    .optional()
    .transform((value) => z.array(z.number().int().min(0)).parse(JSON.parse(value || '[]'))),
});

export type StoredStill = { key: string; ms: number };

/** Saves the video and its stills, and posts it in the chat. Measuring starts afterwards. */
export async function saveVideo(req: Request, business: Row, chat: Row): Promise<string> {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const video = files?.video?.[0];
  if (!video) throw new ApiError(400, 'FILE_REQUIRED', 'Choose a video to send.');
  const kind = videoKind(video.buffer);
  if (!kind) throw new ApiError(422, 'INVALID_VIDEO', 'That file isn’t a video we can read.');
  const fields = uploadFields.parse(req.body);
  const stills: StoredStill[] = [];
  for (const [index, file] of (files?.stills ?? []).entries()) {
    if (!imageKind(file.buffer)) continue;
    const jpeg = await sharp(file.buffer, { limitInputPixels: 16_000_000, animated: false })
      .rotate()
      .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer()
      .catch(() => null);
    if (!jpeg) continue;
    const key = `${randomUUID()}.jpg`;
    await putPhoto(key, jpeg);
    stills.push({ key, ms: fields.stillTimes[index] ?? 0 });
  }
  const id = randomUUID(),
    storageKey = `${id}.${kind}`;
  await putPhoto(storageKey, video.buffer);
  try {
    await transaction(async (connection) => {
      await rows('SELECT id FROM lead_chats WHERE id=? FOR UPDATE', [chat.id], connection);
      const [count] = await rows(
        'SELECT COUNT(*) AS count FROM lead_videos WHERE chat_id=?',
        [chat.id],
        connection,
      );
      if (Number(count.count) >= VIDEOS_PER_CHAT)
        throw new ApiError(422, 'VIDEO_LIMIT', 'You can send two videos in one request.');
      await mutate(
        'INSERT INTO lead_videos (id,business_id,chat_id,storage_key,mime_type,byte_size,duration_ms,frames_json,requester_ip) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          id,
          business.id,
          chat.id,
          storageKey,
          kind === 'mov' ? 'video/quicktime' : 'video/mp4',
          video.size,
          fields.durationMs ?? null,
          JSON.stringify(stills),
          String(req.ip || req.socket.remoteAddress || '').slice(0, 64),
        ],
        connection,
      );
      await addMessage(connection, {
        businessId: String(business.id),
        chatId: String(chat.id),
        sender: 'customer',
        text: '',
        videoId: id,
      });
    });
  } catch (error) {
    await deletePhoto(storageKey).catch(() => {});
    for (const still of stills) await deletePhoto(still.key).catch(() => {});
    throw error;
  }
  return id;
}

/** The units this owner prices each service by, from their own past prices. */
async function priceUnits(businessId: string) {
  const units: Record<string, string[]> = {};
  for (const rate of fitRates((await loadPricingData(businessId)).points))
    (units[rate.service.trim().toLowerCase()] ??= []).push(rate.unit);
  return units;
}

/**
 * Measures one saved video, then lets the chat carry on. Safe to call from anywhere: a lease keeps
 * two requests from measuring the same video, and a stale lease is picked up again.
 */
export async function measureVideo(id: string): Promise<void> {
  const token = randomUUID();
  const claimed = await mutate(
    "UPDATE lead_videos SET read_token=?,read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 300 SECOND),read_attempts=read_attempts+1 WHERE id=? AND status='measuring' AND (read_until IS NULL OR read_until<UTC_TIMESTAMP(3))",
    [token, id],
  );
  if (!claimed.affectedRows) return;
  const [video] = await rows('SELECT * FROM lead_videos WHERE id=?', [id]);
  const [chat] = await rows('SELECT * FROM lead_chats WHERE id=?', [video.chat_id]);
  const [business] = await rows('SELECT * FROM businesses WHERE id=?', [video.business_id]);
  const asker: Asker = { ip: String(video.requester_ip || 'unknown') };
  const businessId = String(business.id);
  let fileId = '';
  try {
    const stills = json<StoredStill[]>(video.frames_json, []);
    const frames: { id: string; ms: number; image: AiImage }[] = [];
    for (const still of stills)
      frames.push({
        id: still.key,
        ms: still.ms,
        image: {
          mimeType: 'image/jpeg',
          dataBase64: (await getPhoto(still.key)).toString('base64'),
        },
      });
    const services = (
      await rows('SELECT name FROM offerings WHERE business_id=? ORDER BY position', [businessId])
    ).map((row) => String(row.name));
    const task = async () => {
      if (aiMode !== 'demo')
        fileId = await uploadMetaFile(
          await getPhoto(String(video.storage_key)),
          String(video.storage_key),
          String(video.mime_type),
        );
      return measureWalkaround({
        business: {
          name: String(business.name),
          trade: tradeName(business.trade_id, business.custom_trade),
          services,
        },
        serviceName: String(chat.service_name),
        priceUnits: await priceUnits(businessId),
        videoFileId: fileId,
        frames,
        durationMs: video.duration_ms === null ? null : Number(video.duration_ms),
        saveOverlay: async (jpeg) => {
          const key = `${randomUUID()}.jpg`;
          await putPhoto(key, jpeg);
          return key;
        },
      });
    };
    const result: Walkaround =
      chat.source === 'test'
        ? await withAiUsage(businessId, String(chat.id), task)
        : await withCustomerAiUsage(
            { businessId, sessionId: String(chat.id), ip: asker.ip! },
            task,
          );
    const done = await mutate(
      "UPDATE lead_videos SET status='measured',result_json=?,read_token=NULL,read_until=NULL WHERE id=? AND read_token=?",
      [JSON.stringify(result), id, token],
    );
    if (!done.affectedRows) return;
    await recordEvent(
      undefined,
      businessId,
      'video_measured',
      {
        counts: result.counts.length,
        counted: result.counts.reduce((sum, item) => sum + item.count, 0),
        area: Boolean(result.area),
        overlays: result.overlays.length,
      },
      { ref: id },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'video_measure' });
    // An allowance running out won't fix itself on a retry; anything else gets one more go.
    if (!(error instanceof ApiError) && Number(video.read_attempts) < MEASURE_ATTEMPTS) {
      await mutate(
        'UPDATE lead_videos SET read_token=NULL,read_until=NULL WHERE id=? AND read_token=?',
        [id, token],
      );
      void measureVideo(id).catch((retry) => reportError(retry, { event: 'video_measure' }));
      return;
    }
    await mutate(
      "UPDATE lead_videos SET status='failed',failure=?,read_token=NULL,read_until=NULL WHERE id=? AND read_token=?",
      [
        error instanceof ApiError ? error.message.slice(0, 300) : 'We couldn’t measure this video.',
        id,
        token,
      ],
    );
    await recordEvent(undefined, businessId, 'video_failed', {}, { ref: id });
  } finally {
    if (fileId) await deleteMetaFile(fileId).catch(() => {});
  }
  // Measured or not, the assistant picks the chat back up.
  await continueAfterVideo(asker, String(chat.id)).catch((error) =>
    reportError(error, { event: 'video_continue' }),
  );
}

/** Starts measuring this chat's waiting videos, outside the request. */
export async function kickVideos(chatId: string) {
  const due = await rows(
    "SELECT id FROM lead_videos WHERE chat_id=? AND status='measuring' AND (read_until IS NULL OR read_until<UTC_TIMESTAMP(3))",
    [chatId],
  );
  for (const item of due)
    void measureVideo(String(item.id)).catch((error) =>
      reportError(error, { event: 'video_measure' }),
    );
}

/** A video file, for the owner, or for the customer when it's in their chat. */
export async function videoFile(businessId: string, videoId: string, chatId?: string) {
  const [video] = await rows(
    `SELECT storage_key,mime_type FROM lead_videos WHERE id=? AND business_id=?${chatId ? ' AND chat_id=?' : ''}`,
    [z.uuid().parse(videoId), businessId, ...(chatId ? [chatId] : [])],
  );
  if (!video) throw new ApiError(404, 'NOT_FOUND', 'Video not found.');
  return { bytes: await getPhoto(String(video.storage_key)), mimeType: String(video.mime_type) };
}

/** What the owner sees of a chat's videos: what was found, and the stills it was drawn on. */
export async function ownerVideos(businessId: string, chatId: string) {
  const videos = await rows(
    'SELECT id,status,result_json,failure FROM lead_videos WHERE business_id=? AND chat_id=? ORDER BY created_at',
    [businessId, chatId],
  );
  return videos.map((video) => {
    const result = json<Walkaround | null>(video.result_json, null);
    return {
      id: String(video.id),
      status: String(video.status),
      url: `/api/v1/app/videos/${video.id}`,
      failure: video.failure ? String(video.failure) : '',
      summary: result?.summary ?? '',
      narration: result?.narration ?? '',
      counts: result?.counts ?? [],
      area: result?.area ?? null,
      overlays: (result?.overlays ?? []).map((overlay, index) => ({
        label: overlay.label,
        url: `/api/v1/app/videos/${video.id}/overlays/${index}`,
      })),
    };
  });
}

/** A drawn still, for the owner. */
export async function overlayFile(businessId: string, videoId: string, index: number) {
  const [video] = await rows(
    "SELECT result_json FROM lead_videos WHERE id=? AND business_id=? AND status='measured'",
    [z.uuid().parse(videoId), businessId],
  );
  const overlay = json<Walkaround | null>(video?.result_json, null)?.overlays[index];
  if (!overlay) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
  return getPhoto(overlay.storageKey);
}
