import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import sharp from 'sharp';

// Walk-around videos only run on Meta's models. Set before anything loads the AI module.
process.env.AI_PROVIDER = 'meta';
process.env.META_API_KEY = 'test-meta-key-not-real';
delete process.env.META_MODEL;
delete process.env.META_VIDEO_MODEL;

let media: typeof import('../src/ai/meta-media.js');
let walkaround: typeof import('../src/ai/walkaround.js');
let videos: typeof import('../src/live/videos.js');
before(async () => {
  media = await import('../src/ai/meta-media.js');
  walkaround = await import('../src/ai/walkaround.js');
  videos = await import('../src/live/videos.js');
});
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// Two real masks from Meta's SAM docs: a 27×60 and a 27×48 raster on a 320×334 frame.
const MASK_A = "data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
const MASK_B = 'data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@';
const record = (id: number, box: string, mask: string, c = 0.9) =>
  `${id}<|box;${box};w=320;h=334;c=${c}|><|mask;x=0;y=0;c=${c};${mask}|>`;
const A = record(0, 'x1=211;y1=228;x2=270;y2=254', MASK_A);
const B = record(1, 'x1=155;y1=228;x2=202;y2=254', MASK_B);
// Object 2 is only glimpsed, on two frames, so it isn't counted.
const GLIMPSE = record(2, 'x1=211;y1=228;x2=270;y2=254', MASK_A, 0.8);

/** Objects 0 and 1 on frames 0 to 7, and the glimpse on frames 3 and 4. */
function videoOutput() {
  return Array.from(
    { length: 8 },
    (_, frame) =>
      `<${frame}f>${[A, B, ...(frame === 3 || frame === 4 ? [GLIMPSE] : [])].join(',')}`,
  ).join('\n');
}

