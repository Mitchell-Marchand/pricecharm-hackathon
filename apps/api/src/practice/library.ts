import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { TRADES_BY_ID } from '@pricecharm/trades';
import { aiMode, type AiImage } from '../ai/index.js';
import { writePracticeScenario } from '../ai/practice.js';
import { generatePracticePhoto } from '../ai/practice-images.js';
import { measurePhotos, type Walkaround } from '../ai/walkaround.js';
import { mutate, rows } from '../db.js';
import { json, type Row } from '../models.js';
import { currencyOf } from '../money.js';
import { deletePhoto, getPhoto, putPhoto } from '../storage.js';
import { demoPhoto, demoPhotoReading, demoScenario } from './demo.js';
import { reconcileScenario } from './photo-facts.js';
import type { StoredReading } from './photos.js';
import { drawPhotoSet, openerForOnePhoto, photoSetsAvailable } from './photo-set.js';
import { newOwnerLessons, newOwnerSituations } from './plan.js';
import type { PracticeScenario } from './types.js';

/**
 * Setup's first practice customers, made once per trade and shared by every new owner of it.
 * Each is written, photographed, read and squared with its photos ahead of time
 * (`npm run practice-library`), so a new owner's first customer is there at once instead of
 * after half a minute, no images are made for setups that never get going, and the photos are
 * known to match the facts. They follow the first situations of newOwnerSituations, for the
 * trade's main service, with generic places and no business names. An owner gets them when they
 * have no past jobs, work in feet and miles, and the entry's service is one of theirs. Otherwise
 * one is written for them.
 */
export const LIBRARY_POSITIONS = 3;

/** Storage keys of a library entry's photos, which each owner gets their own copy of. */
type LibraryPhotos = {
  opener: { scene: string; key: string }[];
  extra: { scene: string; key: string } | null;
  drawn: { label: string; key: string }[];
};

/** The library entry for this customer, and the owner's spelling of its service, if one fits. */
export async function libraryEntryFor(
  businessId: string,
  position: number,
  focus: string | null,
): Promise<{ entry: Row; service: string } | null> {
  if (focus || position >= LIBRARY_POSITIONS) return null;
  const [business] = await rows('SELECT trade_id,currency FROM businesses WHERE id=?', [
    businessId,
  ]);
  if (!business?.trade_id || currencyOf(business.currency) !== 'USD') return null;
  const [past] = await rows('SELECT COUNT(*) AS count FROM past_jobs WHERE business_id=?', [
    businessId,
  ]);
  if (Number(past.count)) return null;
  const [entry] = await rows('SELECT * FROM practice_library WHERE trade_id=? AND position=?', [
    business.trade_id,
    position,
  ]);
  if (!entry) return null;
  const services = await rows('SELECT name FROM offerings WHERE business_id=?', [businessId]);
  const service = services
    .map((row) => String(row.name))
    .find((name) => name.toLowerCase() === String(entry.service_name).toLowerCase());
  return service ? { entry, service } : null;
}

/** One of the entry's photos, copied into this business's own photos for the run. */
async function copyPhoto(businessId: string, runId: string, key: string, purpose: string) {
  const bytes = await getPhoto(key);
  const metadata = await sharp(bytes).metadata();
  const id = randomUUID(),
    copy = `${id}.jpg`;
  await putPhoto(copy, bytes);
  await mutate(
    'INSERT INTO attachments (id,business_id,conversation_id,purpose,filename,mime_type,storage_key,width,height,byte_size) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      businessId,
      runId,
      purpose,
      'practice-photo.jpg',
      'image/jpeg',
      copy,
      metadata.width ?? 0,
      metadata.height ?? 0,
      bytes.length,
    ],
  );
  return id;
}

/**
 * The library customer as this owner's own: the scenario in their spelling of the service, their
 * own copies of its photos, and its reading. Copying the photos means an owner deleting their
 * account never takes the shared ones with it.
 */
export async function copyLibraryEntry(
  businessId: string,
  runId: string,
  { entry, service }: { entry: Row; service: string },
): Promise<{ scenario: PracticeScenario; reading: StoredReading }> {
  const photos = json<LibraryPhotos>(entry.photos_json, { opener: [], extra: null, drawn: [] });
  const base = json<PracticeScenario>(entry.scenario_json, {} as PracticeScenario);
  const opener = [];
  for (const photo of photos.opener)
    opener.push({
      scene: photo.scene,
      photoId: await copyPhoto(businessId, runId, photo.key, 'practice'),
    });
  const extraId = photos.extra
    ? await copyPhoto(businessId, runId, photos.extra.key, 'practice')
    : null;
  const drawn = [];
  for (const photo of photos.drawn)
    drawn.push({
      label: photo.label,
      photoId: await copyPhoto(businessId, runId, photo.key, 'practice_overlay'),
    });
  const scenario: PracticeScenario = {
    ...base,
    serviceName: service,
    photos: opener,
    extraPhoto: { ...base.extraPhoto, photoId: extraId },
    libraryId: String(entry.id),
    situation: String(entry.situation),
  };
  const result = json<Walkaround | null>(entry.reading_json, null);
  return {
    scenario,
    reading: {
      photoIds: opener.map((photo) => photo.photoId),
      result: result && { ...result, serviceName: service },
      failure: '',
      drawn,
    },
  };
}

