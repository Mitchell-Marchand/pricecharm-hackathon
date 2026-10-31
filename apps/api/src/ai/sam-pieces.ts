import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { AiImage } from './index.js';
import {
  deleteMetaFile,
  segment,
  uploadMetaFile,
  type SamBox,
  type SamObject,
  type Segmentation,
} from './meta-media.js';

/**
 * SAM 3.1 on Meta's API follows at most 16 objects in one request, however long the video or big
 * the photo, and no setting raises it. Once it has 16, anything new is never found: on a 20-second
 * pan past 32 windows, one request found 16 and nothing after the first 3 seconds.
 *
 * So a request that comes back full is asked again in pieces, each its own request: shorter
 * stretches of the video when the objects pass by, or the left and right of the picture when one
 * frame already shows nearly 16. Pieces overlap a little, and an object seen in two of them is
 * joined into one by where it sits on the frames both saw.
 */
export const SAM_LIMIT = 16;

/** Frames [start, end) and a rectangle of a video, or of a photo as one frame. */
export type Region = {
  start: number;
  end: number;
  left: number;
  top: number;
  width: number;
  height: number;
};
export type Piece = { region: Region; segmentation: Segmentation };
/** Every match SAM found. `full` when some part still had more than it could follow. */
export type FullSegmentation = Segmentation & { full: boolean };

/** Shortest stretch of video worth its own request: SAM bills at least 50 frames for each. */
const MIN_FRAMES = 60;
/** Frames two stretches share, so an object crossing from one to the next is seen in both. */
const OVERLAP_FRAMES = 15;
/** Each half of a split picture is 60% of it, so anything narrower than a fifth is whole in one. */
const HALF = 0.6;
/** Smallest picture worth splitting again, in pixels across. */
const MIN_SIDE = 160;
/** Most extra requests one phrase can take, so a crowded video can't run up the bill. */
const MAX_REQUESTS = 24;
/** Two boxes are one object when they overlap this much (intersection over union). */
const SAME_OBJECT = 0.5;
/** A box holds another when this much of the other lies inside it. */
const HOLDS = 0.8;

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

export function isFull(segmentation: Segmentation) {
  return new Set(segmentation.objects.map((object) => object.id)).size >= SAM_LIMIT;
}

function mostInOneFrame(segmentation: Segmentation) {
  const perFrame = new Map<number, number>();
  for (const object of segmentation.objects)
    perFrame.set(object.frame, (perFrame.get(object.frame) ?? 0) + 1);
  return Math.max(0, ...perFrame.values());
}

/** The frame by which SAM had all the objects it could follow. */
function frameFilled(segmentation: Segmentation) {
  const first = new Map<string, number>();
  for (const object of segmentation.objects)
    first.set(object.id, Math.min(first.get(object.id) ?? Infinity, object.frame));
  return [...first.values()].sort((a, b) => a - b)[SAM_LIMIT - 1] ?? 0;
}

/** The left and right halves of a picture, or the top and bottom of a tall one, overlapping. */
function splitPicture(region: Region): Region[] {
  if (Math.max(region.width, region.height) < MIN_SIDE * 2) return [];
  const across = region.width >= region.height;
  const side = across ? region.width : region.height;
  const half = even(side * HALF);
  return [0, side - half].map((offset) =>
    across
      ? { ...region, left: region.left + offset, width: half }
      : { ...region, top: region.top + offset, height: half },
  );
}

/**
 * A region that came back full, cut into pieces that should each come back under the limit. With
 * nearly 16 on one frame, shorter pieces can't help, so the picture is split. Otherwise the video is
 * cut into stretches a little shorter than it took SAM to fill up.
 */
export function splitRegion(region: Region, segmentation: Segmentation): Region[] {
  const frames = region.end - region.start;
  if (mostInOneFrame(segmentation) >= SAM_LIMIT - 4 || frames < MIN_FRAMES * 2)
    return splitPicture(region);
  const length = Math.max(MIN_FRAMES, Math.floor(frameFilled(segmentation) * 0.6));
  const count = Math.min(8, Math.max(2, Math.ceil(frames / length)));
  const step = Math.ceil((frames - OVERLAP_FRAMES) / count);
  return Array.from({ length: count }, (_, index) => ({
    ...region,
    start: region.start + index * step,
    end: index === count - 1 ? region.end : region.start + (index + 1) * step + OVERLAP_FRAMES,
  }));
}

