import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { cookies, hashToken, newToken, owner, requireOwner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import { idSchema, type Message } from './domain.js';
import { ApiError, ok, rateLimit } from './http.js';
import { iso, json, serviceById, invalidateService, type Row } from './models.js';
import { aiMode } from './ai/index.js';
import { reserveGuestAiCall, withGuestAiUsage } from './usage.js';
import { generateGuestPreview, guestPreviewResultSchema } from './guest-preview-ai.js';
import { businessNameSuggestion } from './business-intro.js';
import { confirmSetupSession } from './service-setup.js';
import { verifyHuman } from './human-check.js';

const COOKIE = 'quotient_guest_preview',
  EXPIRY_MS = 30 * 60_000;
export const guestPreviewRouter = Router();
async function proofSession(req: Request, connection?: Sql, lock = false) {
  const token = cookies(req)[COOKIE];
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const [session] = await rows(
    `SELECT * FROM guest_preview_sessions WHERE proof_hash=? AND expires_at>UTC_TIMESTAMP(3)${lock ? ' FOR UPDATE' : ''}`,
    [hashToken(token)],
    connection,
  );
  return session || null;
}
async function bootstrap(req: Request, res: Response) {
  const existing = await proofSession(req);
  if (existing) return existing;
  const token = newToken(),
    id = randomUUID(),
    expiresAt = new Date(Date.now() + EXPIRY_MS);
  await mutate('INSERT INTO guest_preview_sessions(id,proof_hash,expires_at) VALUES (?,?,?)', [
    id,
    hashToken(token),
    expiresAt,
  ]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/guest-preview',
    maxAge: EXPIRY_MS,
  });
  return { id, expires_at: expiresAt };
}
function dto(row: Row) {
  const parsed = guestPreviewResultSchema.safeParse(json(row.result_json, null));
  const result = parsed.success ? parsed.data : null;
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    content: row.source_text || '',
    businessNameSuggestion:
      row.status === 'ready' && result?.readyToSave
        ? businessNameSuggestion(row.source_text || '')
        : null,
    expiresAt: iso(row.expires_at),
    receipt: result
      ? {
          ...result.draft,
          sourcePriceText: result.sourcePriceText,
          sourceCurrency: result.sourceCurrency,
        }
      : null,
    questions: result?.questions || [],
    readyToSave: row.status === 'ready' && Boolean(result?.readyToSave),
    aiMode,
    ...(row.error_json ? { error: json(row.error_json, {}) } : {}),
    ...(row.status === 'claimed'
      ? {
          claim: {
            serviceId: row.claimed_service_id,
            setupId: row.claimed_setup_id,
            proposalId: row.claimed_proposal_id,
          },
        }
      : {}),
  };
}
function usableReadyPreview(preview: ReturnType<typeof dto>) {
  const receipt = preview.receipt;
  return Boolean(
    preview.readyToSave &&
    receipt?.name &&
    receipt.description.trim().length >= 8 &&
    (receipt.example?.finalPriceCents == null || receipt.sourceCurrency === 'USD'),
  );
}
async function failExpiredLease(row: Row, connection?: Sql) {
  if (
    row.status !== 'processing' ||
    (row.processing_until && new Date(row.processing_until).getTime() > Date.now())
  )
    return row;
  const error = {
    code: 'GUEST_PREVIEW_INTERRUPTED',
    message:
      'This attempt stopped before it finished. Your note is still here; you can choose to try again.',
  };
  const changed = await mutate(
    "UPDATE guest_previews SET status='failed',processing_token=NULL,processing_until=NULL,error_json=? WHERE id=? AND status='processing' AND (processing_until IS NULL OR processing_until<=UTC_TIMESTAMP(3))",
    [JSON.stringify(error), row.id],
    connection,
  );
  if (!changed.affectedRows)
    return (await rows('SELECT * FROM guest_previews WHERE id=?', [row.id], connection))[0] || row;
  return { ...row, status: 'failed', error_json: error } as Row;
}
guestPreviewRouter.get('/guest-preview', rateLimit(60, 60_000), async (req, res) => {
  const selector = z
    .object({ requestId: idSchema.optional(), previewId: idSchema.optional() })
    .refine((value) => !(value.requestId && value.previewId), 'Choose one preview selector.')
    .parse(req.query);
  const session = await bootstrap(req, res),
    { requestId, previewId } = selector;
  const [row] = await rows(
    `SELECT * FROM guest_previews WHERE session_id=? AND expires_at>UTC_TIMESTAMP(3)${requestId ? ' AND request_id=?' : previewId ? ' AND id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 1`,
    requestId || previewId ? [session.id, (requestId || previewId)!] : [session.id],
  );
  const preview = row ? dto(await failExpiredLease(row)) : null;
  let recoverablePreview: ReturnType<typeof dto> | null = null;
  if (
    !preview ||
    preview.status === 'failed' ||
    (preview.status === 'ready' && !usableReadyPreview(preview))
  ) {
    const candidates = await rows(
      "SELECT * FROM guest_previews WHERE session_id=? AND expires_at>UTC_TIMESTAMP(3) AND status='ready' ORDER BY created_at DESC,id DESC",
      [session.id],
    );
    recoverablePreview = candidates.map(dto).find(usableReadyPreview) || null;
  }
  res.json(
    ok({
      preview,
      recoverablePreview,
      expiresAt: iso(session.expires_at),
    }),
  );
});
guestPreviewRouter.post('/guest-preview', rateLimit(12, 60_000), async (req, res) => {
  const input = z
    .object({
      content: z
        .string()
        .min(1)
        .max(5000)
        .refine(
          (value) =>
            Boolean(value.trim()) &&
            !value.includes('\0') &&
            Buffer.from(value).toString('utf8') === value,
          'Describe the work using valid text.',
        ),
      requestId: idSchema,
      expectedSessionExpiresAt: z.iso.datetime().optional(),
    })
    .strict()
    .parse(req.body);
  const inputHash = hashToken(input.content),
    processingToken = randomUUID();
  // Retries of an attempt reuse its preview; only a new attempt needs a fresh check.
  const session = await proofSession(req);
  const [attempt] = session
    ? await rows('SELECT id FROM guest_previews WHERE session_id=? AND request_id=?', [
        session.id,
        input.requestId,
      ])
    : [];
  if (session && !attempt) await verifyHuman(req, 'guest_preview');
  const reserved = await transaction(async (connection) => {
    const session = await proofSession(req, connection, true);
    if (!session)
      throw new ApiError(
        403,
        'GUEST_PROOF_REQUIRED',
        'Open the preview first, then submit your note.',
      );
    if (
      input.expectedSessionExpiresAt !== undefined &&
      input.expectedSessionExpiresAt !== iso(session.expires_at)
    )
      throw new ApiError(
        409,
        'GUEST_PREVIEW_PROOF_CHANGED',
        'This preview session changed. Your original note is kept; review it before starting again.',
      );
    const [existing] = await rows(
      'SELECT * FROM guest_previews WHERE session_id=? AND request_id=? FOR UPDATE',
      [session.id, input.requestId],
      connection,
    );
    if (existing) {
      if (existing.input_hash !== inputHash)
        throw new ApiError(
          409,
          'GUEST_REQUEST_CHANGED',
          'This attempt already belongs to a different note. Choose a new attempt to use your edits.',
        );
      return { row: await failExpiredLease(existing, connection), generate: false };
    }
    const id = randomUUID();
    await mutate(
      "INSERT INTO guest_previews(id,session_id,request_id,input_hash,source_text,status,processing_token,processing_until,expires_at) VALUES (?,?,?,?,?,'processing',?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),?)",
      [
        id,
        session.id,
        input.requestId,
        inputHash,
        input.content,
        processingToken,
        session.expires_at,
      ],
      connection,
    );
    await reserveGuestAiCall(
      { previewId: id, ip: req.ip || req.socket.remoteAddress || 'unknown' },
      connection,
    );
    const [saved] = await rows('SELECT * FROM guest_previews WHERE id=?', [id], connection);
    return { row: saved, generate: true };
  });
  if (!reserved.generate) {
    res
      .status(reserved.row.status === 'processing' ? 202 : 200)
      .json(ok({ preview: dto(reserved.row) }));
    return;
  }
  const id = reserved.row.id;
  try {
    const result = await withGuestAiUsage({ previewId: id }, () =>
      generateGuestPreview(input.content),
    );
    const updated = await mutate(
      "UPDATE guest_previews SET status='ready',result_json=?,processing_token=NULL,processing_until=NULL WHERE id=? AND status='processing' AND processing_token=? AND expires_at>UTC_TIMESTAMP(3)",
      [JSON.stringify(result), id, processingToken],
    );
    if (!updated.affectedRows)
      throw new ApiError(
        410,
        'GUEST_PREVIEW_EXPIRED',
        'This preview expired. Your original note can be used for a new preview.',
      );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'GUEST_PREVIEW_EXPIRED') throw error;
    await mutate(
      "UPDATE guest_previews SET status='failed',error_json=?,processing_token=NULL,processing_until=NULL WHERE id=? AND status='processing' AND processing_token=?",
      [
        JSON.stringify({
          code: 'GUEST_AI_FAILED',
          message:
            'We could not prepare this preview. Your note is still here; you can choose to try again.',
        }),
        id,
        processingToken,
      ],
    );
  }
  const [saved] = await rows(
    'SELECT * FROM guest_previews WHERE id=? AND expires_at>UTC_TIMESTAMP(3)',
    [id],
  );
  if (!saved)
    throw new ApiError(
      410,
      'GUEST_PREVIEW_EXPIRED',
      'This preview expired. Your original note can be used for a new preview.',
    );
  res.status(saved.status === 'ready' ? 201 : 200).json(ok({ preview: dto(saved) }));
});
async function ownedClaimResult(
  row: Row,
  context: { businessId: string; userId: string },
  connection: Sql,
  alreadyClaimed: boolean,
  expectedVersion: number,
) {
  if (row.claimed_business_id !== context.businessId || row.claimed_user_id !== context.userId)
    throw new ApiError(404, 'GUEST_PREVIEW_NOT_FOUND', 'Preview not found.');
  if (Number(row.version) !== expectedVersion)
    throw new ApiError(409, 'GUEST_PREVIEW_CHANGED', 'Review the current preview before saving.');
  if (!row.claimed_setup_id || !row.claimed_service_id || !row.claimed_proposal_id)
    throw new ApiError(410, 'GUEST_CLAIM_REMOVED', 'This saved assistant was removed.');
  const setup = await confirmSetupSession(connection, context, row.claimed_setup_id, 1);
  const [proposal] = await rows(
    'SELECT * FROM knowledge_proposals WHERE business_id=? AND id=?',
    [context.businessId, row.claimed_proposal_id],
    connection,
  );
  if (!proposal)
    throw new ApiError(410, 'GUEST_CLAIM_REMOVED', 'This saved assistant was removed.');
  return {
    ...setup,
    service: await serviceById(context.businessId, row.claimed_service_id, connection),
    proposal: {
      id: proposal.id,
      serviceId: proposal.service_id,
      serviceVersion: Number(proposal.service_version),
      appliedServiceVersion:
        proposal.applied_service_version == null ? null : Number(proposal.applied_service_version),
      teachingRevision: Number(proposal.teaching_revision),
      parentProposalId: null,
      status: proposal.status,
      proposal: json(proposal.proposal_json, {}),
      sourceExampleIds: json(proposal.source_ids_json, []),
      sourceCaseIds: json(proposal.source_case_ids_json, []),
      createdAt: iso(proposal.created_at),
    },
    alreadyClaimed,
  };
}
guestPreviewRouter.post('/guest-preview/:id/claim', requireOwner, async (req, res) => {
  const context = owner(req),
    id = idSchema.parse(req.params.id),
    input = z
      .object({ expectedVersion: z.number().int().positive(), approveIntake: z.literal(true) })
      .strict()
      .parse(req.body);
  const result = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [context.businessId], connection);
    const [snapshot] = await rows('SELECT * FROM guest_previews WHERE id=?', [id], connection);
    if (snapshot?.status === 'claimed') {
      const [claimed] = await rows(
        'SELECT * FROM guest_previews WHERE id=? FOR UPDATE',
        [id],
        connection,
      );
      return ownedClaimResult(claimed, context, connection, true, input.expectedVersion);
    }
    const session = await proofSession(req, connection, true);
    if (!session)
      throw new ApiError(
        403,
        'GUEST_PROOF_REQUIRED',
        'This preview expired or belongs to another browser. Your note can be used for a new preview.',
      );
    const [row] = await rows(
      'SELECT * FROM guest_previews WHERE id=? AND session_id=? FOR UPDATE',
      [id, session.id],
      connection,
    );
    if (!row) throw new ApiError(404, 'GUEST_PREVIEW_NOT_FOUND', 'Preview not found.');
    if (row.status === 'claimed')
      return ownedClaimResult(row, context, connection, true, input.expectedVersion);
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new ApiError(
        410,
        'GUEST_PREVIEW_EXPIRED',
        'This preview expired. Your note can be used for a new preview.',
      );
    if (Number(row.version) !== input.expectedVersion)
      throw new ApiError(409, 'GUEST_PREVIEW_CHANGED', 'Review the current preview before saving.');
    if (row.status !== 'ready')
      throw new ApiError(
        409,
        'GUEST_PREVIEW_NOT_READY',
        'Wait for a completed preview before saving.',
      );
    const preview = guestPreviewResultSchema.parse(json(row.result_json, null));
    if (!preview.readyToSave || !preview.draft.name || preview.draft.description.trim().length < 8)
      throw new ApiError(
        422,
        'GUEST_NEEDS_SCOPE',
        'Describe the service clearly before saving your assistant.',
      );
    if (
      preview.draft.example?.finalPriceCents !== null &&
      preview.draft.example?.finalPriceCents !== undefined &&
      preview.sourceCurrency !== 'USD'
    )
      throw new ApiError(
        422,
        'GUEST_CURRENCY_UNCONFIRMED',
        'The original source currency needs confirmation before its amount can be saved.',
      );
    const setupId = randomUUID(),
      proposalId = randomUUID(),
      now = new Date().toISOString();
    const messages: Message[] = [
      { id: randomUUID(), role: 'user', author: 'owner', content: row.source_text, createdAt: now },
      { id: randomUUID(), role: 'assistant', author: 'ai', content: preview.reply, createdAt: now },
    ];
    await mutate(
      'INSERT INTO service_setup_sessions(id,business_id,user_id,messages_json,draft_json,evidence_json) VALUES (?,?,?,?,?,?)',
      [
        setupId,
        context.businessId,
        context.userId,
        JSON.stringify(messages),
        JSON.stringify(preview.draft),
        JSON.stringify(preview.evidence),
      ],
      connection,
    );
    const setup = await confirmSetupSession(connection, context, setupId, 1);
    const questionProposal = {
      unitLabel: setup.service.unitLabel,
      unitPriceCents: 0,
      basePriceCents: 0,
      minimumChargeCents: 0,
      requiredInputs: preview.questions,
      pricingRules: [],
      exclusions: [],
      explanation:
        'Customer questions approved from your preview. You prepare and approve each price.',
      uncertainties: [],
    };
    await mutate(
      'UPDATE services SET required_inputs_json=? WHERE business_id=? AND id=?',
      [JSON.stringify(preview.questions), context.businessId, setup.service.id],
      connection,
    );
    await invalidateService(context.businessId, setup.service.id, connection);
    await mutate(
      "INSERT INTO knowledge_proposals(id,business_id,service_id,service_version,applied_service_version,status,proposal_json,source_ids_json,source_case_ids_json,teaching_revision,applied_at) VALUES (?,?,?,?,?,'applied',?,?,?,0,UTC_TIMESTAMP(3))",
      [
        proposalId,
        context.businessId,
        setup.service.id,
        setup.service.version,
        (await serviceById(context.businessId, setup.service.id, connection)).version,
        JSON.stringify(questionProposal),
        JSON.stringify(setup.example ? [setup.example.id] : []),
        JSON.stringify(setup.jobNote ? [setup.jobNote.id] : []),
      ],
      connection,
    );
    await mutate(
      'INSERT INTO usage_events(id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
      [
        randomUUID(),
        context.businessId,
        'guest_preview_claimed',
        JSON.stringify({
          previewId: id,
          setupId,
          serviceId: setup.service.id,
          proposalId,
          approveIntake: true,
          billable: false,
        }),
      ],
      connection,
    );
    if (row.usage_json)
      await mutate(
        'INSERT INTO usage_events(id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
        [
          randomUUID(),
          context.businessId,
          'ai_call',
          JSON.stringify({
            ...json(row.usage_json, {}),
            previewId: id,
            source: 'guest_preview',
            conversationId: `service-setup:${setupId}`,
          }),
        ],
        connection,
      );
    const receipt = {
      serviceId: setup.service.id,
      setupId,
      proposalId,
      evidenceSaved: setup.evidenceSaved,
      exampleId: setup.example?.id || null,
      jobNoteId: setup.jobNote?.id || null,
    };
    await mutate(
      "UPDATE guest_previews SET status='claimed',claimed_business_id=?,claimed_user_id=?,claimed_service_id=?,claimed_setup_id=?,claimed_proposal_id=?,claim_receipt_json=?,source_text=NULL,result_json=NULL,usage_json=NULL,error_json=NULL,processing_token=NULL,processing_until=NULL WHERE id=?",
      [
        context.businessId,
        context.userId,
        setup.service.id,
        setupId,
        proposalId,
        JSON.stringify(receipt),
        id,
      ],
      connection,
    );
    const [claimed] = await rows('SELECT * FROM guest_previews WHERE id=?', [id], connection);
    return ownedClaimResult(claimed, context, connection, false, input.expectedVersion);
  });
  res.json(ok(result));
});
