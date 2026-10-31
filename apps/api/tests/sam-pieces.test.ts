import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import sharp from 'sharp';

process.env.AI_PROVIDER = 'meta';
process.env.META_API_KEY = 'test-meta-key-not-real';

let pieces: typeof import('../src/ai/sam-pieces.js');
let walkaround: typeof import('../src/ai/walkaround.js');
before(async () => {
  pieces = await import('../src/ai/sam-pieces.js');
  walkaround = await import('../src/ai/walkaround.js');
});
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});

type Box = { left: number; top: number; right: number; bottom: number };
const box = (left: number, top: number, width: number, height = 60): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
function object(id: string, frame: number, at: Box) {
  return {
    id,
    frame,
    box: at,
    confidence: 0.9,
    pixels: (at.right - at.left) * (at.bottom - at.top),
    mask: { raster: new Uint8Array([1]), width: 1, height: 1, bounds: at },
  };
}
/** One object seen on every frame from `from` up to `to`, sliding `speed` pixels left a frame. */
function track(id: string, from: number, to: number, x: number, speed = 0, top = 100) {
  return Array.from({ length: to - from }, (_, index) =>
    object(id, from + index, box(x - speed * (from + index), top, 40)),
  );
}
const region = (start: number, end: number, left = 0, width = 1280) => ({
  start,
  end,
  left,
  top: 0,
  width,
  height: 720,
});
const ids = (segmentation: { objects: { id: string }[] }) =>
  new Set(segmentation.objects.map((item) => item.id)).size;

test('a full pass is split by time when objects pass by, and by picture when one frame is crowded', () => {
  // Sixteen windows coming into view one every 20 frames, a few on screen at once.
  const passing = {
    width: 1280,
    height: 720,
    objects: Array.from({ length: 16 }, (_, index) =>
      track(String(index), index * 20, index * 20 + 60, 1200),
    ).flat(),
  };
  const byTime = pieces.splitRegion(region(0, 600), passing);
  assert.ok(byTime.length >= 2);
  assert.equal(byTime[0].start, 0);
  assert.equal(byTime.at(-1)!.end, 600);
  for (let index = 1; index < byTime.length; index++)
    assert.ok(byTime[index].start < byTime[index - 1].end, 'neighbouring pieces share frames');
  assert.ok(byTime.every((piece) => piece.width === 1280 && piece.left === 0));

  // Sixteen in the very first frame: shorter pieces can't help.
  const crowded = {
    width: 1280,
    height: 720,
    objects: Array.from({ length: 16 }, (_, index) =>
      track(String(index), 0, 10, index * 70),
    ).flat(),
  };
  const byPicture = pieces.splitRegion(region(0, 600), crowded);
  assert.equal(byPicture.length, 2);
  assert.ok(byPicture.every((piece) => piece.start === 0 && piece.end === 600));
  assert.equal(byPicture[0].left, 0);
  assert.ok(byPicture[1].left < byPicture[0].left + byPicture[0].width, 'the halves overlap');
  assert.equal(byPicture[1].left + byPicture[1].width, 1280);
});

test('pieces join back with an object that crosses from one to the next counted once', () => {
  const first = region(0, 115);
  const second = region(100, 200);
  const joined = pieces.joinPieces(
    [
      {
        region: first,
        segmentation: {
          width: 1280,
          height: 720,
          objects: [...track('a', 0, 115, 900, 2), ...track('b', 0, 40, 300, 2)],
        },
      },
      {
        region: second,
        // The same window as "a", on the second piece's own frames, plus one that comes in later.
        segmentation: {
          width: 1280,
          height: 720,
          objects: [
            ...Array.from({ length: 100 }, (_, frame) =>
              object('a', frame, box(900 - 2 * (frame + 100), 100, 40)),
            ),
            ...Array.from({ length: 60 }, (_, frame) =>
              object('c', frame + 40, box(1200 - 2 * (frame + 140), 100, 40)),
            ),
          ],
        },
      },
    ],
    { width: 1280, height: 720, scale: 1 },
  );
  assert.equal(ids(joined), 3);
  const a = joined.objects.filter(
    (item) => item.id === joined.objects.find((o) => o.frame === 0 && o.box.left === 900)!.id,
  );
  assert.equal(a.length, 200, 'one object on every frame, the shared ones once');
  assert.equal(walkaround.trackedObjects(joined).length, 3);
});

test('a window cut off at the edge of one half is the same window the other half saw whole', () => {
  const left = region(0, 10, 0, 768);
  const right = region(0, 10, 512, 768);
  const joined = pieces.joinPieces(
    [
      // Cut off at the left half's edge: 740 to 768.
      {
        region: left,
        segmentation: {
          width: 768,
          height: 720,
          objects: track('x', 0, 10, 740).map((o) => object(o.id, o.frame, box(740, 100, 28))),
        },
      },
      // The right half sees it whole, at 228 in its own pixels, 740 in the picture's.
      {
        region: right,
        segmentation: {
          width: 768,
          height: 720,
          objects: track('y', 0, 10, 228).map((o) => object(o.id, o.frame, box(228, 100, 60))),
        },
      },
    ],
    { width: 1280, height: 720, scale: 1 },
  );
  assert.equal(ids(joined), 1);
  // The fuller view is the one kept.
  assert.equal(joined.objects[0].box.right - joined.objects[0].box.left, 60);
});