/**
 * SAM gives look-alike objects it sees one after another the same id: filming along a row of
 * identical windows, the id of one that went out of the left of the picture came back on a new one
 * coming in on the right. So an id that turns up more than its own width or height from where it
 * was last seen is a new object from there on. One hidden for a moment, behind a tree, comes back
 * where it was and stays one.
 */
export function splitJumps(segmentation: Segmentation): Segmentation {
  const last = new Map<string, { object: SamObject; part: number }>();
  const objects = [...segmentation.objects]
    .sort((a, b) => a.frame - b.frame)
    .map((object) => {
      const before = last.get(object.id);
      let part = before?.part ?? 0;
      if (before) {
        const [a, b] = [before.object.box, object.box];
        const width = Math.max(a.right - a.left, b.right - b.left);
        const height = Math.max(a.bottom - a.top, b.bottom - b.top);
        if (
          Math.abs(a.left + a.right - b.left - b.right) / 2 > width ||
          Math.abs(a.top + a.bottom - b.top - b.bottom) / 2 > height
        )
          part++;
      }
      last.set(object.id, { object, part });
      return part ? { ...object, id: `${object.id}~${part}` } : object;
    });
  return { ...segmentation, objects };
}

const area = (box: SamBox) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
function clip(box: SamBox, to: SamBox): SamBox {
  return {
    left: Math.max(box.left, to.left),
    top: Math.max(box.top, to.top),
    right: Math.min(box.right, to.right),
    bottom: Math.min(box.bottom, to.bottom),
  };
}

/**
 * The pieces put back together: each piece's objects on the whole video's frames and pixels, with
 * an object two pieces both saw joined into one. Boxes are compared only inside the part of the
 * picture both pieces show, since one cut off at a piece's edge is still the same object. Video
 * pieces have to agree on at least two shared frames; a photo has only one.
 *
 * SAM sometimes outlines two or three neighbouring windows as one. When another piece saw them
 * apart, that one box is dropped, so they're counted apart instead of being joined into one.
 */
