import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ok, rateLimit } from './http.js';
import { recordRequestEvent } from './metrics.js';

/**
 * Where a business works from: up to five areas as the owner typed them, a city, neighborhood or
 * ZIP/postcode, main one first. A "too far" turn-down is measured from the nearest, and the first
 * is kept in businesses.service_area too, for code that reads one area.
 */
export const MAX_LOCATIONS = 5;

export async function businessLocations(businessId: string, connection?: Sql) {
  const listed = await rows(
    'SELECT area FROM business_locations WHERE business_id=? ORDER BY position',
    [businessId],
    connection,
  );
  if (listed.length) return listed.map((row) => String(row.area));
  const [business] = await rows(
    'SELECT service_area FROM businesses WHERE id=?',
    [businessId],
    connection,
  );
  return business?.service_area ? [String(business.service_area)] : [];
}

const area = z
  .string()
  .max(400)
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(2, 'Write a city, neighborhood or ZIP code.')
      .max(120, 'Keep each one to 120 characters or fewer.'),
  );
export const locationsInput = z
  .object({
    areas: z
      .array(area)
      .min(1, 'Add where you work.')
      .max(MAX_LOCATIONS, `You can add up to ${MAX_LOCATIONS}.`),
  })
  .strict();

/** Replaces the list. The same place twice is kept once. */
export async function saveLocations(businessId: string, areas: string[]) {
  const unique = areas.filter(
    (item, index) =>
      areas.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index,
  );
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    await mutate('DELETE FROM business_locations WHERE business_id=?', [businessId], connection);
    for (const [position, place] of unique.entries())
      await mutate(
        'INSERT INTO business_locations (id,business_id,position,area) VALUES (?,?,?,?)',
        [randomUUID(), businessId, position, place],
        connection,
      );
    await mutate(
      'UPDATE businesses SET service_area=? WHERE id=?',
      [unique[0], businessId],
      connection,
    );
  });
}

/** Settings' list of where the owner works. Setup asks the same on its own screen. */
export const locationsRouter = Router();

locationsRouter.get('/app/locations', async (req, res) => {
  res.json(ok({ areas: await businessLocations(owner(req).businessId) }));
});

locationsRouter.put('/app/locations', rateLimit(20, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const { areas } = locationsInput.parse(req.body);
  await saveLocations(businessId, areas);
  await recordRequestEvent(req, businessId, 'locations_changed', { count: areas.length });
  res.json(ok({ areas: await businessLocations(businessId) }));
});
