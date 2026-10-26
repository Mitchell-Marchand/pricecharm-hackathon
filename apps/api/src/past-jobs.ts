import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { tradeName } from '@quotefolk/trades';
import { readPastJob } from './ai/past-job-reader.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError, ok, rateLimit } from './http.js';
import { deletePhoto, getPhoto } from './storage.js';
import { imageUpload, saveImage, uploadSlot } from './uploads.js';
import { withAiUsage } from './usage.js';
import { requireWorkspace, workspace } from './workspace.js';

/** The jobs an owner has done. They teach the AI what this business charges. */
export const pastJobsRouter = Router();

const MAX_PHOTOS_PER_JOB = 8;
const MAX_JOBS = { draft: 30, active: 300 };

export type PastJob = {
  id: string;
  serviceName: string;
  description: string;
  priceCents: number;
  size: string;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: { kind: 'amount' | 'percent'; value: number; reason: string } | null;
  notes: string;
  source: 'manual' | 'invoice';
  photos: { id: string; url: string }[];
  createdAt: string;
};

export function photoUrl(id: string) {
  return `/api/v1/onboarding/photos/${id}`;
}

function mapJob(row: Record<string, any>, photos: { id: string }[]): PastJob {
  return {
    id: row.id,
    serviceName: row.service_name,
    description: row.description,
    priceCents: Number(row.price_cents),
    size: row.size,
    duration: row.duration,
    when: row.performed,
    materialsCents: row.materials_cents === null ? null : Number(row.materials_cents),
    discount: row.discount_kind
      ? { kind: row.discount_kind, value: Number(row.discount_value), reason: row.discount_reason }
      : null,
    notes: row.notes,
    source: row.source,
    photos: photos.map((photo) => ({ id: photo.id, url: photoUrl(photo.id) })),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listPastJobs(businessId: string, connection?: Sql): Promise<PastJob[]> {
  const jobs = await rows(
    'SELECT * FROM past_jobs WHERE business_id=? ORDER BY created_at,id',
    [businessId],
    connection,
  );
  const photos = await rows(
    "SELECT id,past_job_id FROM attachments WHERE business_id=? AND purpose='past_job' AND past_job_id IS NOT NULL ORDER BY created_at,id",
    [businessId],
    connection,
  );
  return jobs.map((job) =>
    mapJob(
      job,
      photos.filter((photo) => photo.past_job_id === job.id).map((photo) => ({ id: photo.id })),
    ),
  );
}

const cents = z.number().int().min(0).max(100_000_000);
const jobInput = z
  .object({
    serviceName: z.string().trim().max(80),
    description: z.string().trim().min(4, 'Describe the job in a few words.').max(2000),
    priceCents: cents.min(1, 'Add what you charged.'),
    size: z.string().trim().max(80).default(''),
    duration: z.string().trim().max(80).default(''),
    when: z.string().trim().max(80).default(''),
    materialsCents: cents.nullable().default(null),
    discount: z
      .object({
        kind: z.enum(['amount', 'percent']),
        value: z.number().int().min(1).max(100_000_000),
        reason: z.string().trim().max(160).default(''),
      })
      .strict()
      .refine((discount) => discount.kind === 'amount' || discount.value <= 100, {
        message: 'A percent discount can’t be more than 100%.',
      })
      .nullable()
      .default(null),
    notes: z.string().trim().max(2000).default(''),
    source: z.enum(['manual', 'invoice']).default('manual'),
    photoIds: z.array(z.uuid()).max(MAX_PHOTOS_PER_JOB).default([]),
  })
  .strict();
type JobInput = z.infer<typeof jobInput>;

/** Attaches the listed photos to the job and returns the ones it no longer uses. */
async function attachPhotos(
  connection: Sql,
  businessId: string,
  jobId: string,
  photoIds: string[],
): Promise<string[]> {
  const owned = await rows(
    `SELECT id,past_job_id,storage_key FROM attachments WHERE business_id=? AND purpose='past_job' AND (past_job_id=?${photoIds.length ? ` OR id IN (${photoIds.map(() => '?').join(',')})` : ''}) FOR UPDATE`,
    [businessId, jobId, ...photoIds],
    connection,
  );
  for (const id of photoIds) {
    const photo = owned.find((item) => item.id === id);
    if (!photo || (photo.past_job_id && photo.past_job_id !== jobId))
      throw new ApiError(404, 'PHOTO_NOT_FOUND', 'One of the photos is no longer available.');
  }
  if (photoIds.length)
    await mutate(
      `UPDATE attachments SET past_job_id=? WHERE business_id=? AND id IN (${photoIds.map(() => '?').join(',')})`,
      [jobId, businessId, ...photoIds],
      connection,
    );
  const dropped = owned.filter((item) => item.past_job_id === jobId && !photoIds.includes(item.id));
  for (const photo of dropped)
    await mutate(
      'DELETE FROM attachments WHERE id=? AND business_id=?',
      [photo.id, businessId],
      connection,
    );
  return dropped.map((photo) => String(photo.storage_key));
}

function jobValues(input: JobInput) {
  return [
    input.serviceName,
    input.description,
    input.priceCents,
    input.size,
    input.duration,
    input.when,
    input.materialsCents,
    input.discount?.kind ?? null,
    input.discount?.value ?? null,
    input.discount?.reason ?? '',
    input.notes,
    input.source,
  ];
}

pastJobsRouter.get('/onboarding/jobs', requireWorkspace, async (req, res) => {
  res.json(ok(await listPastJobs(workspace(req).businessId)));
});

pastJobsRouter.post('/onboarding/jobs', requireWorkspace, async (req, res) => {
  const input = jobInput.parse(req.body);
  const current = workspace(req);
  const id = randomUUID();
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [current.businessId], connection);
    const [count] = await rows(
      'SELECT COUNT(*) AS count FROM past_jobs WHERE business_id=?',
      [current.businessId],
      connection,
    );
    const limit = current.draft ? MAX_JOBS.draft : MAX_JOBS.active;
    if (Number(count.count) >= limit)
      throw new ApiError(422, 'JOB_LIMIT', `You can add up to ${limit} jobs here.`);
    await mutate(
      'INSERT INTO past_jobs (service_name,description,price_cents,size,duration,performed,materials_cents,discount_kind,discount_value,discount_reason,notes,source,id,business_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [...jobValues(input), id, current.businessId],
      connection,
    );
    await attachPhotos(connection, current.businessId, id, input.photoIds);
  });
  const job = (await listPastJobs(current.businessId)).find((item) => item.id === id);
  res.status(201).json(ok(job));
});