export function joinPieces(
  pieces: Piece[],
  size: { width: number; height: number; scale: number },
) {
  const place = (box: SamBox, region: Region): SamBox => ({
    left: Math.round((box.left + region.left) * size.scale),
    top: Math.round((box.top + region.top) * size.scale),
    right: Math.round((box.right + region.left) * size.scale),
    bottom: Math.round((box.bottom + region.top) * size.scale),
  });
  const placed = pieces.flatMap(({ region, segmentation }, piece) =>
    splitJumps(segmentation).objects.map((object) => ({
      piece,
      object: {
        ...object,
        id: `${piece}:${object.id}`,
        frame: object.frame + region.start,
        box: place(object.box, region),
        pixels: Math.round(object.pixels * size.scale * size.scale),
        mask: { ...object.mask, bounds: place(object.mask.bounds, region) },
      },
    })),
  );

  const shown = pieces.map(({ region }) =>
    place({ left: 0, top: 0, right: region.width, bottom: region.height }, region),
  );
  const byFrame = new Map<number, typeof placed>();
  for (const entry of placed) {
    const list = byFrame.get(entry.object.frame) ?? [];
    list.push(entry);
    byFrame.set(entry.object.frame, list);
  }
  const agreed = new Map<string, number>();
  const holding = new Map<string, number>();
  for (const list of byFrame.values()) {
    // The boxes other pieces saw inside each box on this frame.
    const holds = new Map<string, SamBox[]>();
    for (const a of list)
      for (const b of list) {
        if (a.piece >= b.piece) continue;
        const both = clip(shown[a.piece], shown[b.piece]);
        const boxA = clip(a.object.box, both);
        const boxB = clip(b.object.box, both);
        const common = area(clip(boxA, boxB));
        if (!common) continue;
        if (common / (area(boxA) + area(boxB) - common) >= SAME_OBJECT) {
          const pair = `${a.object.id}|${b.object.id}`;
          agreed.set(pair, (agreed.get(pair) ?? 0) + 1);
          continue;
        }
        for (const [outer, inner, innerBox] of [
          [a, b, boxB],
          [b, a, boxA],
        ] as const)
          if (common / Math.max(1, area(innerBox)) >= HOLDS)
            holds.set(outer.object.id, [...(holds.get(outer.object.id) ?? []), inner.object.box]);
      }
    // Two of them side by side, not the same one seen twice, make it a group.
    for (const [id, held] of holds)
      if (held.some((one, i) => held.slice(i + 1).some((other) => !area(clip(one, other)))))
        holding.set(id, (holding.get(id) ?? 0) + 1);
  }
  const needed = pieces.every(({ region }) => region.end - region.start <= 1) ? 1 : 2;
  const grouped = new Set([...holding].filter(([, frames]) => frames >= needed).map(([id]) => id));

  // Joined strongest first, and never two objects one piece saw apart.
  const parent = new Map<string, string>();
  const members = new Map<string, Set<number>>();
  const root = (id: string): string => {
    const up = parent.get(id);
    return up ? root(up) : id;
  };
  const pieceOf = (id: string) => Number(id.split(':')[0]);
  for (const [pair] of [...agreed]
    .filter(([pair, frames]) => frames >= needed && !pair.split('|').some((id) => grouped.has(id)))
    .sort((a, b) => b[1] - a[1])) {
    const [a, b] = pair.split('|').map(root);
    const inA = members.get(a) ?? new Set([pieceOf(a)]);
    const inB = members.get(b) ?? new Set([pieceOf(b)]);
    if (a === b || [...inB].some((piece) => inA.has(piece))) continue;
    parent.set(b, a);
    members.set(a, new Set([...inA, ...inB]));
  }

  // Where two pieces saw the same object on a frame, the fuller view of it is kept.
  const kept = new Map<string, SamObject>();
  for (const { object } of placed) {
    if (grouped.has(object.id)) continue;
    const id = root(object.id);
    const key = `${id}@${object.frame}`;
    const seen = kept.get(key);
    if (!seen || object.pixels > seen.pixels) kept.set(key, { ...object, id });
  }
  return {
    width: size.width,
    height: size.height,
    objects: [...kept.values()].sort((a, b) => a.frame - b.frame),
  };
}

/** Asks for each full region again in pieces, until each comes back under the limit. */
async function inPieces(
  whole: Piece,
  ask: (region: Region) => Promise<Segmentation>,
): Promise<{ pieces: Piece[]; full: boolean }> {
  const pieces: Piece[] = [];
  let requests = 0;
  let full = false;
  async function settle(piece: Piece): Promise<void> {
    if (!isFull(piece.segmentation)) {
      pieces.push(piece);
      return;
    }
    const parts = splitRegion(piece.region, piece.segmentation);
    if (!parts.length || requests + parts.length > MAX_REQUESTS) {
      full = true;
      pieces.push(piece);
      return;
    }
    requests += parts.length;
    const found = await Promise.all(parts.map(ask));
    await Promise.all(parts.map((region, index) => settle({ region, segmentation: found[index] })));
  }
  await settle(whole);
  return { pieces, full };
}

const run = promisify(execFile);

/**
 * Cuts one customer video for SAM, for every phrase that needs it. The video is first made at most
 * 1280 pixels across and 30 frames a second, so pieces are quick to cut and their frames line up.
 */
