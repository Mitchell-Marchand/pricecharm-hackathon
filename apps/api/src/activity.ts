import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { mutate } from './db.js';
import { ok, rateLimit } from './http.js';
import { cleanProps, PROP_KEY, subjectOf } from './metrics.js';
import { workspaceFromRequest } from './workspace.js';

/**
 * What the web app reports from the browser: screens and the time spent on them, clicks, fields,
 * errors people saw, and failed or slow requests. The browser sends labels and counts, never what
 * anyone typed. The setup or account the browser belongs to, if any, comes from its cookies.
 */
const browserEvent = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    path: z
      .string()
      .max(120)
      .regex(/^\/[A-Za-z0-9/_:.-]*$/),
    // How long ago it happened, since the browser sends events a few at a time.
    ago: z.number().int().min(0).max(600_000).default(0),
    props: z
      .record(
        z.string().regex(PROP_KEY),
        z.union([z.string().max(300), z.number().finite(), z.boolean(), z.null()]),
      )
      .refine((props) => Object.keys(props).length <= 30, 'Too many properties.')
      .default({}),
  })
  .strict();
const batch = z
  .object({
    session: z.uuid(),
    events: z.array(browserEvent).min(1).max(25),
  })
  .strict();

export const activityRouter = Router();
activityRouter.post('/events', rateLimit(40, 60_000), async (req, res) => {
  const input = batch.parse(req.body);
  const place = await workspaceFromRequest(req);
  const subject = place ? ((await subjectOf(place.businessId)) ?? null) : null;
  const now = Date.now();
  const values = input.events.flatMap((event) => [
    randomUUID(),
    subject,
    event.name,
    input.session,
    event.path,
    JSON.stringify(cleanProps(event.props)),
    new Date(now - event.ago),
  ]);
  await mutate(
    `INSERT INTO product_events (id,subject,name,session,source,path,props,created_at) VALUES ${input.events
      .map(() => "(?,?,?,?,'browser',?,?,?)")
      .join(',')}`,
    values,
  );
  // The browser's own tag, so session recordings can be filed under the same setup.
  res.json(ok({ subject }));
});
