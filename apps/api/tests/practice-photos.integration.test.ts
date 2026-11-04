import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDatabase, mutate, rows } from '../src/db.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
// Setups here come from an address of their own, behind a trusted proxy, so they don't use up the
// day's setups from 127.0.0.1 that the other test files share.
const ADDRESS = '10.52.0.1';
process.env.TRUST_PROXY = '1';
process.env.LOCAL_SETUPS_PER_ADDRESS ??= '500';
/** Each owner's wait for their customers still being written. */
const owners: (() => Promise<void>)[] = [];
after(async () => {
  for (const quiet of owners) await quiet();
  await closeDatabase();
});

const parse = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(
  body: { tradeId: string; services: string[]; name: string; area?: string },
  pastJob = true,
) {
  process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-photos-'));
  const { createApp } = await import('../src/app.js');
  const owner = request.agent(createApp()).set('X-Forwarded-For', ADDRESS);
  await owner.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
  await owner.patch('/api/v1/onboarding/business').set('Origin', origin).send(body).expect(200);
  // Three past jobs, so the Charm guesses from the first customer: it waits for three prices.
  if (pastJob)
    for (const [size, priceCents] of [
      [600, 27500],
      [400, 21000],
      [900, 36000],
    ])
      await owner
        .post('/api/v1/onboarding/jobs')
        .set('Origin', origin)
        .send({
          serviceName: body.services[0],
          description: 'Back patio and walkway.',
          priceCents,
          size: `${size} sq ft`,
        })
        .expect(201);
  await owner.post('/api/v1/onboarding/practice/prepare').set('Origin', origin).expect(200);
  const state = async () => (await owner.get('/api/v1/onboarding/practice')).body.data;
  /** The current customer once they're ready, their photos read and any photo taken. */
  const settled = async (position?: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const now = await state();
      const run = now.runs[position ?? now.current];
      if (run?.status === 'ready' && run.photoReading?.status !== 'reading' && !run.takingPhoto)
        return run;
      await pause(50);
    }
    throw new Error('The practice customer never settled.');
  };
  const send = (runId: string, method: 'post' | 'patch', what: string, data: object = {}) =>
    owner[method](`/api/v1/onboarding/practice/${runId}/${what}`).set('Origin', origin).send(data);
  /** Waits for every customer being written in the background, so none outlive the test. */
  const quiet = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const runs = (await state()).runs as { status: string }[];
      if (!runs.some((run) => run.status === 'preparing')) return;
      await pause(50);
    }
  };
  owners.push(quiet);
  return { owner, state, settled, send };
}