pastJobsRouter.put('/onboarding/jobs/:id', requireWorkspace, async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const input = jobInput.parse(req.body);
  const current = workspace(req);
  const dropped = await transaction(async (connection) => {
    const updated = await mutate(
      'UPDATE past_jobs SET service_name=?,description=?,price_cents=?,size=?,duration=?,performed=?,materials_cents=?,discount_kind=?,discount_value=?,discount_reason=?,notes=?,source=? WHERE id=? AND business_id=?',
      [...jobValues(input), id, current.businessId],
      connection,
    );
    if (!updated.affectedRows)
      throw new ApiError(404, 'JOB_NOT_FOUND', 'That job is no longer here.');
    return attachPhotos(connection, current.businessId, id, input.photoIds);
  });
  for (const key of dropped) await deletePhoto(key).catch(() => {});
  const job = (await listPastJobs(current.businessId)).find((item) => item.id === id);
  res.json(ok(job));
});

pastJobsRouter.delete('/onboarding/jobs/:id', requireWorkspace, async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const current = workspace(req);
  const dropped = await transaction(async (connection) => {
    const keys = await attachPhotos(connection, current.businessId, id, []);
    const deleted = await mutate(
      'DELETE FROM past_jobs WHERE id=? AND business_id=?',
      [id, current.businessId],
      connection,
    );
    if (!deleted.affectedRows)
      throw new ApiError(404, 'JOB_NOT_FOUND', 'That job is no longer here.');
    return keys;
  });
  for (const key of dropped) await deletePhoto(key).catch(() => {});
  res.json(ok({ ok: true }));
});