test('one box around two windows another piece saw apart is dropped, not counted as one', () => {
  const left = region(0, 10, 0, 768);
  const right = region(0, 10, 512, 768);
  const joined = pieces.joinPieces(
    [
      {
        region: left,
        segmentation: {
          width: 768,
          height: 720,
          objects: [
            ...track('pair', 0, 10, 0).map((o) => object(o.id, o.frame, box(560, 100, 200))),
          ],
        },
      },
      {
        region: right,
        segmentation: {
          width: 768,
          height: 720,
          objects: [
            ...track('one', 0, 10, 0).map((o) => object(o.id, o.frame, box(50, 100, 90))),
            ...track('two', 0, 10, 0).map((o) => object(o.id, o.frame, box(150, 100, 90))),
          ],
        },
      },
    ],
    { width: 1280, height: 720, scale: 1 },
  );
  assert.equal(ids(joined), 2);
});

test('an id that turns up somewhere else is a new object; one that comes back where it was is not', () => {
  const split = pieces.splitJumps({
    width: 1280,
    height: 720,
    objects: [
      // Goes out on the left at frame 9, and its id comes back on a new window on the right.
      ...track('0', 0, 10, 40, 4),
      ...track('0', 40, 50, 1240, 4),
      // Hidden for a moment, then back in the same place.
      ...track('1', 0, 10, 600),
      ...track('1', 30, 40, 600),
    ],
  });
  assert.equal(ids(split), 3);
});

const MASK = "data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
function samText(found: Box[], width: number, height: number) {
  return `<0f>${found
    .map(
      (at, id) =>
        `${id}<|box;x1=${at.left};y1=${at.top};x2=${at.right - 1};y2=${at.bottom - 1};w=${width};h=${height};c=0.9|><|mask;x=0;y=0;c=0.9;${MASK}|>`,
    )
    .join(',')}\n`;
}
function responses(text: string) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
}

test('a photo with more than 16 windows is asked again in halves and counted in full', async () => {
  // Twenty windows in two rows of ten. The left of the photo is black and the middle grey, so a
  // half can be told apart by its first pixel.
  const windows = [100, 300].flatMap((top) =>
    Array.from({ length: 10 }, (_, index) => box(20 + index * 95, top, 40)),
  );
  const photo = await sharp({
    create: { width: 1000, height: 400, channels: 3, background: '#ffffff' },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 400, height: 400, channels: 3, background: '#000000' },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
      {
        input: await sharp({
          create: { width: 200, height: 400, channels: 3, background: '#808080' },
        })
          .png()
          .toBuffer(),
        left: 400,
        top: 0,
      },
    ])
    .jpeg()
    .toBuffer();
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const image = Buffer.from(body.input[0].content[1].image_url.split(',')[1], 'base64');
    const { width = 0, height = 0 } = await sharp(image).metadata();
    if (width === 1000) return responses(samText(windows.slice(0, 16), width, height));
    const [first] = await sharp(image)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    const left = first < 60 ? 0 : 400;
    const seen = windows
      .filter((at) => at.right > left && at.left < left + width)
      .map((at) => ({
        left: Math.max(at.left, left) - left,
        top: at.top,
        right: Math.min(at.right, left + width) - left,
        bottom: at.bottom,
      }));
    return responses(samText(seen, width, height));
  };
  const found = await pieces.segmentPhoto('window', {
    mimeType: 'image/jpeg',
    dataBase64: photo.toString('base64'),
  });
  assert.equal(requests, 3);
  assert.equal(found.full, false);
  assert.equal(ids(found), 20);
});

test('a count that is only the least there are says so to the chat', () => {
  const notes = walkaround.notesFor({
    source: 'video',
    summary: '',
    narration: '',
    serviceName: 'Exterior windows',
    counts: [
      {
        label: 'windows',
        phrase: 'window',
        unit: 'windows',
        count: 16,
        sparkCount: 30,
        atLeast: true,
      },
    ],
    area: null,
    quantity: 16,
    unit: 'windows',
    condition: '',
    access: '',
    extras: [],
    overlays: [],
  });
  assert.ok(notes.some((note) => note.includes('at least 16 windows')));
  assert.ok(notes.some((note) => note.includes('confirm the number')));
});

test('pieces cut at 30 frames a second go back on the video’s own frames', () => {
  const seen = (id: string, frame: number, pixels: number) => ({
    ...object(id, frame, box(10, 10, 20)),
    pixels,
  });
  // Filmed at 60: frame 5 of the cut is frame 10 of the video.
  assert.deepEqual(
    pieces.onFrames([seen('a', 5, 100)], 2).map((item) => item.frame),
    [10],
  );
  // Filmed at 15: two of the cut's frames are one of the video's, and the fuller sighting stays.
  const merged = pieces.onFrames([seen('a', 3, 300), seen('a', 4, 100), seen('b', 4, 50)], 0.5);
  assert.deepEqual(
    merged.map((item) => [item.id, item.frame, item.pixels]),
    [
      ['a', 2, 300],
      ['b', 2, 50],
    ],
  );
  const same = [seen('a', 1, 10)];
  assert.equal(pieces.onFrames(same, 1), same);
});