function responses(text: string, status = 'completed') {
  return Response.json({
    status,
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

test('SAM output from Meta’s docs reads into objects with boxes and mask areas', async () => {
  const result = await media.parseSegmentation(`<0f>${A},${B}\n`);
  assert.equal(result.width, 320);
  assert.equal(result.height, 334);
  assert.deepEqual(
    result.objects.map((object) => object.id),
    ['0', '1'],
  );
  assert.deepEqual(result.objects[0].box, { left: 211, top: 228, right: 271, bottom: 255 });
  assert.equal(result.objects[0].confidence, 0.9);
  assert.ok(result.objects[0].pixels > 0 && result.objects[0].pixels <= 60 * 27);
  assert.equal((await media.parseSegmentation('')).objects.length, 0);
});

test('a video counts each object once, and drops glimpses', async () => {
  const segmentation = await media.parseSegmentation(videoOutput());
  assert.equal(segmentation.objects.length, 18);
  const tracked = walkaround.trackedObjects(segmentation);
  assert.deepEqual(tracked.map((track) => track.best.id).sort(), ['0', '1']);
  assert.equal(walkaround.busiestFrame(segmentation, new Set(['0', '1'])), 0);
});

test('a frame finds the customer’s nearest still', () => {
  const stills = [
    { id: 'a', ms: 0 },
    { id: 'b', ms: 5000 },
    { id: 'c', ms: 10000 },
  ];
  assert.equal(walkaround.nearestStill(stills, 150, 300, 10000)?.id, 'b');
  assert.equal(walkaround.nearestStill(stills, 290, 300, 10000)?.id, 'c');
  // Without a duration, frames are taken as 30 a second.
  assert.equal(walkaround.nearestStill(stills, 30, 0, null)?.id, 'a');
  assert.equal(walkaround.nearestStill([], 30, 300, 10000), null);
});

test('videos are recognised by their contents, not their names', () => {
  const box = (type: string, brand = 'isom') =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(type + brand, 'ascii')]);
  assert.equal(videos.videoKind(box('ftyp')), 'mp4');
  assert.equal(videos.videoKind(box('ftyp', 'qt  ')), 'mov');
  assert.equal(videos.videoKind(box('moov')), 'mov');
  assert.equal(videos.videoKind(Buffer.from('not a video at all')), null);
});

test('a walk-around is watched by Muse Spark, counted by SAM and drawn on the customer’s still', async () => {
  const still = await sharp({
    create: { width: 320, height: 334, channels: 3, background: '#d9d4c7' },
  })
    .jpeg()
    .toBuffer();
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-meta-key-not-real');
    if (body.model !== 'sam-3.1')
      return responses(
        JSON.stringify({
          summary: 'Two-story house with 2 front windows.',
          narration: 'They want the screens done too.',
          serviceName: 'exterior windows',
          counts: [{ label: 'windows', phrase: 'window', estimate: 3 }],
          area: {
            surface: 'driveway',
            phrase: 'driveway',
            low: 500,
            high: 650,
            unit: 'sq ft',
            basis: 'the two-car garage door',
          },
          condition: 'dusty',
          access: 'second story',
          extras: ['screens'],
        }),
      );
    const [phrase, part] = body.input[0].content;
    assert.deepEqual(body.metadata, { include_confidence: 'true', mask_encoding: 'one_bit' });
    if (part.type === 'input_video') {
      assert.equal(part.file_id, 'file-walkaround');
      return responses(phrase.text === 'window' ? videoOutput() : '');
    }
    return responses(phrase.text === 'window' ? `<0f>${A},${B}\n` : '');
  };
  const saved: Buffer[] = [];
  const result = await walkaround.measureWalkaround({
    business: { name: 'Clear View', trade: 'Window cleaning', services: ['Exterior windows'] },
    serviceName: '',
    priceUnits: { 'exterior windows': ['windows'] },
    videoFileId: 'file-walkaround',
    frames: [
      {
        id: 'still-0',
        ms: 0,
        image: { mimeType: 'image/jpeg', dataBase64: still.toString('base64') },
      },
    ],
    durationMs: 8000,
    saveOverlay: async (jpeg) => {
      saved.push(jpeg);
      return `overlay-${saved.length}.jpg`;
    },
  });

  const read = calls.find((call) => call.body.model !== 'sam-3.1')!;
  assert.equal(read.body.model, 'muse-spark-1.2');
  assert.deepEqual(read.body.input[0].content.at(-1), {
    type: 'input_video',
    file_id: 'file-walkaround',
  });
  assert.equal(result.serviceName, 'Exterior windows');
  assert.deepEqual(result.counts, [
    { label: 'windows', phrase: 'window', unit: 'windows', count: 2, sparkCount: 3 },
  ]);
  assert.deepEqual(result.area, {
    surface: 'driveway',
    low: 500,
    high: 650,
    unit: 'sq ft',
    basis: 'the two-car garage door',
  });
  // Priced by the window, as this owner prices the service.
  assert.equal(result.quantity, 2);
  assert.equal(result.unit, 'windows');
  assert.deepEqual(result.overlays, [
    { label: 'windows', frameId: 'still-0', storageKey: 'overlay-1.jpg' },
  ]);
  const drawn = await sharp(saved[0]).metadata();
  assert.equal(drawn.width, 320);
  assert.equal(drawn.height, 334);
  assert.ok(result.notes.some((note) => note.includes('2 windows')));
  assert.ok(result.notes.some((note) => note.includes('about 3')));
  assert.ok(result.notes.some((note) => note.includes('500 to 650 sq ft')));
  assert.ok(result.notes.some((note) => note.includes('screens done too')));
});

test('a SAM failure fails the measuring instead of inventing a count', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'sam-3.1') return new Response('busy', { status: 503 });
    return responses(
      JSON.stringify({
        summary: '',
        narration: '',
        serviceName: '',
        counts: [{ label: 'windows', phrase: 'window', estimate: 4 }],
        area: { surface: '', phrase: '', low: null, high: null, unit: '', basis: '' },
        condition: '',
        access: '',
        extras: [],
      }),
    );
  };
  await assert.rejects(
    walkaround.measureWalkaround({
      business: { name: 'Clear View', trade: 'Window cleaning', services: [] },
      serviceName: '',
      priceUnits: {},
      videoFileId: 'file-walkaround',
      frames: [],
      durationMs: null,
      saveOverlay: async () => 'unused.jpg',
    }),
    /couldn’t be measured/,
  );
});