/** Photos upload as soon as they're picked, and attach to the job when it's saved. */
pastJobsRouter.post(
  '/onboarding/photos',
  rateLimit(40, 60_000),
  requireWorkspace,
  uploadSlot,
  imageUpload,
  async (req, res) => {
    const saved = await saveImage(req, workspace(req).businessId, { purpose: 'past_job' });
    res.status(201).json(ok({ id: saved.id, url: photoUrl(saved.id) }));
  },
);

pastJobsRouter.get('/onboarding/photos/:id', requireWorkspace, async (req, res) => {
  const [photo] = await rows('SELECT storage_key FROM attachments WHERE id=? AND business_id=?', [
    z.uuid().parse(req.params.id),
    workspace(req).businessId,
  ]);
  if (!photo) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
  res.set('Cache-Control', 'private, max-age=86400, immutable');
  res.type('image/jpeg').send(await getPhoto(photo.storage_key));
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
}).single('file');

/** Reads an old quote or invoice into the job form. Nothing is saved until the owner checks it. */
pastJobsRouter.post(
  '/onboarding/jobs/read',
  rateLimit(10, 15 * 60_000),
  requireWorkspace,
  uploadSlot,
  (req, res, next) =>
    documentUpload(req, res, (error) => {
      if (error instanceof multer.MulterError)
        return next(new ApiError(413, 'UPLOAD_LIMIT', 'Choose one file smaller than 10 MB.'));
      next(error);
    }),
  async (req, res) => {
    const file = req.file;
    if (!file) throw new ApiError(400, 'FILE_REQUIRED', 'Choose a PDF or a photo of the document.');
    const bytes = file.buffer;
    const pdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    let input: Parameters<typeof readPastJob>[0]['file'];
    if (pdf) {
      if (bytes.length > 4 * 1024 * 1024)
        throw new ApiError(
          413,
          'PDF_TOO_LARGE',
          'PDFs can be up to 4 MB. Try a photo of it instead.',
        );
      input = {
        document: {
          filename: file.originalname.slice(0, 180) || 'document.pdf',
          mimeType: 'application/pdf',
          dataBase64: bytes.toString('base64'),
        },
      };
    } else {
      let image: Buffer;
      try {
        image = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
          .rotate()
          .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();
      } catch {
        throw new ApiError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, or a JPG, PNG or WebP photo.');
      }
      if (image.length > 1024 * 1024)
        throw new ApiError(
          413,
          'IMAGE_TOO_LARGE',
          'This photo is too detailed to read. Try a smaller one.',
        );
      input = { image: { mimeType: 'image/jpeg', dataBase64: image.toString('base64') } };
    }
    const current = workspace(req);
    const [business] = await rows('SELECT trade_id,custom_trade FROM businesses WHERE id=?', [
      current.businessId,
    ]);
    const services = (
      await rows('SELECT name FROM offerings WHERE business_id=? ORDER BY position', [
        current.businessId,
      ])
    ).map((row) => String(row.name));
    const result = await withAiUsage(current.businessId, 'read-past-job', () =>
      readPastJob({
        trade: tradeName(business?.trade_id, business?.custom_trade),
        services,
        file: input,
      }),
    );
    res.json(ok(result));
  },
);

/** Photos picked for a job that was never saved. */
export async function cleanupUnattachedJobPhotos(): Promise<void> {
  const stale = await rows(
    "SELECT id,business_id,storage_key FROM attachments WHERE purpose='past_job' AND past_job_id IS NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) LIMIT 200",
  );
  for (const photo of stale) {
    await mutate('DELETE FROM attachments WHERE id=? AND business_id=? AND past_job_id IS NULL', [
      photo.id,
      photo.business_id,
    ]);
    await deletePhoto(String(photo.storage_key)).catch(() => {});
  }
}
