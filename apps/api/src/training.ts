import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction } from './db.js';
import { cents, idSchema, quantitySchema, proposeUnitPrice, samePricingUnit } from './domain.js';
import { ApiError, ok, rateLimit } from './http.js';
import {
  addMessage,
  businessById,
  getMessages,
  invalidateAutomaticReadiness,
  serviceById,
  trainingById,
  trainingForBusiness,
} from './models.js';
import { aiMode, generateScenario, replyAsCustomerTurn } from './ai/index.js';
import { withAiUsage } from './usage.js';
import { quoteDraftHandler } from './training-quote.js';
import {
  groundedPracticeScenes,
  practicePhotoIntent,
  safePracticeReply,
  pendingTrainingPhotos,
  queueTrainingPhotos,
  retryTrainingPhotos,
  trainingPhotoContext,
} from './training-photos.js';
import { getPhoto } from './storage.js';

export const trainingRouter = Router();
trainingRouter.get('/training', async (req, res) => {
  res.json(ok(await trainingForBusiness(owner(req).businessId)));
});
trainingRouter.post('/training', rateLimit(10, 60_000), async (req, res) => {
  const { businessId } = owner(req);
  const { serviceId } = z.object({ serviceId: idSchema }).strict().parse(req.body);
  const service = await serviceById(businessId, serviceId),
    business = await businessById(businessId);
  const [count] = await rows('SELECT COUNT(*) count FROM training_sessions WHERE business_id = ?', [
    businessId,
  ]);
  if (Number(count.count) >= 500)
    throw new ApiError(
      422,
      'TRAINING_LIMIT',
      'The pilot supports up to 500 practice conversations per business.',
    );
  const id = randomUUID();
  const scenario = await withAiUsage(businessId, id, () =>
    generateScenario({ business, service, index: Number(count.count) }),
  );
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    await mutate(
      'INSERT INTO training_sessions (id, business_id, service_id, service_version, scenario_json,unit_label) VALUES (?, ?, ?, ?, ?,?)',
      [id, businessId, serviceId, service.version, JSON.stringify(scenario), service.unitLabel],
      connection,
    );
    await addMessage(
      businessId,
      id,
      'training',
      'assistant',
      `${aiMode === 'demo' ? '[Demo practice customer] ' : '[Practice customer] '}${scenario.description}`,
      connection,
    );
  });
  res.status(201).json(ok(await trainingById(businessId, id)));
});
trainingRouter.get('/training/:id', async (req, res) => {
  res.json(ok(await trainingById(owner(req).businessId, idSchema.parse(req.params.id))));
});
trainingRouter.post('/training/:id/quote-draft', rateLimit(12, 60_000), quoteDraftHandler);
async function trainingMessage(req: Request, res: Response, forcePhotos = false) {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const { content } = z
    .object({
      content: forcePhotos
        ? z
            .string()
            .trim()
            .min(1)
            .max(5000)
            .default('Show sample photos for this practice request.')
        : z.string().trim().min(1).max(5000),
    })
    .strict()
    .parse(req.body);
  const session = await trainingById(businessId, id);
  if (session.status !== 'active')
    throw new ApiError(409, 'TRAINING_COMPLETED', 'This practice conversation is complete.');
  if (session.messages.length >= 80)
    throw new ApiError(
      422,
      'CONVERSATION_LIMIT',
      'Complete this conversation or start another practice request.',
    );
  const requestPhotos = forcePhotos || practicePhotoIntent(content, session.messages);
  const pending = await pendingTrainingPhotos(businessId, id);
  if (forcePhotos && pending) {
    res.json(ok(session));
    return;
  }
  const photoContext = await trainingPhotoContext(businessId, id);
  const result =
    pending && requestPhotos
      ? {
          reply:
            'The current practice photo request is still in progress. We can keep discussing the project details.',
        }
      : await withAiUsage(businessId, id, () =>
          replyAsCustomerTurn({
            scenario: session.scenario,
            messages: session.messages,
            content,
            requestPhotos,
            images: photoContext.images,
            photoContext: photoContext.scenes,
          }),
        );
  const scenes =
    requestPhotos && !pending
      ? groundedPracticeScenes(session.scenario, content, result.photoRequest?.scenes)
      : [];
  const reply = scenes.length
    ? 'Practice photos for this fictional project:'
    : safePracticeReply(result.reply, !requestPhotos && Boolean(result.photoRequest));
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const [locked] = await rows(
      'SELECT status FROM training_sessions WHERE business_id = ? AND id = ? FOR UPDATE',
      [businessId, id],
      connection,
    );
    const messages = await getMessages(businessId, id, 'training', connection);
    if (locked.status !== 'active' || messages.length !== session.messages.length)
      throw new ApiError(
        409,
        'CONVERSATION_CHANGED',
        'The conversation changed. Refresh before sending again.',
      );
    await addMessage(businessId, id, 'training', 'user', content, connection);
    const messageId = await addMessage(businessId, id, 'training', 'assistant', reply, connection);
    if (scenes.length) await queueTrainingPhotos(businessId, id, messageId, scenes, connection);
  });
  res.json(ok(await trainingById(businessId, id)));
}
trainingRouter.post('/training/:id/messages', rateLimit(30, 60_000), (req, res) =>
  trainingMessage(req, res),
);
trainingRouter.post('/training/:id/photos', rateLimit(10, 60_000), (req, res) =>
  trainingMessage(req, res, true),
);
trainingRouter.post(
  '/training/:id/photos/:requestId/retry',
  rateLimit(10, 60_000),
  async (req, res) => {
    const businessId = owner(req).businessId,
      id = idSchema.parse(req.params.id),
      requestId = idSchema.parse(req.params.requestId);
    z.object({}).strict().parse(req.body);
    await retryTrainingPhotos(businessId, id, requestId);
    res.json(ok(await trainingById(businessId, id)));
  },
);
trainingRouter.get('/training/:id/photos/:photoId', async (req, res) => {
  const businessId = owner(req).businessId,
    id = idSchema.parse(req.params.id),
    photoId = idSchema.parse(req.params.photoId);
  const [photo] = await rows(
    'SELECT a.storage_key FROM attachments a JOIN training_sessions t ON t.id=a.conversation_id AND t.business_id=a.business_id WHERE a.business_id=? AND a.conversation_id=? AND a.id=? AND a.training_message_id IS NOT NULL',
    [businessId, id, photoId],
  );
  if (!photo) throw new ApiError(404, 'PHOTO_NOT_FOUND', 'Practice photo not found.');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(await getPhoto(photo.storage_key));
});
trainingRouter.post('/training/:id/complete', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const input = z
    .preprocess(
      (body) =>
        body && typeof body === 'object' && !('outcome' in body)
          ? { ...body, outcome: 'quote' }
          : body,
      z.discriminatedUnion('outcome', [
        z
          .object({
            outcome: z.literal('quote'),
            finalPriceCents: cents,
            rationale: z.string().trim().min(1).max(5000),
            saveAsExample: z.boolean().default(true),
          })
          .strict(),
        z
          .object({
            outcome: z.literal('inspection_required'),
            finalPriceCents: z.null(),
            rationale: z.string().trim().min(1).max(5000),
            saveAsExample: z.literal(false).default(false),
          })
          .strict(),
      ]),
    )
    .parse(req.body);
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const [locked] = await rows(
      'SELECT * FROM training_sessions WHERE business_id = ? AND id = ? FOR UPDATE',
      [businessId, id],
      connection,
    );
    if (!locked) throw new ApiError(404, 'TRAINING_NOT_FOUND', 'Training conversation not found.');
    if (locked.status === 'completed') {
      if (
        (locked.completion_outcome || 'quote') !== input.outcome ||
        (locked.final_price_cents === null ? null : Number(locked.final_price_cents)) !==
          input.finalPriceCents ||
        locked.rationale !== input.rationale
      )
        throw new ApiError(
          409,
          'TRAINING_COMPLETED',
          'This conversation was already completed with another decision.',
        );
      return;
    }
    const session = await trainingById(businessId, id, connection);
    let exampleId: string | null = null;
    const quantityText = session.scenario.details.quantity || '';
    const numeric = quantityText.match(/^\s*(\d[\d,]*(?:\.\d{1,3})?)(?:\s|$)/);
    const quantity = numeric ? Number(numeric[1].replaceAll(',', '')) : NaN;
    const service = await serviceById(businessId, session.serviceId, connection, true);
    const snapshotUnit = locked.unit_label || service.unitLabel;
    const proposal =
      input.outcome === 'quote' && samePricingUnit(snapshotUnit, service.unitLabel)
        ? proposeUnitPrice(
            { ...service, version: service.version + (input.saveAsExample ? 1 : 0) },
            quantity,
            input.finalPriceCents,
          )
        : undefined;
    if (input.outcome === 'quote' && input.saveAsExample) {
      if (!quantitySchema.safeParse(quantity).success)
        throw new ApiError(
          422,
          'SCENARIO_QUANTITY_UNKNOWN',
          'This scenario has no confirmed quantity. Complete without saving it as a price example, then add a historical example with the correct quantity.',
        );
      exampleId = randomUUID();
      await mutate(
        'INSERT INTO examples (id, business_id, service_id, title, description, quantity, final_price_cents, rationale, source, inputs_json,unit_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)',
        [
          exampleId,
          businessId,
          session.serviceId,
          session.scenario.title,
          session.scenario.description,
          quantity,
          input.finalPriceCents,
          input.rationale,
          'training',
          JSON.stringify(session.scenario.details),
          snapshotUnit,
        ],
        connection,
      );
      await invalidateAutomaticReadiness(businessId, session.serviceId, connection);
      await mutate(
        'UPDATE attachments SET example_id=? WHERE business_id=? AND conversation_id=? AND training_message_id IS NOT NULL',
        [exampleId, businessId, id],
        connection,
      );
    }
    if (input.outcome === 'inspection_required') {
      await invalidateAutomaticReadiness(businessId, session.serviceId, connection);
      await mutate(
        'INSERT INTO usage_events(id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
        [
          randomUUID(),
          businessId,
          'training_decision_saved',
          JSON.stringify({
            trainingId: id,
            serviceId: session.serviceId,
            outcome: input.outcome,
            billable: false,
          }),
        ],
        connection,
      );
    }
    await mutate(
      "UPDATE training_sessions SET status = 'completed', completion_outcome=?, final_price_cents = ?, rationale = ?, saved_example_id = ?, pricing_proposal_json = ? WHERE business_id = ? AND id = ?",
      [
        input.outcome,
        input.finalPriceCents,
        input.rationale,
        exampleId,
        proposal ? JSON.stringify(proposal) : null,
        businessId,
        id,
      ],
      connection,
    );
    await addMessage(
      businessId,
      id,
      'training',
      'user',
      input.outcome === 'inspection_required'
        ? input.rationale
        : `Final quote: $${(input.finalPriceCents / 100).toFixed(2)}. ${input.rationale}`,
      connection,
    );
  });
  res.json(ok(await trainingById(businessId, id)));
});
