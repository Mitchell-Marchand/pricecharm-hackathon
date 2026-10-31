import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { AiError, recordProviderUsage } from './index.js';
import { parseSegmentation, type Segmentation } from './sam-parse.js';

export { parseSegmentation } from './sam-parse.js';
export type { SamBox, SamObject, Segmentation } from './sam-parse.js';

/**
 * Meta's media endpoints: the Files API for videos, and SAM 3.1, which finds every match for a
 * short noun phrase in a photo or a video and returns a box and a pixel mask for each. In a video
 * it keeps each object's id from frame to frame, so a window seen for two seconds is one window.
 */
const BASE = 'https://api.meta.ai/v1';

function metaKey() {
  const key = process.env.META_API_KEY;
  if (!key) throw new AiError('Configure META_API_KEY to read videos.');
  return key;
}

/** Uploads a video once, so Muse Spark and every SAM pass read the same file. */
export async function uploadMetaFile(bytes: Buffer, filename: string, mimeType: string) {
  const body = new FormData();
  body.append('purpose', 'user_data');
  body.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  const response = await fetch(`${BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${metaKey()}` },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AiError('The video couldn’t be uploaded for reading.');
  }
  return z.object({ id: z.string().min(1).max(200) }).parse(await response.json()).id;
}

/** Customers' videos aren't kept at Meta once they've been read. */
export async function deleteMetaFile(fileId: string) {
  const response = await fetch(`${BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${metaKey()}` },
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
}

/** An answer this long, a whole video's, is read on a worker thread so the API keeps answering. */
const OFF_THREAD_CHARS = 50_000;
// The worker is TypeScript when the API runs from source (dev and tests), JavaScript once built.
const workerFile = new URL(
  `./sam-parse-worker${path.extname(fileURLToPath(import.meta.url))}`,
  import.meta.url,
);

/** Reads a SAM answer on a worker thread: a whole video's takes seconds of steady work. */
export function parseOffThread(text: string): Promise<Segmentation> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, {
      workerData: text,
      execArgv: workerFile.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`The SAM reader stopped with code ${code}.`)));
  });
}

/**
 * Every match for one noun phrase, like "window", in a photo or an uploaded video. Zero matches
 * is a normal answer. One phrase per call: SAM reads only the first concept in a list.
 */
export async function segment(
  phrase: string,
  media: { videoFileId: string } | { image: { mimeType: string; dataBase64: string } },
): Promise<Segmentation> {
  const video = 'videoFileId' in media;
  const started = Date.now();
  const response = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${metaKey()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(video ? 180_000 : 45_000),
    body: JSON.stringify({
      model: process.env.META_SAM_MODEL || 'sam-3.1',
      store: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: phrase },
            video
              ? { type: 'input_video', file_id: media.videoFileId }
              : {
                  type: 'input_image',
                  image_url: `data:${media.image.mimeType};base64,${media.image.dataBase64}`,
                },
          ],
        },
      ],
      // Metadata values are strings. one_bit masks are several times smaller than lossless.
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AiError('The video couldn’t be measured.');
  }
  const raw = z
    .object({
      status: z.string(),
      output: z.array(
        z
          .object({
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
              .optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(await response.json());
  if (raw.status !== 'completed') throw new AiError('The video couldn’t be measured.');
  const text = raw.output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('');
  const segmentation =
    text.length > OFF_THREAD_CHARS
      ? await parseOffThread(text).catch(() => parseSegmentation(text))
      : await parseSegmentation(text);
  await recordProviderUsage({
    provider: 'meta',
    model: 'sam-3.1',
    operation: video ? 'segment_video' : 'segment_photo',
    // SAM is billed per image and per frame, not per token.
    inputTokens: 0,
    outputTokens: 0,
    requestId: response.headers.get('x-request-id') ?? undefined,
    durationMs: Date.now() - started,
  });
  return segmentation;
}