export function videoCutter(video: { bytes: Buffer }) {
  let ready: Promise<{
    folder: string;
    file: string;
    width: number;
    height: number;
    fps: number;
    frames: number;
  }> | null = null;
  let cut = 0;
  async function prepare() {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-sam-'));
    try {
      return { folder, ...(await shrink(folder)) };
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
  }
  async function shrink(folder: string) {
    const original = path.join(folder, 'original');
    const file = path.join(folder, 'video.mp4');
    await fs.writeFile(original, video.bytes);
    const probe = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=avg_frame_rate',
        '-of',
        'csv=p=0',
        original,
      ],
      { timeout: 20_000 },
    );
    const [num, den] = probe.stdout.trim().split('/').map(Number);
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        original,
        '-an',
        '-vf',
        "fps=30,scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        file,
      ],
      { timeout: 120_000 },
    );
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_packets',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,nb_read_packets',
        '-of',
        'csv=p=0',
        file,
      ],
      { timeout: 20_000 },
    );
    const [width, height, frames] = stdout.trim().split(',').map(Number);
    return { file, width, height, frames, fps: num > 0 && den > 0 ? num / den : 30 };
  }

  return {
    /** Every match for one phrase, past SAM's limit, starting from its pass over the whole video. */
    async segment(phrase: string, first: Segmentation): Promise<FullSegmentation> {
      if (!isFull(first)) return { ...splitJumps(first), full: false };
      try {
        return await again(phrase, first);
      } catch {
        // Without ffmpeg, or with a piece SAM couldn't read, the whole-video count is the floor.
        return { ...splitJumps(first), full: true };
      }
    },
    async close() {
      const prepared = await ready?.catch(() => null);
      if (prepared) await fs.rm(prepared.folder, { recursive: true, force: true });
    },
  };

  async function again(phrase: string, first: Segmentation): Promise<FullSegmentation> {
    ready ??= prepare();
    const prepared = await ready;
    // The whole-video pass, moved onto the cut video's frames and pixels.
    const scale = first.width > 0 ? first.width / prepared.width : 1;
    const timing = 30 / prepared.fps;
    const onCut = (box: SamBox): SamBox => ({
      left: box.left / scale,
      top: box.top / scale,
      right: box.right / scale,
      bottom: box.bottom / scale,
    });
    const whole: Piece = {
      region: {
        start: 0,
        end: prepared.frames,
        left: 0,
        top: 0,
        width: prepared.width,
        height: prepared.height,
      },
      segmentation: {
        ...first,
        objects: first.objects.map((object) => ({
          ...object,
          frame: Math.round(object.frame * timing),
          box: onCut(object.box),
          pixels: object.pixels / (scale * scale),
          mask: { ...object.mask, bounds: onCut(object.mask.bounds) },
        })),
      },
    };
    const { pieces, full } = await inPieces(whole, async (region) => {
      const out = path.join(prepared.folder, `piece-${cut++}.mp4`);
      await run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          prepared.file,
          '-an',
          '-vf',
          `trim=start_frame=${region.start}:end_frame=${region.end},setpts=PTS-STARTPTS,crop=${region.width}:${region.height}:${region.left}:${region.top}`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          out,
        ],
        { timeout: 120_000 },
      );
      const fileId = await uploadMetaFile(await fs.readFile(out), path.basename(out), 'video/mp4');
      try {
        return await segment(phrase, { videoFileId: fileId });
      } finally {
        void deleteMetaFile(fileId).catch(() => {});
        await fs.rm(out, { force: true });
      }
    });
    return { ...joinPieces(pieces, { width: first.width, height: first.height, scale }), full };
  }
}

/** Every match for one phrase in a photo, past SAM's limit: a full photo is asked again in halves. */
export async function segmentPhoto(phrase: string, image: AiImage): Promise<FullSegmentation> {
  const first = await segment(phrase, { image });
  if (!isFull(first)) return { ...first, full: false };
  try {
    return await photoInPieces(phrase, image, first);
  } catch {
    return { ...first, full: true };
  }
}

async function photoInPieces(
  phrase: string,
  image: AiImage,
  first: Segmentation,
): Promise<FullSegmentation> {
  // Upright, as SAM reads it, so the halves' pixels match the whole photo's.
  const upright = await sharp(Buffer.from(image.dataBase64, 'base64'))
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = upright.info;
  const { pieces, full } = await inPieces(
    { region: { start: 0, end: 1, left: 0, top: 0, width, height }, segmentation: first },
    async (region) => {
      const part = await sharp(upright.data)
        .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
        .jpeg({ quality: 90 })
        .toBuffer();
      return segment(phrase, {
        image: { mimeType: 'image/jpeg', dataBase64: part.toString('base64') },
      });
    },
  );
  return {
    ...joinPieces(pieces, {
      width: first.width || width,
      height: first.height || height,
      scale: 1,
    }),
    full,
  };
}