/** A made photo, normalized and stored under the library's own key. */
async function makePhoto(tradeId: string, serviceName: string, scene: string) {
  const bytes =
    aiMode === 'demo'
      ? await demoPhoto(scene)
      : (
          await generatePracticePhoto(`library:${tradeId}`, {
            title: `${serviceName} photo`,
            description: scene,
          })
        ).bytes;
  const key = `${randomUUID()}.jpg`;
  await putPhoto(key, bytes);
  return { key, bytes };
}

/** The photos a library customer opens with, made like an owner's own customer's. */
async function openingPhotos(tradeId: string, scenario: PracticeScenario) {
  if (aiMode === 'demo' || !scenario.project || !photoSetsAvailable())
    return Promise.all(
      scenario.photos.map(async (photo) => ({
        scene: photo.scene,
        ...(await makePhoto(tradeId, scenario.serviceName, photo.scene)),
      })),
    );
  const shots = await drawPhotoSet({
    owner: `library:${tradeId}`,
    title: `${scenario.serviceName} photo`,
    project: scenario.project,
    photos: scenario.photos,
    spend: (task) => task(),
  });
  const kept = shots.flatMap((bytes, index) =>
    bytes ? [{ bytes, scene: scenario.photos[index].scene }] : [],
  );
  return Promise.all(
    kept.map(async ({ bytes, scene }) => {
      const key = `${randomUUID()}.jpg`;
      await putPhoto(key, bytes);
      return { scene, key, bytes };
    }),
  );
}

const image = (bytes: Buffer): AiImage => ({
  mimeType: 'image/jpeg',
  dataBase64: bytes.toString('base64'),
});

/**
 * Writes, photographs, reads and squares one library customer for a trade, and saves it in its
 * slot, replacing what was there. Calls paid image and AI models unless AI_PROVIDER=demo.
 */
export async function buildLibraryEntry(
  tradeId: string,
  position: number,
  log: (line: string) => void = () => {},
) {
  const trade = TRADES_BY_ID[tradeId];
  if (!trade) throw new Error(`There's no trade called ${tradeId}.`);
  if (position < 0 || position >= LIBRARY_POSITIONS) throw new Error('No such library slot.');
  const services = trade.services.slice(0, Math.max(1, trade.preselect));
  const situation = newOwnerSituations(services)[position];
  const lesson = newOwnerLessons(services)[position];
  const others = await rows(
    'SELECT scenario_json FROM practice_library WHERE trade_id=? AND position<>?',
    [tradeId, position],
  );
  const earlier = others.map((row) => {
    const scenario = json<PracticeScenario>(row.scenario_json, {} as PracticeScenario);
    return { name: scenario.firstName, service: scenario.serviceName };
  });
  log(`Writing customer ${position + 1} for ${trade.name}.`);
  const written: PracticeScenario =
    aiMode === 'demo'
      ? { ...demoScenario(position, services), situation }
      : {
          ...(await writePracticeScenario({
            trade: trade.name,
            businessName: '',
            services,
            location: '',
            distanceUnit: 'mi',
            radiusMiles: null,
            jobs: [],
            situation,
            lesson,
            earlier,
          })),
          situation,
        };
  // Each owner gets a distance from their own location when it's used.
  const scenario: PracticeScenario = { ...written, distance: null };
  log(`  ${scenario.firstName} ${scenario.lastInitial}., ${scenario.serviceName}: making photos.`);
  const opener = await openingPhotos(tradeId, scenario);
  const extra = scenario.extraPhoto.scene
    ? await makePhoto(tradeId, scenario.serviceName, scenario.extraPhoto.scene)
    : null;
  log('  Reading the photos.');
  const drawn: { label: string; key: string }[] = [];
  const reading =
    aiMode === 'demo'
      ? demoPhotoReading(scenario)
      : await measurePhotos({
          business: { name: 'the business', trade: trade.name, services },
          serviceName: scenario.serviceName,
          priceUnits: {},
          photos: opener.map((photo, index) => ({ id: String(index), image: image(photo.bytes) })),
          saveOverlay: async (jpeg) => {
            const key = `${randomUUID()}.jpg`;
            await putPhoto(key, jpeg);
            return key;
          },
        });
  for (const overlay of reading.overlays)
    drawn.push({ label: overlay.label, key: overlay.storageKey });
  const reconciled = reconcileScenario(scenario, reading);
  // The customer's facts stay as written. A photo that disagrees is for whoever checks the
  // library to look at, and make again with --replace if it's off.
  for (const change of reconciled.changes) log(`  Photos disagree, check them: ${change}.`);
  const photos: LibraryPhotos = {
    opener: opener.map(({ scene, key }) => ({ scene, key })),
    extra: extra && { scene: scenario.extraPhoto.scene, key: extra.key },
    drawn,
  };
  const saved: PracticeScenario = {
    ...reconciled.scenario,
    opener:
      opener.length === 1 && scenario.photos.length > 1
        ? openerForOnePhoto(reconciled.scenario.opener)
        : reconciled.scenario.opener,
    photos: reconciled.scenario.photos.map((photo) => ({ ...photo, photoId: null })),
    extraPhoto: { ...reconciled.scenario.extraPhoto, photoId: null },
  };
  const [replaced] = await rows(
    'SELECT photos_json FROM practice_library WHERE trade_id=? AND position=?',
    [tradeId, position],
  );
  await mutate(
    `INSERT INTO practice_library (id,trade_id,position,service_name,situation,scenario_json,photos_json,reading_json,checked_at)
     VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE id=VALUES(id),service_name=VALUES(service_name),situation=VALUES(situation),
       scenario_json=VALUES(scenario_json),photos_json=VALUES(photos_json),reading_json=VALUES(reading_json),
       checked_at=VALUES(checked_at),created_at=UTC_TIMESTAMP(3)`,
    [
      randomUUID(),
      tradeId,
      position,
      scenario.serviceName,
      situation,
      JSON.stringify(saved),
      JSON.stringify(photos),
      JSON.stringify({ ...reading, overlays: [] }),
    ],
  );
  // Owners who had the old one have their own copies, so its photos can go.
  const old = replaced ? json<LibraryPhotos | null>(replaced.photos_json, null) : null;
  if (old) for (const key of photoKeys(old)) await deletePhoto(key).catch(() => {});
  return { scenario: saved, reading };
}

