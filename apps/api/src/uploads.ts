import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { owner, requireOwner, csrfProtection } from './auth.js';
import { mutate, rows, transaction } from './db.js';
import { ApiError, ok, rateLimit } from './http.js';
import { publicAccess } from './public.js';
import { putPhoto, getPhoto, deletePhoto } from './storage.js';

const maxImages = 3;
let inFlightUploads = 0;
const uploadSlot: RequestHandler = (_req, res, next) => {
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
const imageUpload = (
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
async function saveImage(
  req: Request,
  businessId: string,
  conversationId: string | null,
  exampleId: string | null,
) {
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
        'INSERT INTO attachments (id,business_id,conversation_id,example_id,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          businessId,
          conversationId,
          exampleId,
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

export async function loadConversationImages(
  businessId: string,
  conversationId: string,
): Promise<{ mimeType: string; dataBase64: string }[]> {
  const items = await rows(
    'SELECT storage_key FROM attachments WHERE business_id = ? AND conversation_id = ? ORDER BY created_at LIMIT 3',
    [businessId, conversationId],
  );
  return Promise.all(
    items.map(async (item) => ({
      mimeType: 'image/jpeg',
      dataBase64: (await getPhoto(item.storage_key)).toString('base64'),
    })),
  );
}
export function createUploadRouter() {
  const router = Router();
  router.post(
    '/uploads',
    requireOwner,
    csrfProtection,
    rateLimit(20, 60_000),
    uploadSlot,
    imageUpload,
    async (req, res) => {
      const businessId = owner(req).businessId;
      const exampleId = req.body.exampleId ? z.string().uuid().parse(req.body.exampleId) : null;
      if (
        exampleId &&
        !(
          await rows('SELECT id FROM examples WHERE business_id = ? AND id = ?', [
            businessId,
            exampleId,
          ])
        ).length
      )
        throw new ApiError(404, 'NOT_FOUND', 'Project example not found.');
      res.status(201).json(ok(await saveImage(req, businessId, null, exampleId)));
    },
  );
  router.get('/uploads', requireOwner, async (req, res) => {
    const exampleId = req.query.exampleId ? z.string().uuid().parse(req.query.exampleId) : null;
    const items = await rows(
      `SELECT * FROM attachments WHERE business_id = ? ${exampleId ? 'AND example_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`,
      exampleId ? [owner(req).businessId, exampleId] : [owner(req).businessId],
    );
    res.json(ok(items.map(publicAttachment)));
  });
  router.get('/uploads/:attachmentId', requireOwner, async (req, res) => {
    const [item] = await rows('SELECT * FROM attachments WHERE id = ? AND business_id = ?', [
      z.string().uuid().parse(req.params.attachmentId),
      owner(req).businessId,
    ]);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
    res.type('image/jpeg').send(await getPhoto(item.storage_key));
  });
  router.delete('/uploads/:attachmentId', requireOwner, csrfProtection, async (req, res) => {
    const [item] = await rows('SELECT * FROM attachments WHERE id = ? AND business_id = ?', [
      z.string().uuid().parse(req.params.attachmentId),
      owner(req).businessId,
    ]);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
    await mutate('DELETE FROM attachments WHERE id = ? AND business_id = ?', [
      item.id,
      owner(req).businessId,
    ]);
    await deletePhoto(item.storage_key).catch(() => {});
    res.json(ok({ ok: true }));
  });
  router.get('/quotes/:quoteId/photos', requireOwner, async (req, res) => {
    const businessId = owner(req).businessId;
    const [quote] = await rows(
      'SELECT public_session_id FROM quotes WHERE id = ? AND business_id = ?',
      [z.string().uuid().parse(req.params.quoteId), businessId],
    );
    if (!quote) throw new ApiError(404, 'NOT_FOUND', 'Quote not found.');
    const photos = quote.public_session_id
      ? await rows(
          'SELECT * FROM attachments WHERE business_id = ? AND conversation_id = ? ORDER BY created_at LIMIT 3',
          [businessId, quote.public_session_id],
        )
      : [];
    res.json(
      ok(photos.map((item) => ({ ...publicAttachment(item), url: `/api/v1/uploads/${item.id}` }))),
    );
  });
  router.get('/quotes/:quoteId/conversation', requireOwner, async (req, res) => {
    const businessId = owner(req).businessId;
    const [quote] = await rows(
      'SELECT public_session_id FROM quotes WHERE id = ? AND business_id = ?',
      [z.string().uuid().parse(req.params.quoteId), businessId],
    );
    if (!quote) throw new ApiError(404, 'NOT_FOUND', 'Quote not found.');
    const messages = quote.public_session_id
      ? await rows(
          "SELECT id,role,content,created_at,owner_authored FROM messages WHERE business_id = ? AND conversation_id = ? AND conversation_type = 'public' ORDER BY position",
          [businessId, quote.public_session_id],
        )
      : [];
    res.json(
      ok(
        messages.map((item) => ({
          id: item.id,
          role: item.role,
          content: item.content,
          createdAt: new Date(item.created_at).toISOString(),
          author: item.owner_authored ? 'owner' : item.role === 'user' ? 'customer' : 'ai',
        })),
      ),
    );
  });
  router.post(
    '/public/:slug/sessions/:id/uploads',
    rateLimit(10, 60_000),
    async (req, _res, next) => {
      await publicAccess(req);
      next();
    },
    uploadSlot,
    imageUpload,
    async (req, res) => {
      const access = await publicAccess(req);
      if (!['active', 'submitted'].includes(access.session.status))
        throw new ApiError(
          409,
          'SESSION_CLOSED',
          'This request is complete. Start a new inquiry to attach photos.',
        );
      res
        .status(201)
        .json(ok(await saveImage(req, access.business.id, String(access.session.id), null)));
    },
  );
  router.get('/public/:slug/sessions/:id/uploads', async (req, res) => {
    const access = await publicAccess(req);
    const items = await rows(
      'SELECT * FROM attachments WHERE business_id = ? AND conversation_id = ? ORDER BY created_at LIMIT 3',
      [access.business.id, access.session.id],
    );
    const photos = await Promise.all(
      items.map(async (item) => ({
        ...publicAttachment(item),
        previewDataUrl: `data:image/jpeg;base64,${(await getPhoto(item.storage_key)).toString('base64')}`,
      })),
    );
    res.json(ok(photos));
  });
  return router;
}
