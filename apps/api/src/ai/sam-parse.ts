import {
  decodeMaskToRaster,
  frameIndexOf,
  parseVideoStream,
  recordsOfKind,
  type ResponsesEvent,
} from '@meta-sam/parser';

/**
 * SAM 3.1's answer read into objects. Kept apart from the API calls in meta-media.ts so a worker
 * thread can load it alone (sam-parse-worker.ts): a whole video's answer takes seconds to read.
 */
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
