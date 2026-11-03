import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { TRADES_BY_ID } from '@pricecharm/trades';
import { aiMode, type AiImage } from '../ai/index.js';
import { writePracticeScenario } from '../ai/practice.js';
import { generatePracticePhoto } from '../ai/practice-images.js';
import { measurePhotos, type Walkaround } from '../ai/walkaround.js';
import { mutate, rows } from '../db.js';
import { json, type Row } from '../models.js';
import { deletePhoto, getPhoto, putPhoto } from '../storage.js';
import { demoPhoto, demoPhotoReading, demoScenario } from './demo.js';
import { reconcileScenario } from './photo-facts.js';
import type { StoredReading } from './photos.js';
import { newOwnerSituations } from './plan.js';
import type { PracticeScenario } from './types.js';

/**
 * Setup's first practice customers, made once per trade and shared by every new owner of it.
 * Each is written, photographed, read and squared with its photos ahead of time
 * (`npm run practice-library`), so a new owner's first customer is there at once instead of
 * after half a minute, no images are made for setups that never get going, and the photos are
 * known to match the facts. They follow the first situations of newOwnerSituations, for the
 * trade's main service, with generic places and no business names. An owner gets them when they
 * have no past jobs and the entry's service is one of theirs. Otherwise one is written for them.
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
  const [business] = await rows('SELECT trade_id FROM businesses WHERE id=?', [businessId]);
  if (!business?.trade_id) return null;
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
            earlier,
          })),
          situation,
        };
  // Each owner gets a distance from their own location when it's used.
  const scenario: PracticeScenario = { ...written, distance: null };
  log(`  ${scenario.firstName} ${scenario.lastInitial}., ${scenario.serviceName}: making photos.`);
  const opener = await Promise.all(
    scenario.photos.map(async (photo) => ({
      scene: photo.scene,
      ...(await makePhoto(tradeId, scenario.serviceName, photo.scene)),
    })),
  );
  const extra = await makePhoto(tradeId, scenario.serviceName, scenario.extraPhoto.scene);
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
    extra: { scene: scenario.extraPhoto.scene, key: extra.key },
    drawn,
  };
  const saved: PracticeScenario = {
    ...reconciled.scenario,
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
  if (old)
    for (const key of [
      ...old.opener.map((photo) => photo.key),
      ...(old.extra ? [old.extra.key] : []),
      ...old.drawn.map((photo) => photo.key),
    ])
      await deletePhoto(key).catch(() => {});
  return { scenario: saved, reading };
}
