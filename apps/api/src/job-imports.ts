import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { tradeName } from '@pricecharm/trades';
import { readPastJob, type ReadJob } from './ai/past-job-reader.js';
import { mutate, rows, transaction } from './db.js';
import { reportError } from './error-reporting.js';
import { ApiError, ok, rateLimit } from './http.js';
import { json, type Row } from './models.js';
import { insertPastJobs, jobInput, listPastJobs } from './past-jobs.js';
import { deletePhoto, getPhoto, putPhoto } from './storage.js';
import { uploadSlot } from './uploads.js';
import { withAiUsage } from './usage.js';
import { requireWorkspace, workspace } from './workspace.js';
import { jobFacts, recordEvent, recordRequestEvent } from './metrics.js';

/**
 * Old quotes and invoices, several at a time. Each file is stored as it arrives and read in the
 * background, so the owner can keep going. The jobs it finds wait on one list until the owner
 * checks them and saves them together.
 */
export const jobImportsRouter = Router();

/** Files waiting to be checked at once. Saving or dropping them makes room. */
const MAX_WAITING = 20;
/** Tries at reading one file before it's shown as failed. */
const READ_ATTEMPTS = 3;

type ReadResult = { found: boolean; job: ReadJob; issues: string[] };

export type JobImport = {
  id: string;
  filename: string;
  status: 'reading' | 'ready' | 'empty' | 'failed';
  /** What it read, for the owner to check. Null until it's read, or if there was nothing. */
  job: ReadJob | null;
  issues: string[];
  failure: string | null;
};

function importView(row: Row): JobImport {
  const result = json<ReadResult | null>(row.result_json, null);
  return {
    id: String(row.id),
    filename: String(row.filename),
    status: row.status as JobImport['status'],
    job: result?.found ? result.job : null,
    issues: result?.issues ?? [],
    failure: row.status === 'failed' ? String(row.failure || '') : null,
  };
}

export async function listJobImports(businessId: string): Promise<JobImport[]> {
  return (
    await rows('SELECT * FROM job_imports WHERE business_id=? ORDER BY created_at,id', [businessId])
  ).map(importView);
}

/**
 * Reads one stored file into a job. Safe to call from anywhere: a lease keeps two requests from
 * reading the same file, and a stale lease is picked up again.
 */
