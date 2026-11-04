import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import {
  newOwnerLessons,
  newOwnerSituations,
  planCustomer,
  SITUATION_LESSONS,
  SITUATIONS,
} from '../src/practice/plan.js';
import type { PracticePhoto, Project } from '../src/practice/types.js';

const saved = { ...process.env };
const realFetch = globalThis.fetch;
let photo: Buffer;
let sets: typeof import('../src/practice/photo-set.js');

/** What was asked of the image and check models, in order. */
let calls: { url: string; body: Record<string, any> }[];
/** What each check answers, in turn. The last repeats. */
let checks: { fits: boolean; broken?: boolean; why?: string }[][];
let showsJob: boolean[];
let failEdits = false;

const image = () => ({ data: [{ b64_json: photo.toString('base64') }] });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

before(async () => {
  process.env.AI_PROVIDER = 'meta';
  process.env.META_API_KEY = 'test-key-not-a-real-provider-credential';
  process.env.META_MODEL = 'mock-model';
  photo = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  sets = await import('../src/practice/photo-set.js');
});

after(() => {
  process.env = saved;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  checks = [];
  showsJob = [];
  failEdits = false;
  delete process.env.PRACTICE_PHOTO_SETS;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/images/generations')) return json(image());
    if (String(url).endsWith('/images/edits'))
      return failEdits ? json({ error: 'no' }, 500) : json(image());
    const answer = checks.length > 1 ? checks.shift()! : checks[0];
    return json({
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 10 },
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                photos: answer.map((item) => ({ broken: false, why: '', ...item })),
                showsJob: showsJob.length > 1 ? showsJob.shift()! : (showsJob[0] ?? true),
              }),
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
});

const project = (parts: Partial<Project> = {}): Project => ({
  summary: 'Wash the driveway.',
  teaches: 'what tire marks add',
  shows: ['the whole driveway', 'the tire marks'],
  places: [{ name: 'my house', look: 'Tan siding, two brown garage doors, black tire marks.' }],
  photoSet: 'overview_detail',
  ...parts,
});
const photos = (...places: number[]): PracticePhoto[] =>
  places.map((place, index) => ({ scene: `Photo ${index}`, photoId: null, place }));
const input = (set: PracticePhoto[], details: Partial<Project> = {}) => ({
  owner: 'business',
  title: 'Driveway photo',
  project: project(details),
  photos: set,
  spend: <T>(task: () => Promise<T>) => task(),
});
const made = (ending: string) => calls.filter((call) => call.url.endsWith(ending));

test('every photo of a place comes from the first one, which comes from words', async () => {
  checks = [[{ fits: true }, { fits: true }]];
  const shots = await sets.drawPhotoSet(input(photos(0, 0)));
  assert.equal(shots.filter(Boolean).length, 2);
  assert.equal(made('/images/generations').length, 1);
  const [edit] = made('/images/edits');
  assert.equal(edit.body.images.length, 1);
  assert.match(edit.body.images[0].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(edit.body.reasoning_strength, 'low');
  assert.deepEqual(edit.body.tool_enablement, {
    enable_image_search: false,
    enable_web_search: false,
    enable_shell: false,
  });
  // What the customer or the owner wrote goes in as data, after the instructions.
  const prompt: string = edit.body.prompt;
  assert.ok(prompt.indexOf('untrusted scene DATA') < prompt.indexOf('Photo 1'));
  assert.match(made('/images/generations')[0].body.prompt, /two brown garage doors/);
});

test('two places are two photos from words, and each set keeps to its own place', async () => {
  checks = [[{ fits: true }, { fits: true }, { fits: true }]];
  const twoPlaces = input(photos(0, 1, 1), {
    places: [
      { name: 'my house', look: 'Tan siding and a gravel edge along the left side.' },
      { name: 'my mom’s', look: 'Red brick and a white garage door on a narrow street.' },
    ],
  });
  await sets.drawPhotoSet(twoPlaces);
  const words = made('/images/generations').map((call) => call.body.prompt as string);
  assert.equal(words.length, 2);
  assert.ok(words.some((prompt) => /Tan siding/.test(prompt)));
  assert.ok(words.some((prompt) => /Red brick/.test(prompt)));
  assert.equal(made('/images/edits').length, 1);
  assert.match(made('/images/edits')[0].body.prompt, /Red brick/);
});

test('a photo that doesn’t pass gets one more try, then it’s left out', async () => {
  checks = [
    [{ fits: true }, { fits: false, why: 'different surface' }],
    [{ fits: true }, { fits: false, why: 'still different' }],
  ];
  const shots = await sets.drawPhotoSet(input(photos(0, 0)));
  assert.equal(made('/images/generations').length, 1, 'The first photo is kept');
  assert.equal(made('/images/edits').length, 2, 'One try and one more');
  assert.equal(shots[1], null);
  assert.ok(shots[0]);
});

test('a first photo that’s off, or a job it doesn’t show, starts that place again once', async () => {
  checks = [[{ fits: true }, { fits: true }]];
  showsJob = [false, true];
  await sets.drawPhotoSet(input(photos(0, 0)));
  const words = made('/images/generations');
  assert.equal(words.length, 2);
  assert.match(words[1].body.prompt, /It has to make this plain: the whole driveway/);
  assert.equal(made('/images/edits').length, 2, 'The rest are made from the new one');
});

test('the owner always gets a photo, and a broken one only goes if nothing else can', async () => {
  checks = [
    [{ fits: false, broken: true }, { fits: true }],
    [{ fits: false, broken: true }, { fits: true }],
  ];
  const shots = await sets.drawPhotoSet(input(photos(0, 0)));
  assert.equal(shots[0], null);
  assert.ok(shots[1]);

  checks = [[{ fits: false, broken: true }], [{ fits: false, broken: true }]];
  assert.ok((await sets.drawPhotoSet(input(photos(0))))[0]);
});

test('a photo that can’t be made leaves the set with fewer, and a check that’s down stops nothing', async () => {
  failEdits = true;
  checks = [[{ fits: true }]];
  const shots = await sets.drawPhotoSet(input(photos(0, 0)));
  assert.ok(shots[0]);
  assert.equal(shots[1], null);

  failEdits = false;
  const realCheck = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    String(url).includes('/images/')
      ? realCheck(url, init)
      : json({ error: 'down' }, 500)) as typeof fetch;
  const unchecked = await sets.drawPhotoSet(input(photos(0, 0)));
  assert.equal(unchecked.filter(Boolean).length, 2);
});

