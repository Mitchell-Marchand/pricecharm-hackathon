import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { owner, requireOwner } from './auth.js';
import { mutate, rows, transaction } from './db.js';
import { ApiError } from './http.js';
import { putPhoto, getPhoto, deletePhoto } from './storage.js';

const maxImages = 3;
let inFlightUploads = 0;
export const uploadSlot: RequestHandler = (_req, res, next) => {
  if (inFlightUploads >= 2) {
    res.setHeader('Retry-After', '3');
    return next(
      new ApiError(503, 'UPLOAD_BUSY', 'Photos are being processed. Please try again in a moment.'),
    );
  }
  inFlightUploads++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      inFlightUploads--;
    }
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new ApiError(415, 'UNSUPPORTED_IMAGE', 'Upload a JPEG, PNG, or WebP photo.'));
    }
    callback(null, true);
  },
});
const single = upload.single('file');
export const imageUpload = (
  req: Request,
  res: Parameters<typeof single>[1],
  next: Parameters<typeof single>[2],
) =>
  single(req, res, (error) => {
    if (error instanceof multer.MulterError)
      return next(new ApiError(413, 'UPLOAD_LIMIT', 'Upload one photo smaller than 8 MB.'));
    next(error);
  });
function publicAttachment(row: Record<string, any>) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    width: Number(row.width),
    height: Number(row.height),
    size: Number(row.byte_size),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
/** Where an uploaded photo belongs. Past-job photos upload first and attach when the job saves. */
export type PhotoTarget = {
  conversationId?: string | null;
  purpose?: 'past_job';
};
// A setup that never becomes an account shouldn't be able to fill storage.
const DRAFT_PHOTO_LIMIT = 60;

export async function saveImage(req: Request, businessId: string, target: PhotoTarget = {}) {
  const conversationId = target.conversationId ?? null;
  if (!req.file) throw new ApiError(400, 'FILE_REQUIRED', 'Choose a photo to upload.');
  const bytes = req.file.buffer;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp)
    throw new ApiError(
      422,
      'INVALID_IMAGE',
      'The file contents must be a JPEG, PNG, or WebP photo.',
    );
  let photo: Buffer, width: number, height: number;
  try {
    const normalized = await sharp(req.file.buffer, {
      limitInputPixels: 16_000_000,
      animated: false,
    })
      .rotate()
      .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    photo = normalized.data;
    width = normalized.info.width;
    height = normalized.info.height;
  } catch {
    throw new ApiError(
      422,
      'INVALID_IMAGE',
      'This photo could not be read. Try another JPEG, PNG, or WebP image.',
    );
  }
  if (photo.length > 1024 * 1024)
    throw new ApiError(
      413,
      'IMAGE_TOO_COMPLEX',
      'This photo is too large after processing. Please upload a smaller image.',
    );
  const id = randomUUID(),
    storageKey = `${id}.jpg`;
  const filename =
    path
      .basename(req.file.originalname)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 180) || 'project-photo.jpg';
  await putPhoto(storageKey, photo);
  try {
    await transaction(async (connection) => {
      // Lock the tenant row so parallel requests cannot bypass the storage/photo caps.
      await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
      const [totals] = await rows(
        'SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM attachments WHERE business_id = ?',
        [businessId],
        connection,
      );
      const [business] = await rows(
        'SELECT status FROM businesses WHERE id = ?',
        [businessId],
        connection,
      );
      if (business?.status === 'draft' && Number(totals.count) >= DRAFT_PHOTO_LIMIT)
        throw new ApiError(
          413,
          'DRAFT_PHOTO_LIMIT',
          `You can add up to ${DRAFT_PHOTO_LIMIT} photos before you create your account.`,
        );
      if (Number(totals.bytes) + photo.length > 100 * 1024 * 1024)
        throw new ApiError(
          413,
          'STORAGE_LIMIT',
          'This workspace reached its 100 MB photo allowance.',
        );
      if (conversationId) {
        const [count] = await rows(
          'SELECT COUNT(*) AS count FROM attachments WHERE business_id = ? AND conversation_id = ?',
          [businessId, conversationId],
          connection,
        );
        if (Number(count.count) >= maxImages)
          throw new ApiError(
            422,
            'PHOTO_LIMIT',
            'You can attach up to three photos to this inquiry.',
          );
      }
      await mutate(
        'INSERT INTO attachments (id,business_id,conversation_id,purpose,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          businessId,
          conversationId,
          target.purpose ?? null,
          filename,
          'image/jpeg',
          storageKey,
          width,
          height,
          photo.length,
        ],
        connection,
      );
    });
  } catch (error) {
    await deletePhoto(storageKey).catch(() => {});
    throw error;
  }
  const [saved] = await rows('SELECT * FROM attachments WHERE id = ? AND business_id = ?', [
    id,
    businessId,
  ]);
  return {
    ...publicAttachment(saved),
    previewDataUrl: `data:image/jpeg;base64,${photo.toString('base64')}`,
  };
}

/** Owners open their customers' photos here, from a quote's conversation. */
export function createUploadRouter() {
  const router = Router();
  router.get('/uploads/:attachmentId', requireOwner, async (req, res) => {
    const [item] = await rows('SELECT * FROM attachments WHERE id = ? AND business_id = ?', [
      z.string().uuid().parse(req.params.attachmentId),
      owner(req).businessId,
    ]);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
    res.type('image/jpeg').send(await getPhoto(item.storage_key));
  });
  return router;
}