const photoKeys = (photos: LibraryPhotos) => [
  ...photos.opener.map((photo) => photo.key),
  ...(photos.extra ? [photos.extra.key] : []),
  ...photos.drawn.map((photo) => photo.key),
];

type LibraryFile = {
  entries: {
    id: string;
    tradeId: string;
    position: number;
    serviceName: string;
    situation: string;
    scenario: unknown;
    photos: LibraryPhotos;
    reading: unknown;
  }[];
  /** Each photo as base64, by its storage key. */
  images: Record<string, string>;
};

/** The whole library as one file, photos included, to carry to another server. */
export async function exportLibrary(file: string) {
  const entries = await rows('SELECT * FROM practice_library ORDER BY trade_id,position');
  const out: LibraryFile = { entries: [], images: {} };
  for (const entry of entries) {
    const photos = json<LibraryPhotos>(entry.photos_json, { opener: [], extra: null, drawn: [] });
    for (const key of photoKeys(photos)) out.images[key] = (await getPhoto(key)).toString('base64');
    out.entries.push({
      id: String(entry.id),
      tradeId: String(entry.trade_id),
      position: Number(entry.position),
      serviceName: String(entry.service_name),
      situation: String(entry.situation),
      scenario: json(entry.scenario_json, null),
      photos,
      reading: json(entry.reading_json, null),
    });
  }
  await writeFile(file, JSON.stringify(out));
  return out.entries.length;
}

/** Puts an exported library in place here. A slot that's already filled is left alone. */
export async function importLibrary(file: string) {
  const { entries, images } = JSON.parse(await readFile(file, 'utf8')) as LibraryFile;
  let added = 0;
  for (const entry of entries) {
    const [filled] = await rows('SELECT id FROM practice_library WHERE trade_id=? AND position=?', [
      entry.tradeId,
      entry.position,
    ]);
    if (filled) continue;
    // An import that stopped partway can run again.
    for (const key of photoKeys(entry.photos)) {
      await deletePhoto(key).catch(() => {});
      await putPhoto(key, Buffer.from(images[key], 'base64'));
    }
    await mutate(
      `INSERT INTO practice_library (id,trade_id,position,service_name,situation,scenario_json,photos_json,reading_json,checked_at)
       VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
      [
        entry.id,
        entry.tradeId,
        entry.position,
        entry.serviceName,
        entry.situation,
        JSON.stringify(entry.scenario),
        JSON.stringify(entry.photos),
        JSON.stringify(entry.reading),
      ],
    );
    added++;
  }
  return added;
}
