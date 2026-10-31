import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { AiImage } from './index.js';

const run = promisify(execFile);
/** Frames taken out at once, each its own short ffmpeg run. */
const AT_ONCE = 4;

/**
 * Frames of a customer's video by number, as SAM numbers them: every frame as filmed. Each is
 * taken out with ffmpeg on its own, decoding only from the keyframe before it, so a few dozen take
 * a second or two. A frame that can't be taken out, or a server without ffmpeg, is left out.
 */
export function videoFrames(video: { bytes: Buffer }) {
  let ready: Promise<{ folder: string; file: string; fps: number }> | null = null;
  async function prepare() {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-frames-'));
    const file = path.join(folder, 'video');
    await fs.writeFile(file, video.bytes);
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
        file,
      ],
      { timeout: 20_000 },
    );
    const [num, den] = probe.stdout.trim().split('/').map(Number);
    return { folder, file, fps: num > 0 && den > 0 ? num / den : 30 };
  }
  async function one(frame: number): Promise<AiImage> {
    ready ??= prepare();
    const { folder, file, fps } = await ready;
    const out = path.join(folder, `${frame}.jpg`);
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        (frame / fps).toFixed(3),
        '-i',
        file,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        out,
      ],
      { timeout: 20_000 },
    );
    return { mimeType: 'image/jpeg', dataBase64: (await fs.readFile(out)).toString('base64') };
  }
  // Asked for twice, a frame is taken out once.
  const asked = new Map<number, Promise<AiImage | null>>();
  const frameAt = (frame: number) => {
    if (!asked.has(frame))
      asked.set(
        frame,
        one(frame).catch(() => null),
      );
    return asked.get(frame)!;
  };
  return {
    async take(frames: number[]): Promise<Map<number, AiImage>> {
      const wanted = [...new Set(frames)].filter((frame) => frame >= 0);
      const taken = new Map<number, AiImage>();
      for (let at = 0; at < wanted.length; at += AT_ONCE)
        await Promise.all(
          wanted.slice(at, at + AT_ONCE).map(async (frame) => {
            const image = await frameAt(frame);
            if (image) taken.set(frame, image);
          }),
        );
      return taken;
    },
    async close() {
      const prepared = await ready?.catch(() => null);
      if (prepared) await fs.rm(prepared.folder, { recursive: true, force: true });
    },
  };
}
export type VideoFrames = ReturnType<typeof videoFrames>;

/** How sharp a picture is: how strongly its edges stand out. One blurred by moving scores low. */
export async function sharpness(image: AiImage): Promise<number> {
  const { channels } = await sharp(Buffer.from(image.dataBase64, 'base64'))
    .rotate()
    .greyscale()
    .resize(512, 512, { fit: 'inside' })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .stats();
  return channels[0]?.stdev ?? 0;
}