export async function readJobImport(id: string): Promise<void> {
  const token = randomUUID();
  const claimed = await mutate(
    "UPDATE job_imports SET read_token=?,read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 120 SECOND),read_attempts=read_attempts+1 WHERE id=? AND status='reading' AND (read_until IS NULL OR read_until<UTC_TIMESTAMP(3))",
    [token, id],
  );
  if (!claimed.affectedRows) return;
  const [item] = await rows('SELECT * FROM job_imports WHERE id=?', [id]);
  const businessId = String(item.business_id);
  try {
    const bytes = await getPhoto(String(item.storage_key));
    const [business] = await rows('SELECT trade_id,custom_trade FROM businesses WHERE id=?', [
      businessId,
    ]);
    const services = (
      await rows('SELECT name FROM offerings WHERE business_id=? ORDER BY position', [businessId])
    ).map((row) => String(row.name));
    const result = await withAiUsage(businessId, 'read-past-job', () =>
      readPastJob({
        trade: tradeName(business?.trade_id, business?.custom_trade),
        services,
        file:
          item.kind === 'pdf'
            ? {
                document: {
                  filename: String(item.filename),
                  mimeType: 'application/pdf',
                  dataBase64: bytes.toString('base64'),
                },
              }
            : { image: { mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') } },
      }),
    );
    const done = await mutate(
      'UPDATE job_imports SET status=?,result_json=?,storage_key=NULL,read_token=NULL,read_until=NULL WHERE id=? AND read_token=?',
      [result.found ? 'ready' : 'empty', JSON.stringify(result), id, token],
    );
    // Once it's read, the file itself isn't kept: it can have customers' names and addresses.
    if (done.affectedRows) await deletePhoto(String(item.storage_key)).catch(() => {});
    if (done.affectedRows)
      await recordEvent(
        undefined,
        businessId,
        'import_read',
        {
          kind: String(item.kind),
          found: Boolean(result.found),
          attempt: Number(item.read_attempts),
        },
        { ref: id },
      );
  } catch (error) {
    // Dropped while it was being read: nothing to report.
    if (!(await rows('SELECT id FROM job_imports WHERE id=?', [id])).length) return;
    // An allowance running out won't fix itself on a retry, and its message says what to do.
    if (!(error instanceof ApiError)) reportError(error, { event: 'job_import_read' });
    if (error instanceof ApiError || Number(item.read_attempts) >= READ_ATTEMPTS)
      await recordEvent(
        undefined,
        businessId,
        'import_failed',
        { kind: String(item.kind), reason: error instanceof ApiError ? error.code : 'unreadable' },
        { ref: id },
      );
    if (error instanceof ApiError || Number(item.read_attempts) >= READ_ATTEMPTS)
      await mutate(
        "UPDATE job_imports SET status='failed',failure=?,read_token=NULL,read_until=NULL WHERE id=? AND read_token=?",
        [
          error instanceof ApiError
            ? error.message.slice(0, 300)
            : 'We couldn’t read this file. Add the job yourself, or try another file.',
          id,
          token,
        ],
      );
    // Otherwise it's tried again the next time the list is opened.
    else
      await mutate(
        'UPDATE job_imports SET read_token=NULL,read_until=NULL WHERE id=? AND read_token=?',
        [id, token],
      );
  }
}

/** Starts reading files that are waiting, oldest first, outside the request. */
export async function kickJobImports(businessId: string) {
  const due = await rows(
    "SELECT id FROM job_imports WHERE business_id=? AND status='reading' AND (read_until IS NULL OR read_until<UTC_TIMESTAMP(3)) ORDER BY created_at LIMIT 3",
    [businessId],
  );
  for (const item of due)
    void readJobImport(String(item.id)).catch((error) =>
      reportError(error, { event: 'job_import_read' }),
    );
}

/** A PDF as it is, or a photo turned into a JPEG small enough to read. */
async function readableFile(bytes: Buffer): Promise<{ kind: 'pdf' | 'image'; bytes: Buffer }> {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    if (bytes.length > 4 * 1024 * 1024)
      throw new ApiError(
        413,
        'PDF_TOO_LARGE',
        'PDFs can be up to 4 MB. Try a photo of it instead.',
      );
    return { kind: 'pdf', bytes };
  }
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
  return { kind: 'image', bytes: image };
}

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
}).single('file');

jobImportsRouter.get('/onboarding/imports', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  // Picks up any file whose reading stalled, for example after a restart.
  await kickJobImports(businessId);
  res.json(ok(await listJobImports(businessId)));
});

/** One file at a time, so each shows on the list as soon as it's in. Reading starts straight away. */
jobImportsRouter.post(
  '/onboarding/imports',
  rateLimit(30, 15 * 60_000),
  requireWorkspace,
  uploadSlot,
  (req, res, next) =>
    documentUpload(req, res, (error) => {
      if (error instanceof multer.MulterError)
        return next(new ApiError(413, 'UPLOAD_LIMIT', 'Choose files smaller than 10 MB.'));
      next(error);
    }),
  async (req, res) => {
    const file = req.file;
    if (!file) throw new ApiError(400, 'FILE_REQUIRED', 'Choose a PDF or a photo of the document.');
    const { businessId } = workspace(req);
    const readable = await readableFile(file.buffer);
    const id = randomUUID();
    const key = `${randomUUID()}.${readable.kind === 'pdf' ? 'pdf' : 'jpg'}`;
    let stored = false;
    try {
      await transaction(async (connection) => {
        await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
        const [waiting] = await rows(
          'SELECT COUNT(*) AS count FROM job_imports WHERE business_id=?',
          [businessId],
          connection,
        );
        if (Number(waiting.count) >= MAX_WAITING)
          throw new ApiError(
            422,
            'IMPORT_LIMIT',
            `Check the ${MAX_WAITING} files on your list before adding more.`,
          );
        await putPhoto(key, readable.bytes);
        stored = true;
        await mutate(
          'INSERT INTO job_imports (id,business_id,filename,storage_key,kind) VALUES (?,?,?,?,?)',
          [id, businessId, file.originalname.slice(0, 180) || 'document', key, readable.kind],
          connection,
        );
      });
    } catch (error) {
      if (stored) await deletePhoto(key).catch(() => {});
      throw error;
    }
    await kickJobImports(businessId);
    await recordRequestEvent(
      req,
      businessId,
      'import_uploaded',
      { kind: readable.kind, kb: Math.round(file.size / 1024) },
      { ref: id },
    );
    const [item] = await rows('SELECT * FROM job_imports WHERE id=?', [id]);
    res.status(201).json(ok(importView(item)));
  },
);

