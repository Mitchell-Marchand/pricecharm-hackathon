import {
  decodeMaskToRaster,
  frameIndexOf,
  parseVideoStream,
  recordsOfKind,
  type ResponsesEvent,
} from '@meta-sam/parser';
import { z } from 'zod';
import { AiError, recordProviderUsage } from './index.js';

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

export type SamBox = { left: number; top: number; right: number; bottom: number };
/** One object on one frame. `pixels` is its mask's area in the frame's own pixels. */
export type SamObject = {
  id: string;
  frame: number;
  box: SamBox;
  confidence: number | null;
  pixels: number;
  mask: { raster: Uint8Array; width: number; height: number; bounds: SamBox };
};
export type Segmentation = { width: number; height: number; objects: SamObject[] };

/** Reads SAM 3.1's special-token text into objects, using Meta's own parser for the grammar. */
export async function parseSegmentation(text: string): Promise<Segmentation> {
  const lane = { item_id: 'sam', output_index: 0, content_index: 0 };
  async function* events(): AsyncIterable<ResponsesEvent> {
    if (text) yield { type: 'response.output_text.delta', delta: text, ...lane };
    yield { type: 'response.output_text.done', text, ...lane };
    yield { type: 'response.completed' };
  }
  const result = await parseVideoStream(events()).finalResult;
  const size = /;w=(\d+);h=(\d+)/.exec(text);
  const confidence = new Map<string, number>();
  for (const box of recordsOfKind(result.records, 'box'))
    if (box.confidence !== undefined)
      confidence.set(`${frameIndexOf(box) ?? 0}:${box.objectId}`, box.confidence);
  const objects = recordsOfKind(result.records, 'mask').map((record): SamObject => {
    const raster = decodeMaskToRaster(record.mask);
    const frame = frameIndexOf(record) ?? 0;
    let on = 0;
    for (const value of raster) on += value;
    const { left, top, right, bottom } = record.bounds;
    // The raster covers the object's box, sometimes at a smaller scale than the frame.
    const scale =
      ((right - left) * (bottom - top)) / Math.max(1, record.mask.width * record.mask.height);
    return {
      id: record.objectId,
      frame,
      box: { left, top, right, bottom },
      confidence: record.confidence ?? confidence.get(`${frame}:${record.objectId}`) ?? null,
      pixels: Math.round(on * scale),
      mask: {
        raster,
        width: record.mask.width,
        height: record.mask.height,
        bounds: { left, top, right, bottom },
      },
    };
  });
  return { width: Number(size?.[1] ?? 0), height: Number(size?.[2] ?? 0), objects };
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
  const segmentation = await parseSegmentation(text);
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