test(
  'practice photos are read before the chat goes on, with a lease, and the owner’s fixes change the guess',
  { skip: !enabled },
  async () => {
    const { owner, settled, send } = await setup({
      tradeId: 'pressure-washing',
      services: ['Patios & pavers', 'Driveways'],
      name: 'Photo Reading Washers',
      area: 'Portland, OR',
    });
    const dana = await settled(0);
    assert.equal(dana.customer.name, 'Dana R.');
    assert.deepEqual(
      dana.customer.distance,
      { value: 6, unit: 'mi', from: 'Portland, OR' },
      'Miles for a US dollar business, from where it works',
    );
    const reading = dana.photoReading;
    assert.equal(reading.status, 'read');
    assert.deepEqual(
      reading.photoIds,
      dana.messages[0].photos.map((photo: { id: string }) => photo.id),
    );
    assert.match(reading.summary, /^\[Demo\] A concrete patio/);
    assert.deepEqual(reading.area, {
      surface: 'patio',
      unit: 'sq ft',
      low: 500,
      high: 600,
      fixed: false,
    });
    assert.equal(reading.counts[0].label, 'planters');
    assert.ok(reading.details.includes('dark stains, worst by the door'));

    // A reading goes on behind the chat, which never waits for it.
    const [{ photo_reading_json: read }] = await rows(
      'SELECT photo_reading_json FROM practice_runs WHERE id=?',
      [dana.id],
    );
    await mutate(
      'UPDATE practice_runs SET photo_reading_json=NULL,photo_read_token=?,photo_read_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),photo_progress_json=? WHERE id=?',
      [randomUUID(), JSON.stringify({ step: 'counting', counting: ['planters'] }), dana.id],
    );
    const held = (await owner.get('/api/v1/onboarding/practice')).body.data.runs[0];
    assert.equal(held.photoReading.status, 'reading');
    assert.deepEqual(held.photoReading.progress, { step: 'counting', counting: ['planters'] });
    const asked = await send(dana.id, 'post', 'messages', { text: 'How big is it?' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    // A reading a restart cut short runs out and is picked up again.
    await mutate(
      'UPDATE practice_runs SET photo_read_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
      [dana.id],
    );
    const again = await settled(0);
    assert.equal(again.photoReading.status, 'read');
    assert.deepEqual(
      parse<{ result: unknown }>(
        (await rows('SELECT photo_reading_json FROM practice_runs WHERE id=?', [dana.id]))[0]
          .photo_reading_json,
      ).result,
      parse<{ result: unknown }>(read).result,
      'Read again, the same',
    );

    // The guess goes on what it saw. A fix to the size changes it.
    await send(dana.id, 'post', 'guess').expect(200);
    const guessOf = async () =>
      parse<{ cents: number } | null>(
        (await rows('SELECT shadow_json FROM practice_runs WHERE id=?', [dana.id]))[0].shadow_json,
      );
    const before = (await guessOf())!.cents;
    assert.equal(
      (await send(dana.id, 'patch', 'photo-reading', { counts: { chairs: 4 } })).status,
      422,
      'Only what it counted can be fixed',
    );
    const fixed = await send(dana.id, 'patch', 'photo-reading', {
      area: 800,
      counts: { planters: 3 },
      note: 'Two of the planters are huge',
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.deepEqual(fixed.body.data.photoReading.area, {
      surface: 'patio',
      unit: 'sq ft',
      low: 800,
      high: 800,
      fixed: true,
    });
    assert.equal(fixed.body.data.photoReading.counts[0].fixed, false, 'The same count isn’t a fix');
    assert.equal(fixed.body.data.photoReading.note, 'Two of the planters are huge');
    assert.equal(await guessOf(), null, 'The guess is made again from the fix');
    const [after] = await rows('SELECT * FROM practice_runs WHERE id=?', [dana.id]);
    const scenario = parse<{ quantity: number; facts: { key: string; answer: string }[] }>(
      after.scenario_json,
    );
    assert.equal(scenario.quantity, 800, 'The customer’s size takes the owner’s fix');
    const { practicePhotoNotes } = await import('../src/practice/photos.js');
    const notes = practicePhotoNotes(after);
    assert.ok(
      notes.includes("The owner says the patio in the customer's photos is about 800 sq ft."),
    );
    assert.ok(
      notes.includes("The owner says about the customer's photos: Two of the planters are huge"),
    );
    assert.ok(!notes.some((note) => note.includes('500 to 600')), 'What it read is replaced');
    const labels = await rows(
      'SELECT kind,name,unit,read_value,fixed_value,fixed_text,trade_id,photo_ids_json FROM photo_labels WHERE run_id=? ORDER BY kind',
      [dana.id],
    );
    assert.deepEqual(
      labels.map((label) => [
        label.kind,
        label.name,
        Number(label.read_value),
        Number(label.fixed_value),
      ]),
      [
        ['area', 'patio', 550, 800],
        ['note', '', 0, 0],
      ],
    );
    assert.equal(labels[1].fixed_text, 'Two of the planters are huge');
    assert.equal(labels[0].trade_id, 'pressure-washing');
    assert.deepEqual(parse(labels[0].photo_ids_json), reading.photoIds);
    await send(dana.id, 'post', 'guess').expect(200);
    assert.ok((await guessOf())!.cents > before, 'A bigger patio is a bigger guess');

    const stranger = request
      .agent((await import('../src/app.js')).createApp())
      .set('X-Forwarded-For', ADDRESS);
    await stranger.post('/api/v1/onboarding/start').set('Origin', origin).send({}).expect(201);
    assert.equal(
      (
        await stranger
          .patch(`/api/v1/onboarding/practice/${dana.id}/photo-reading`)
          .set('Origin', origin)
          .send({ note: 'hi' })
      ).status,
      404,
    );
    await send(dana.id, 'post', 'quote', {
      lines: [{ id: 'a', label: 'Patio wash, about 800 sq ft', amountCents: 36000 }],
    }).expect(200);
    assert.equal(
      (await send(dana.id, 'patch', 'photo-reading', { note: 'late' })).body.error.code,
      'PRACTICE_CLOSED',
    );

    // Marcus says 700 sq ft, and his photos read about 500. What he says stands: a reader that's
    // off never puts words in his mouth. What it read shows on the card, for the owner to fix.
    const marcus = await settled(1);
    const [{ scenario_json: marcusJson }] = await rows(
      'SELECT scenario_json FROM practice_runs WHERE id=?',
      [marcus.id],
    );
    const kept = parse<{ quantity: number; facts: { key: string; answer: string }[] }>(marcusJson);
    assert.equal(kept.quantity, 700);
    assert.match(kept.facts.find((fact) => fact.key === 'size')!.answer, /^Around 700 sq ft\./);
    const sized = await send(marcus.id, 'post', 'messages', { text: 'How big is the patio?' });
    assert.match(sized.body.data.run.messages.at(-1).text, /Around 700 sq ft/);
  },
);

test(
  'an asked-for photo is taken outside the request, and one a restart left is picked up again',
  { skip: !enabled },
  async () => {
    const { state, settled, send } = await setup({
      tradeId: 'pressure-washing',
      services: ['Patios & pavers'],
      name: 'Photo Asking Washers',
    });
    const run = await settled(0);
    assert.equal(run.customer.distance.unit, 'mi');
    assert.equal(run.customer.distance.from, undefined, 'No location, no “from”');
    // The photo they hold back is made just after they open.
    for (let attempt = 0; attempt < 100; attempt++) {
      const [held] = await rows('SELECT scenario_json FROM practice_runs WHERE id=?', [run.id]);
      if (parse<{ extraPhoto: { photoId: string | null } }>(held.scenario_json).extraPhoto.photoId)
        break;
      await pause(50);
    }
    const prepared = await send(run.id, 'post', 'messages', {
      text: 'Can you send a closer photo?',
    });
    assert.equal(
      prepared.body.data.run.messages.at(-1).photos.length,
      1,
      'The prepared one, at once',
    );
    // A photo a restart left half-taken is taken again once its lease runs out. One that can't
    // be made doesn't count toward the two.
    await mutate(
      'UPDATE practice_runs SET photo_ask_json=?,photo_ask_token=?,photo_ask_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND),photo_asks=2 WHERE id=?',
      [JSON.stringify({ scene: 'no-such-photo', text: 'Here.' }), randomUUID(), run.id],
    );
    const after = await settled(0);
    assert.equal(after.takingPhoto, false);
    assert.match(after.messages.at(-1).text, /couldn’t get a good one/);
    const [{ photo_asks: asks }] = await rows('SELECT photo_asks FROM practice_runs WHERE id=?', [
      run.id,
    ]);
    assert.equal(Number(asks), 1);
    const taken = await send(run.id, 'post', 'messages', {
      text: 'Could you send another picture?',
    });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.data.run.messages.at(-1).text, 'Sure, give me a minute.');
    const done = await settled(0);
    assert.equal(done.messages.at(-1).photos.length, 1);
    assert.equal(done.messages.at(-1).text, "Here's the whole patio from the back steps.");

    // While one is being taken, the chat waits for it.
    await mutate(
      'UPDATE practice_runs SET photo_ask_json=?,photo_ask_token=?,photo_ask_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND) WHERE id=?',
      [JSON.stringify({ scene: 'patio-door', text: 'Here.' }), randomUUID(), run.id],
    );
    const waiting = (await state()).runs[0];
    assert.equal(waiting.takingPhoto, true);
    for (const [what, data] of [
      ['messages', { text: 'Thanks!' }],
      ['quote', { lines: [{ id: 'a', label: 'Patio', amountCents: 20000 }] }],
    ] as const)
      assert.equal((await send(run.id, 'post', what, data)).body.error?.code, 'PRACTICE_PHOTO');
    await mutate(
      'UPDATE practice_runs SET photo_ask_json=NULL,photo_ask_token=NULL,photo_ask_until=NULL WHERE id=?',
      [run.id],
    );
  },
);

test(
  'a new owner’s first three customers come from the checked library for their trade',
  { skip: !enabled },
  async () => {
    process.env.UPLOAD_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-photos-'));
    const { buildLibrary } = await import('../src/practice-library.js');
    const lines: string[] = [];
    try {
      await mutate("DELETE FROM practice_library WHERE trade_id='pressure-washing'");
      const built = await buildLibrary({
        trade: 'pressure-washing',
        positions: [0, 1, 2],
        spend: false,
        replace: false,
        log: (line) => lines.push(line),
      });
      assert.deepEqual(built, [0, 1, 2]);
      assert.ok(
        lines.some((line) =>
          line.includes('Photos disagree, check them: sq ft: says 700, photos show 500'),
        ),
      );
      assert.deepEqual(
        await buildLibrary({
          trade: 'pressure-washing',
          positions: [0],
          spend: false,
          replace: false,
          log: () => {},
        }),
        [],
        'A filled slot is left alone without --replace',
      );
      await assert.rejects(
        buildLibrary({
          trade: 'dog-walking',
          positions: [0],
          spend: false,
          replace: false,
          log: () => {},
        }),
        /no trade called dog-walking/,
      );
      const library = await rows(
        "SELECT id,position,service_name,photos_json,scenario_json FROM practice_library WHERE trade_id='pressure-washing' ORDER BY position",
      );
      assert.equal(library.length, 3);
      assert.equal(library[0].service_name, 'Patios & pavers');
      const shared = parse<{ opener: { key: string }[] }>(library[0].photos_json).opener.map(
        (photo) => photo.key,
      );
      assert.equal(parse<{ distance: unknown }>(library[0].scenario_json).distance, null);

      // No past jobs and the service is theirs: the first three are the library's, read already.
      const fresh = await setup(
        {
          tradeId: 'pressure-washing',
          services: ['Driveways', 'patios & pavers'],
          name: 'Library Washers',
          area: 'Boise, ID',
        },
        false,
      );
      const first = await fresh.settled(0);
      assert.equal(first.serviceName, 'patios & pavers', 'In the owner’s spelling');
      assert.equal(first.photoReading.status, 'read');
      assert.equal(first.customer.distance.from, 'Boise, ID');
      const [stored] = await rows(
        'SELECT scenario_json,business_id FROM practice_runs WHERE id=?',
        [first.id],
      );
      assert.equal(parse<{ libraryId: string }>(stored.scenario_json).libraryId, library[0].id);
      const own = await rows(
        `SELECT storage_key FROM attachments WHERE business_id=? AND id IN (${first.photoReading.photoIds.map(() => '?').join(',')})`,
        [stored.business_id, ...first.photoReading.photoIds],
      );
      assert.equal(own.length, 2, 'The owner has their own copies of the photos');
      assert.ok(own.every((photo) => !shared.includes(String(photo.storage_key))));
      assert.equal((await fresh.owner.get(first.messages[0].photos[0].url)).status, 200);
      const second = await fresh.settled(1);
      const [secondJson] = await rows('SELECT scenario_json FROM practice_runs WHERE id=?', [
        second.id,
      ]);
      assert.equal(parse<{ libraryId: string }>(secondJson.scenario_json).libraryId, library[1].id);

      // With past jobs, or without the entry's service, one is written for them instead.
      for (const [services, pastJob] of [
        [['Patios & pavers'], true],
        [['Driveways', 'House wash'], false],
      ] as const) {
        const other = await setup(
          { tradeId: 'pressure-washing', services: [...services], name: 'Written Washers' },
          pastJob,
        );
        const written = await other.settled(0);
        const [json] = await rows('SELECT scenario_json FROM practice_runs WHERE id=?', [
          written.id,
        ]);
        assert.equal(parse<{ libraryId?: string }>(json.scenario_json).libraryId, undefined);
      }

      // Its customers work in feet and miles, so an owner in km gets their own.
      const abroad = await setup(
        {
          tradeId: 'pressure-washing',
          services: ['Patios & pavers'],
          name: 'Metric Washers',
          currency: 'GBP',
        },
        false,
      );
      const local = await abroad.settled(0);
      const [localJson] = await rows('SELECT scenario_json FROM practice_runs WHERE id=?', [
        local.id,
      ]);
      assert.equal(parse<{ libraryId?: string }>(localJson.scenario_json).libraryId, undefined);

      // An export carries the library to another server, photos and all.
      const { exportLibrary, importLibrary } = await import('../src/practice/library.js');
      const { deletePhoto, getPhoto } = await import('../src/storage.js');
      const file = path.join(os.tmpdir(), `library-${randomUUID()}.json`);
      await exportLibrary(file);
      await mutate("DELETE FROM practice_library WHERE trade_id='pressure-washing'");
      await deletePhoto(shared[0]);
      assert.equal(await importLibrary(file), 3);
      assert.ok((await getPhoto(shared[0])).length > 0);
      assert.equal(await importLibrary(file), 0, 'A filled slot is left alone');
      await fs.rm(file);
    } finally {
      await mutate("DELETE FROM practice_library WHERE trade_id='pressure-washing'");
    }
  },
);