/** Saves the checked jobs together, each as the owner left it, and clears them off the list. */
jobImportsRouter.post('/onboarding/imports/save', requireWorkspace, async (req, res) => {
  const { jobs } = z
    .object({
      jobs: z
        .array(
          z.object({ importId: z.uuid(), job: jobInput.omit({ photoIds: true, source: true }) }),
        )
        .min(1)
        .max(MAX_WAITING),
    })
    .strict()
    .parse(req.body);
  const current = workspace(req);
  const ids = jobs.map((item) => item.importId);
  if (new Set(ids).size !== ids.length)
    throw new ApiError(400, 'IMPORT_TWICE', 'Each file can only be saved once.');
  await transaction(async (connection) => {
    const found = await rows(
      `SELECT id FROM job_imports WHERE business_id=? AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
      [current.businessId, ...ids],
      connection,
    );
    if (found.length !== ids.length)
      throw new ApiError(404, 'IMPORT_NOT_FOUND', 'One of these files is no longer on your list.');
    await insertPastJobs(
      connection,
      current,
      jobs.map(({ job }) => ({
        id: randomUUID(),
        input: { ...job, source: 'invoice' as const, photoIds: [] },
      })),
    );
    await mutate(
      `DELETE FROM job_imports WHERE business_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      [current.businessId, ...ids],
      connection,
    );
  });
  for (const { importId, job } of jobs)
    await recordRequestEvent(
      req,
      current.businessId,
      'import_saved',
      jobFacts({ ...job, source: 'invoice' }),
      { ref: importId },
    );
  res.json(
    ok({
      jobs: await listPastJobs(current.businessId),
      imports: await listJobImports(current.businessId),
    }),
  );
});

/** Drops a file from the list, read or not. */
jobImportsRouter.delete('/onboarding/imports/:id', requireWorkspace, async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const { businessId } = workspace(req);
  const [item] = await rows('SELECT storage_key FROM job_imports WHERE id=? AND business_id=?', [
    id,
    businessId,
  ]);
  if (!item) throw new ApiError(404, 'IMPORT_NOT_FOUND', 'That file is no longer on your list.');
  await mutate('DELETE FROM job_imports WHERE id=? AND business_id=?', [id, businessId]);
  if (item.storage_key) await deletePhoto(String(item.storage_key)).catch(() => {});
  await recordRequestEvent(req, businessId, 'import_removed', {}, { ref: id });
  res.json(ok({ ok: true }));
});

/** Files left on a list for a week, and their stored copies. */
export async function cleanupStaleJobImports(): Promise<void> {
  const stale = await rows(
    'SELECT id,storage_key FROM job_imports WHERE created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY) LIMIT 200',
  );
  for (const item of stale) {
    await mutate('DELETE FROM job_imports WHERE id=?', [item.id]);
    if (item.storage_key) await deletePhoto(String(item.storage_key)).catch(() => {});
  }
}
