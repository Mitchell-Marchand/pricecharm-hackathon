import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { idSchema, type Message } from './domain.js';
import { ApiError, ok, rateLimit } from './http.js';
import { businessById, serviceById, examplesForBusiness, json, type Row } from './models.js';
import { withAiUsage } from './usage.js';
import { aiMode } from './ai/index.js';
import { jobNotesForBusiness } from './job-notes.js';
import {
  emptySetupDraft,
  emptySetupEvidence,
  exactGuestHistoricalQuote,
  guideServiceSetup,
  hydrateMissingSetupFacts,
  readyForSetupConfirmation,
  sameSetupUnit,
  setupDraftSchema,
  type SetupDraft,
  type SetupEvidence,
} from './service-setup-ai.js';

export interface SetupSession {
  id: string;
  status: 'active' | 'confirmed';
  version: number;
  messages: Message[];
  draft: SetupDraft;
  readyToConfirm: boolean;
  serviceId: string | null;
}
function mapSession(row: Row): SetupSession {
  const messages = json<Message[]>(row.messages_json, []),
    draft = hydrateMissingSetupFacts(
      setupDraftSchema.parse(json(row.draft_json, emptySetupDraft)),
      messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n\n'),
    );
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    messages,
    draft,
    readyToConfirm: readyForSetupConfirmation(draft),
    serviceId: row.service_id || null,
  };
}
async function sessionForOwner(
  businessId: string,
  userId: string,
  id: string,
  connection?: Sql,
  lock = false,
) {
  const [row] = await rows(
    `SELECT * FROM service_setup_sessions WHERE business_id = ? AND user_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`,
    [businessId, userId, id],
    connection,
  );
  if (!row) throw new ApiError(404, 'SETUP_NOT_FOUND', 'Service setup conversation not found.');
  return row;
}
function assertVersion(row: Row, expected: number) {
  if (Number(row.version) !== expected)
    throw new ApiError(
      409,
      'SETUP_VERSION_CONFLICT',
      'This setup conversation changed. Refresh it before continuing.',
      { currentVersion: Number(row.version) },
    );
}
function processing(row: Row) {
  return Boolean(
    row.processing_token &&
    row.processing_until &&
    new Date(row.processing_until).getTime() > Date.now(),
  );
}
export const serviceSetupRouter = Router();
serviceSetupRouter.post('/service-setup', rateLimit(15, 60_000), async (req, res) => {
  z.object({}).strict().parse(req.body);
  const context = owner(req);
  const session = await transaction(async (connection) => {
    await rows(
      'SELECT id FROM businesses WHERE id = ? FOR UPDATE',
      [context.businessId],
      connection,
    );
    const [existing] = await rows(
      "SELECT * FROM service_setup_sessions WHERE business_id = ? AND user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",
      [context.businessId, context.userId],
      connection,
    );
    if (existing) return mapSession(existing);
    const [count] = await rows(
      'SELECT COUNT(*) AS count FROM service_setup_sessions WHERE business_id = ?',
      [context.businessId],
      connection,
    );
    if (Number(count.count) >= 200)
      throw new ApiError(
        422,
        'SETUP_LIMIT',
        'This workspace reached its saved setup conversation limit.',
      );
    const business = await businessById(context.businessId, connection),
      id = randomUUID();
    const initial: Message = {
      id: randomUUID(),
      role: 'assistant',
      author: 'ai',
      content: `${aiMode === 'demo' ? '[Demo guide] ' : ''}${business.description.trim() ? 'I’ve got your business overview. ' : ''}Tell me about one job you quoted: what was the work, what did you charge, and what affected the price? If you’re starting fresh, just tell me what you do.`,
      createdAt: new Date().toISOString(),
    };
    await mutate(
      'INSERT INTO service_setup_sessions (id,business_id,user_id,messages_json,draft_json,evidence_json) VALUES (?,?,?,?,?,?)',
      [
        id,
        context.businessId,
        context.userId,
        JSON.stringify([initial]),
        JSON.stringify(emptySetupDraft),
        JSON.stringify(emptySetupEvidence),
      ],
      connection,
    );
    return mapSession(await sessionForOwner(context.businessId, context.userId, id, connection));
  });
  res.status(201).json(ok(session));
});
serviceSetupRouter.get('/service-setup/:id', async (req, res) => {
  const context = owner(req);
  res.json(
    ok(
      mapSession(
        await sessionForOwner(context.businessId, context.userId, idSchema.parse(req.params.id)),
      ),
    ),
  );
});
serviceSetupRouter.post('/service-setup/:id/messages', rateLimit(20, 60_000), async (req, res) => {
  const context = owner(req),
    id = idSchema.parse(req.params.id),
    input = z
      .object({
        content: z.string().trim().min(1).max(5000),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(req.body),
    token = randomUUID();
  const snapshot = await transaction(async (connection) => {
    await rows(
      'SELECT id FROM businesses WHERE id = ? FOR UPDATE',
      [context.businessId],
      connection,
    );
    const row = await sessionForOwner(context.businessId, context.userId, id, connection, true);
    if (row.status !== 'active')
      throw new ApiError(
        409,
        'SETUP_CONFIRMED',
        'This service was already confirmed. Continue in its training conversation.',
      );
    assertVersion(row, input.expectedVersion);
    if (processing(row))
      throw new ApiError(409, 'SETUP_PROCESSING', 'The guide is responding. Please wait a moment.');
    const session = mapSession(row);
    if (
      session.messages.length >= 41 ||
      session.messages.reduce(
        (sum, message) => sum + message.content.length,
        input.content.length,
      ) > 80000
    )
      throw new ApiError(
        422,
        'SETUP_CONVERSATION_LIMIT',
        'Review the current service draft or start a new service.',
      );
    await mutate(
      'UPDATE service_setup_sessions SET processing_token = ?, processing_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 90 SECOND) WHERE business_id = ? AND user_id = ? AND id = ?',
      [token, context.businessId, context.userId, id],
      connection,
    );
    return session;
  });
  try {
    const result = await withAiUsage(context.businessId, `service-setup:${id}`, () =>
      businessById(context.businessId).then((business) =>
        guideServiceSetup({
          business,
          draft: snapshot.draft,
          messages: snapshot.messages,
          content: input.content,
        }),
      ),
    );
    const session = await transaction(async (connection) => {
      await rows(
        'SELECT id FROM businesses WHERE id = ? FOR UPDATE',
        [context.businessId],
        connection,
      );
      const row = await sessionForOwner(context.businessId, context.userId, id, connection, true);
      assertVersion(row, input.expectedVersion);
      if (row.status !== 'active' || row.processing_token !== token)
        throw new ApiError(
          409,
          'SETUP_VERSION_CONFLICT',
          'This setup conversation changed. Refresh before continuing.',
        );
      const messages: Message[] = [
        ...snapshot.messages,
        {
          id: randomUUID(),
          role: 'user',
          author: 'owner',
          content: input.content,
          createdAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          role: 'assistant',
          author: 'ai',
          content: result.reply,
          createdAt: new Date().toISOString(),
        },
      ];
      await mutate(
        'UPDATE service_setup_sessions SET messages_json = ?, draft_json = ?, evidence_json = ?, version = version + 1, processing_token = NULL, processing_until = NULL WHERE business_id = ? AND user_id = ? AND id = ?',
        [
          JSON.stringify(messages),
          JSON.stringify(result.draft),
          JSON.stringify(result.evidence),
          context.businessId,
          context.userId,
          id,
        ],
        connection,
      );
      return mapSession(await sessionForOwner(context.businessId, context.userId, id, connection));
    });
    res.json(ok(session));
  } finally {
    await mutate(
      'UPDATE service_setup_sessions SET processing_token = NULL, processing_until = NULL WHERE business_id = ? AND user_id = ? AND id = ? AND processing_token = ?',
      [context.businessId, context.userId, id, token],
    );
  }
});
/** The caller supplies one transaction; owner and guest confirmation share the same evidence rules. */
export async function confirmSetupSession(
  connection: Sql,
  context: { businessId: string; userId: string },
  id: string,
  expectedVersion: number,
) {
  await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [context.businessId], connection);
  const row = await sessionForOwner(context.businessId, context.userId, id, connection, true),
    session = mapSession(row);
  if (row.status === 'confirmed') {
    const service = await serviceById(context.businessId, row.service_id, connection);
    const example = row.example_id
      ? (await examplesForBusiness(context.businessId, service.id, connection)).find(
          (item) => item.id === row.example_id,
        )
      : undefined;
    const jobNote = example
      ? undefined
      : (await jobNotesForBusiness(context.businessId, service.id, connection)).find(
          (note) => note.id === id,
        );
    return {
      session,
      service,
      evidenceSaved: example
        ? 'price_example'
        : jobNote?.kind === 'historical_job'
          ? 'job_note'
          : 'service_only',
      ...(example ? { example } : {}),
      ...(jobNote ? { jobNote } : {}),
    };
  }
  assertVersion(row, expectedVersion);
  if (processing(row))
    throw new ApiError(
      409,
      'SETUP_PROCESSING',
      'Wait for the guide to finish before confirming this draft.',
    );
  if (!session.readyToConfirm)
    throw new ApiError(
      422,
      'SETUP_NEEDS_SCOPE',
      'Describe what customers hire you to do before confirming the service. Prices are optional.',
    );
  const [count] = await rows(
    'SELECT COUNT(*) AS count FROM services WHERE business_id = ?',
    [context.businessId],
    connection,
  );
  if (Number(count.count) >= 50)
    throw new ApiError(422, 'SERVICE_LIMIT', 'This workspace can contain up to 50 services.');
  const serviceId = randomUUID(),
    unitLabel = session.draft.unitLabel || 'project';
  await mutate(
    "INSERT INTO services (id,business_id,name,description,unit_label,unit_price_cents,minimum_charge_cents,base_price_cents,max_auto_quote_cents,required_inputs_json,exclusions_json,pricing_rules_json,mode) VALUES (?,?,?,?,?,0,0,0,0,'[]','[]','[]','review')",
    [serviceId, context.businessId, session.draft.name!, session.draft.description, unitLabel],
    connection,
  );
  const evidence = json<SetupEvidence>(row.evidence_json, emptySetupEvidence),
    historical = session.draft.example;
  const explicitQuantityAndUnit =
    historical?.quantity !== null &&
    Boolean(session.draft.unitLabel && evidence.unitLabel && evidence.exampleQuantity);
  const singleProject = Boolean(
    historical &&
    historical.finalPriceCents !== null &&
    evidence.singleProjectFixedTotal &&
    evidence.singleProject &&
    (session.draft.unitLabel === null || sameSetupUnit(session.draft.unitLabel, 'project')),
  );
  let exampleId: string | null = null;
  if (
    historical &&
    historical.finalPriceCents !== null &&
    historical.description.trim().length >= 3 &&
    (explicitQuantityAndUnit || singleProject)
  ) {
    const [exampleCount] = await rows(
      'SELECT COUNT(*) AS count FROM examples WHERE business_id = ?',
      [context.businessId],
      connection,
    );
    if (Number(exampleCount.count) >= 500)
      throw new ApiError(
        422,
        'EXAMPLE_LIMIT',
        'This workspace reached its 500-example allowance. Your setup notes are saved; remove an older example before confirming this one.',
      );
    exampleId = randomUUID();
    await mutate(
      "INSERT INTO examples (id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source,inputs_json,unit_label) VALUES (?,?,?,?,?,?,?,?,'historical','{}',?)",
      [
        exampleId,
        context.businessId,
        serviceId,
        historical.title || 'Project discussed during service setup',
        historical.description,
        explicitQuantityAndUnit ? historical.quantity! : 1,
        historical.finalPriceCents,
        exactGuestHistoricalQuote(
          session.draft,
          session.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content)
            .join('\n\n'),
        )
          ? historical.rationale
          : historical.rationale ||
            'Captured during service setup; no pricing rationale was provided.',
        unitLabel,
      ],
      connection,
    );
  }
  await mutate(
    "UPDATE service_setup_sessions SET status = 'confirmed', version = version + 1, service_id = ?, example_id = ?, draft_json = ? WHERE business_id = ? AND user_id = ? AND id = ?",
    [serviceId, exampleId, JSON.stringify(session.draft), context.businessId, context.userId, id],
    connection,
  );
  await mutate(
    'INSERT INTO usage_events (id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
    [
      randomUUID(),
      context.businessId,
      'service_setup_confirmed',
      JSON.stringify({
        sessionId: id,
        serviceId,
        exampleId,
        partialExampleRetained: Boolean(historical && !exampleId),
        billable: false,
      }),
    ],
    connection,
  );
  const confirmed = mapSession(
      await sessionForOwner(context.businessId, context.userId, id, connection),
    ),
    service = await serviceById(context.businessId, serviceId, connection);
  const example = exampleId
    ? (await examplesForBusiness(context.businessId, serviceId, connection)).find(
        (item) => item.id === exampleId,
      )
    : undefined;
  const jobNote = example
    ? undefined
    : (await jobNotesForBusiness(context.businessId, serviceId, connection)).find(
        (note) => note.id === id,
      );
  return {
    session: confirmed,
    service,
    evidenceSaved: example
      ? 'price_example'
      : jobNote?.kind === 'historical_job'
        ? 'job_note'
        : 'service_only',
    ...(example ? { example } : {}),
    ...(jobNote ? { jobNote } : {}),
  };
}
serviceSetupRouter.post('/service-setup/:id/confirm', async (req, res) => {
  const context = owner(req),
    id = idSchema.parse(req.params.id),
    { expectedVersion } = z
      .object({ expectedVersion: z.number().int().positive() })
      .strict()
      .parse(req.body);
  const result = await transaction((connection) =>
    confirmSetupSession(connection, context, id, expectedVersion),
  );
  res.json(ok(result));
});