test('an asked-for photo is made from the customer’s own, and only goes if it passes', async () => {
  checks = [[{ fits: true }, { fits: true }, { fits: true }]];
  const asked = {
    owner: 'business',
    project: project(),
    references: [
      { scene: 'Wide', bytes: photo },
      { scene: 'Close', bytes: photo },
    ],
    view: 'The whole driveway from the street.',
    place: 0,
    spend: <T>(task: () => Promise<T>) => task(),
  };
  assert.ok(await sets.drawAskedPhoto(asked));
  const [edit] = made('/images/edits');
  assert.equal(edit.body.images.length, 2);
  assert.equal(edit.body.reasoning_strength, 'high');
  assert.equal(made('/images/generations').length, 0, 'Nothing new is drawn from words');

  // Wrong the first time, the second try is told why.
  calls = [];
  checks = [
    [{ fits: true }, { fits: true }, { fits: false, why: 'shows the garage door' }],
    [{ fits: true }, { fits: true }, { fits: true }],
  ];
  assert.ok(await sets.drawAskedPhoto(asked));
  assert.equal(made('/images/edits').length, 2);
  assert.match(made('/images/edits')[1].body.prompt, /shows the garage door/);

  // Two tries is all it gets.
  calls = [];
  checks = [[{ fits: true }, { fits: true }, { fits: false, why: 'another house' }]];
  assert.equal(await sets.drawAskedPhoto(asked), null);
  assert.equal(made('/images/edits').length, 2);
  checks = [[{ fits: true }, { fits: true }, { fits: true, broken: true }]];
  assert.equal(await sets.drawAskedPhoto(asked), null);
});

test('photo sets can be turned off without a deploy', () => {
  assert.equal(sets.photoSetsAvailable(), true);
  process.env.PRACTICE_PHOTO_SETS = 'off';
  assert.equal(sets.photoSetsAvailable(), false);
});

test('every customer in the plan has a lesson, and the photos stay a mix', () => {
  assert.equal(SITUATION_LESSONS.length, SITUATIONS.length);
  for (const services of [['Driveways'], ['Driveways', 'House wash', 'Patios', 'Decks', 'Fences']])
    assert.equal(newOwnerLessons(services).length, newOwnerSituations(services).length);
  const base = {
    setupCount: 6,
    pastJobs: 3,
    services: ['Driveways', 'House wash'],
    examples: { driveways: 3, 'house wash': 2 },
    asked: [],
    random: () => 0.5,
  };
  const picked = [6, 7, 8, 9].map((position) => planCustomer({ ...base, position }));
  assert.ok(new Set(picked.map((customer) => customer.lesson.photos)).size > 1);
  const twoPlaces = planCustomer({ ...base, position: 10 });
  assert.match(twoPlaces.situation, /two separate places/);
  assert.equal(twoPlaces.lesson.photos, 'two_parts');
  assert.equal(planCustomer({ ...base, position: 4 }).lesson.photos, 'overview');
  assert.equal(planCustomer({ ...base, position: 5 }).lesson.photos, 'two_parts');
});

test('a customer left with one photo stops mentioning the other', () => {
  assert.equal(
    sets.openerForOnePhoto('Hi can I get a price? First pic is the whole pool, second is the spa.'),
    'Hi can I get a price? Pic is the whole pool.',
  );
  assert.equal(
    sets.openerForOnePhoto('Can I get a price? First photo is my backyard where we would set up.'),
    'Can I get a price? Photo is my backyard where we would set up.',
  );
  assert.equal(sets.openerForOnePhoto('Pic is the driveway.'), 'Pic is the driveway.');
});
