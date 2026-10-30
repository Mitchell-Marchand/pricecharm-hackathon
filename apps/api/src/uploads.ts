import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import sharp, { type Sharp } from 'sharp';
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
/** One image up to 8 MB, with the words to use when it's the wrong kind or too big. */
function singleImage(messages: { kind: string; size: string }): RequestHandler {
  const single = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        return callback(new ApiError(415, 'UNSUPPORTED_IMAGE', messages.kind));
      }
      callback(null, true);
    },
  }).single('file');
  return (req, res, next) =>
    single(req, res, (error) => {
      if (error instanceof multer.MulterError)
        return next(new ApiError(413, 'UPLOAD_LIMIT', messages.size));
      next(error);
    });
}
export const imageUpload = singleImage({
  kind: 'Upload a JPEG, PNG, or WebP photo.',
  size: 'Upload one photo smaller than 8 MB.',
});
export const logoUpload = singleImage({
  kind: 'Upload your logo as a PNG, JPG or WebP file.',
  size: 'Upload a logo smaller than 8 MB.',
});

/** What the file is, from its first bytes rather than its name or what the browser said. */
export function imageKind(bytes: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

const uploadedName = (file: Express.Multer.File, fallback: string) =>
  path
    .basename(file.originalname)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 180) || fallback;
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
  if (!req.file) throw new ApiError(400, 'FILE_REQUIRED', 'Choose a photo to upload.');
  return storeImage(
    req.file.buffer,
    uploadedName(req.file, 'project-photo.jpg'),
    businessId,
    target,
  );
}

/** Saves a photo, uploaded here or sent to the business on WhatsApp, within the same limits. */
export async function storeImage(
  bytes: Buffer,
  filename: string,
  businessId: string,
  target: PhotoTarget = {},
) {
  const conversationId = target.conversationId ?? null;
  if (!imageKind(bytes))
    throw new ApiError(
      422,
      'INVALID_IMAGE',
      'The file contents must be a JPEG, PNG, or WebP photo.',
    );
  let photo: Buffer, width: number, height: number;
  try {
    const normalized = await sharp(bytes, {
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

/** Logos show at most about 160 px wide, so this leaves room for sharp screens. */
const LOGO_SIZE = 512;

/**
 * Plain white or see-through margins come off, so the logo fills its space. A logo on its own
 * colored background keeps it. PNG keeps the transparency.
 */
async function normalizeLogo(bytes: Buffer) {
  const open = () => sharp(bytes, { limitInputPixels: 16_000_000, animated: false }).rotate();
  const [r, g, b, a] = await open()
    .ensureAlpha()
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  const finish = (image: Sharp) =>
    image
      .resize({ width: LOGO_SIZE, height: LOGO_SIZE, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toBuffer({ resolveWithObject: true });
  if (a < 16 || (r > 235 && g > 235 && b > 235)) {
    try {
      return await finish(open().trim({ background: { r, g, b, alpha: a / 255 }, threshold: 12 }));
    } catch {
      // Nothing but margin to trim: keep it as it came.
    }
  }
  return finish(open());
}

async function deleteAttachment(businessId: string, attachmentId: string) {
  const [item] = await rows('SELECT storage_key FROM attachments WHERE id=? AND business_id=?', [
    attachmentId,
    businessId,
  ]);
  if (!item) return;
  await mutate('DELETE FROM attachments WHERE id=? AND business_id=?', [attachmentId, businessId]);
  await deletePhoto(String(item.storage_key));
}

/** The business's logo for its quote chat and quotes. It replaces the one they had. */
export async function saveLogo(req: Request, businessId: string) {
  const file = req.file;
  if (!file) throw new ApiError(400, 'FILE_REQUIRED', 'Choose your logo file.');
  if (!imageKind(file.buffer))
    throw new ApiError(422, 'INVALID_IMAGE', 'The file must be a PNG, JPG or WebP image.');
  let logo: Buffer, width: number, height: number;
  try {
    const normalized = await normalizeLogo(file.buffer);
    logo = normalized.data;
    width = normalized.info.width;
    height = normalized.info.height;
  } catch {
    throw new ApiError(422, 'INVALID_IMAGE', 'This logo couldn’t be read. Try a PNG or JPG.');
  }
  if (Math.max(width, height) < 64)
    throw new ApiError(
      422,
      'LOGO_TOO_SMALL',
      'This logo is too small and would look blurry. Try a bigger file.',
    );
  if (logo.length > 1024 * 1024)
    throw new ApiError(
      413,
      'IMAGE_TOO_COMPLEX',
      'This logo is too large after processing. Try a simpler file.',
    );
  const id = randomUUID(),
    storageKey = `${id}.png`;
  await putPhoto(storageKey, logo);
  let previous: string | null;
  try {
    previous = await transaction(async (connection) => {
      const [business] = await rows(
        'SELECT logo_id FROM businesses WHERE id=? FOR UPDATE',
        [businessId],
        connection,
      );
      await mutate(
        'INSERT INTO attachments (id,business_id,purpose,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,?,?,?,?,?,?)',
        [
          id,
          businessId,
          'logo',
          uploadedName(file, 'logo.png'),
          'image/png',
          storageKey,
          width,
          height,
          logo.length,
        ],
        connection,
      );
      await mutate('UPDATE businesses SET logo_id=? WHERE id=?', [id, businessId], connection);
      return business?.logo_id ? String(business.logo_id) : null;
    });
  } catch (error) {
    await deletePhoto(storageKey).catch(() => {});
    throw error;
  }
  if (previous) await deleteAttachment(businessId, previous);
}

/** Back to the business's initials. */
export async function removeLogo(businessId: string) {
  const previous = await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT logo_id FROM businesses WHERE id=? FOR UPDATE',
      [businessId],
      connection,
    );
    await mutate('UPDATE businesses SET logo_id=NULL WHERE id=?', [businessId], connection);
    return business?.logo_id ? String(business.logo_id) : null;
  });
  if (previous) await deleteAttachment(businessId, previous);
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
