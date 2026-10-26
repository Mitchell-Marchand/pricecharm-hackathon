import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { owner } from './auth.js';
import { rows, mutate, transaction } from './db.js';
import { exampleSchema } from './domain.js';
import { ApiError, ok, rateLimit } from './http.js';
import { aiMode, type AiImage, type AiDocument } from './ai/index.js';
import {
  extractHistoricalProjects,
  proposeFromExamples,
  pricingProposalSchema,
  ownerNotePricingConflicts,
  ownerNoteCorrectionQuestion,
  type LearningInput,
} from './learning.js';
import {
  examplesForBusiness,
  invalidateService,
  invalidateAutomaticReadiness,
  iso,
  json,
  serviceById,
} from './models.js';
import { withAiUsage } from './usage.js';
import { inspectPdf } from './pdf.js';
import { teachingState, publicTeaching, pricingSnapshot } from './teaching.js';
import { jobNotesForBusiness } from './job-notes.js';
import { sameAppliedPolicy } from './proposal-policy.js';
import {
  importDraft as draft,
  importConfirmationSchema,
  importConfirmationHash,
  importReceipt,
  resolveImportSelection,
} from './import-history.js';

export const knowledgeRouter = Router();
function proposal(row: Record<string, any>) {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceVersion: Number(row.service_version),
    appliedServiceVersion:
      row.applied_service_version == null ? null : Number(row.applied_service_version),
    teachingRevision: Number(row.teaching_revision || 0),
    parentProposalId: row.parent_proposal_id || null,
    status: row.status,
    proposal: json(row.proposal_json, {}),
    sourceExampleIds: json(row.source_ids_json, []),
    sourceCaseIds: json(row.source_case_ids_json, []),
    createdAt: iso(row.created_at),
  };
}
knowledgeRouter.post('/services/:id/learn', rateLimit(5, 60_000), async (req, res) => {
  const businessId = owner(req).businessId,
    id = z.string().uuid().parse(req.params.id);
  const body = z
    .object({
      notes: z.string().trim().max(6000).default(''),
      expectedTeachingRevision: z.number().int().nonnegative().optional(),
      previousProposalId: z.string().uuid().optional(),
    })
    .strict()
    .parse(req.body);
  const snapshot = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const service = await serviceById(businessId, id, connection, true),
      teaching = await teachingState(businessId, id, connection);
    if (
      body.expectedTeachingRevision !== undefined &&
      body.expectedTeachingRevision !== teaching.revision
    )
      throw new ApiError(
        409,
        'TEACHING_CHANGED',
        'Your saved notes changed. Review the latest suggestion before trying again.',
        { teaching: publicTeaching(teaching) },
      );
    if (body.previousProposalId) {
      const [parent] = await rows(
        'SELECT * FROM knowledge_proposals WHERE business_id=? AND service_id=? AND id=?',
        [businessId, id, body.previousProposalId],
        connection,
      );
      if (!parent) throw new ApiError(404, 'NOT_FOUND', 'Pricing proposal not found.');
      if (Number(parent.teaching_revision) !== teaching.revision)
        throw new ApiError(
          409,
          'TEACHING_CHANGED',
          'A newer owner note is already saved. Review it before updating this suggestion.',
        );
      if (parent.status !== 'applied' && Number(parent.service_version) !== service.version)
        throw new ApiError(
          409,
          'STALE_PROPOSAL',
          'Pricing changed. Review the current suggestion before adding notes.',
        );
    }
    return { service, teaching };
  });
  const { service, teaching } = snapshot;
  const correctionQuestion = ownerNoteCorrectionQuestion(body.notes);
  if (correctionQuestion)
    throw new ApiError(422, 'OWNER_NOTES_AMBIGUOUS', correctionQuestion, {
      fields: ['priceTarget'],
    });
  const conflicts = ownerNotePricingConflicts(body.notes, service.unitLabel);
  if (conflicts.length)
    throw new ApiError(
      422,
      'OWNER_NOTES_AMBIGUOUS',
      'Which price is current? State one current rate, minimum or base fee for each item you are changing.',
      { fields: conflicts },
    );
  if (
    teaching.notes.length >= 100 ||
    teaching.notes.reduce((sum, note) => sum + note.content.length, 0) + body.notes.length > 30000
  )
    throw new ApiError(
      422,
      'TEACHING_LIMIT',
      'These notes reached their allowance. Update the service pricing directly before adding more notes.',
    );
  const examples = (await examplesForBusiness(businessId, id)).slice(0, 30);
  const caseNotes = (await jobNotesForBusiness(businessId, id)).slice(0, 30);
  if (!examples.length && !caseNotes.length && !body.notes)
    throw new ApiError(
      422,
      'EVIDENCE_REQUIRED',
      'Describe your work or a past job, or save a practice decision before asking for a suggestion.',
    );
  const [setup] = await rows(
    "SELECT messages_json FROM service_setup_sessions WHERE business_id=? AND service_id=? AND status='confirmed' ORDER BY updated_at DESC LIMIT 1",
    [businessId, id],
  );
  const introductionNotes = setup
    ? json<{ role: string; content: string }[]>(setup.messages_json, [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n')
    : '';
  const history = [introductionNotes, ...teaching.notes.map((note) => note.content)].filter(
    Boolean,
  );
  const ownerNotes = [...history, body.notes].filter(Boolean).join('\n\n');
  const ownerConfigurationHistory: NonNullable<LearningInput['ownerConfigurationHistory']> = [];
  for (let index = 1; index < teaching.pricingSnapshots.length; index++) {
    const previous = teaching.pricingSnapshots[index - 1],
      current = teaching.pricingSnapshots[index];
    const change: NonNullable<LearningInput['ownerConfigurationHistory']>[number] = {
      beforeNote: index + (introductionNotes ? 1 : 0),
      unitContext: current.unitLabel,
    };
    for (const field of ['unitLabel', 'unit', 'minimum', 'base'] as const) {
      if (previous[field] !== current[field]) {
        if (field === 'unitLabel') change.unitLabel = current.unitLabel;
        else change[field] = current[field];
      }
    }
    if (change.unitLabel) change.unit = current.unit;
    ownerConfigurationHistory.push(change);
  }
  const configured = pricingSnapshot(service);
  const configuredAfterNotes = Object.fromEntries(
    Object.entries(configured).map(([key, value]) => [
      key,
      teaching.pricingBaseline !== undefined && teaching.pricingBaseline[key] !== value,
    ]),
  );
  const learningInput: LearningInput = {
    service,
    examples,
    caseNotes,
    ownerNotes,
    ownerNoteHistory: history,
    ownerConfigurationHistory,
    currentOwnerNotes: body.notes,
    configuredAfterNotes,
  };
  if (JSON.stringify(learningInput).length > 400000)
    throw new ApiError(
      422,
      'LEARNING_EVIDENCE_LIMIT',
      'These saved notes are too long to read together. Remove unused saved jobs, or update the service pricing directly before trying again.',
    );
  const result = await withAiUsage(businessId, undefined, () => proposeFromExamples(learningInput));
  const proposalId = randomUUID();
  const saved = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const current = await serviceById(businessId, id, connection, true),
      latest = await teachingState(businessId, id, connection);
    if (current.version !== service.version)
      throw new ApiError(
        409,
        'STALE_PROPOSAL',
        'Pricing changed while the suggestion was being prepared. Review the current pricing before trying again.',
      );
    if (latest.revision !== teaching.revision)
      throw new ApiError(
        409,
        'TEACHING_CHANGED',
        'Your notes changed while the suggestion was being prepared. Review the latest notes before trying again.',
      );
    const nextRevision = teaching.revision + (body.notes ? 1 : 0);
    if (body.notes) {
      await mutate(
        'INSERT INTO service_teaching_notes(id,business_id,service_id,revision,content,pricing_snapshot_json) VALUES (?,?,?,?,?,?)',
        [randomUUID(), businessId, id, nextRevision, body.notes, JSON.stringify(configured)],
        connection,
      );
      await mutate(
        'UPDATE services SET teaching_revision=? WHERE business_id=? AND id=?',
        [nextRevision, businessId, id],
        connection,
      );
    }
    await mutate(
      'INSERT INTO knowledge_proposals(id,business_id,service_id,service_version,teaching_revision,parent_proposal_id,proposal_json,source_ids_json,source_case_ids_json) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        proposalId,
        businessId,
        id,
        service.version,
        nextRevision,
        body.previousProposalId || null,
        JSON.stringify(result),
        JSON.stringify(examples.map((item) => item.id)),
        JSON.stringify(caseNotes.map((item) => item.id)),
      ],
      connection,
    );
    const [row] = await rows(
      'SELECT * FROM knowledge_proposals WHERE business_id=? AND id=?',
      [businessId, proposalId],
      connection,
    );
    return {
      proposal: proposal(row),
      teaching: publicTeaching(await teachingState(businessId, id, connection)),
    };
  });
  res.status(201).json(ok(saved));
});
knowledgeRouter.get('/services/:id/proposals', async (req, res) => {
  const businessId = owner(req).businessId,
    id = z.string().uuid().parse(req.params.id);
  await serviceById(businessId, id);
  res.json(
    ok({
      teaching: publicTeaching(await teachingState(businessId, id)),
      proposals: (
        await rows(
          'SELECT * FROM knowledge_proposals WHERE business_id = ? AND service_id = ? ORDER BY created_at DESC LIMIT 30',
          [businessId, id],
        )
      ).map(proposal),
    }),
  );
});
knowledgeRouter.post('/proposals/:id/apply', async (req, res) => {
  const businessId = owner(req).businessId,
    id = z.string().uuid().parse(req.params.id);
  const result = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const [row] = await rows(
      'SELECT * FROM knowledge_proposals WHERE business_id = ? AND id = ? FOR UPDATE',
      [businessId, id],
      connection,
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Pricing proposal not found.');
    const service = await serviceById(businessId, row.service_id, connection, true);
    const teaching = await teachingState(businessId, row.service_id, connection);
    if (teaching.revision !== Number(row.teaching_revision || 0))
      throw new ApiError(
        409,
        'TEACHING_CHANGED',
        'Newer owner notes are saved. Review the latest suggestion before applying rules.',
      );
    if (row.status === 'applied') return { service, proposal: proposal(row) };
    if (service.version !== Number(row.service_version))
      throw new ApiError(
        409,
        'STALE_PROPOSAL',
        'This proposal uses an older pricing version. Generate a new proposal.',
      );
    const next = pricingProposalSchema.parse(json(row.proposal_json, {}));
    const required = new Set(next.requiredInputs.map((field) => field.toLowerCase()));
    if (next.pricingRules.some((rule) => !required.has(rule.field.toLowerCase())))
      throw new ApiError(
        422,
        'MISSING_RULE_INPUT',
        'Every pricing rule field must be included in the required project details.',
      );
    const effective = { ...next, unitLabel: next.unitLabel || service.unitLabel };
    const policyChanged = !sameAppliedPolicy(service, effective);
    if (policyChanged) {
      await mutate(
        'UPDATE services SET unit_label=?,unit_price_cents=?,base_price_cents=?,minimum_charge_cents=?,required_inputs_json=?,exclusions_json=?,pricing_rules_json=? WHERE business_id=? AND id=?',
        [
          effective.unitLabel,
          next.unitPriceCents,
          next.basePriceCents,
          next.minimumChargeCents,
          JSON.stringify(next.requiredInputs),
          JSON.stringify(next.exclusions),
          JSON.stringify(next.pricingRules),
          businessId,
          service.id,
        ],
        connection,
      );
      await invalidateService(businessId, service.id, connection);
    }
    const appliedServiceVersion = service.version + (policyChanged ? 1 : 0);
    await mutate(
      "UPDATE knowledge_proposals SET status='applied',applied_at=UTC_TIMESTAMP(3),applied_service_version=? WHERE id=? AND business_id=?",
      [appliedServiceVersion, id, businessId],
      connection,
    );
    await mutate(
      'INSERT INTO usage_events (id,business_id,kind,metadata_json) VALUES (?,?,?,?)',
      [
        randomUUID(),
        businessId,
        'pricing_proposal_applied',
        JSON.stringify({
          proposalId: id,
          serviceId: service.id,
          previousVersion: service.version,
          appliedServiceVersion,
          policyChanged,
          previousUnitLabel: service.unitLabel,
          nextUnitLabel: next.unitLabel || service.unitLabel,
        }),
      ],
      connection,
    );
    return {
      service: await serviceById(businessId, service.id, connection),
      proposal: proposal({
        ...row,
        status: 'applied',
        applied_service_version: appliedServiceVersion,
      }),
    };
  });
  res.json(ok(result));
});

let extracting = 0;
const extractionSlot: RequestHandler = (_req, res, next) => {
  if (extracting >= 2)
    return next(
      new ApiError(503, 'IMPORT_BUSY', 'Documents are being processed. Try again in a moment.'),
    );
  extracting++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      extracting--;
    }
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};
const single = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
}).single('file');
const documentUpload: RequestHandler = (req, res, next) =>
  single(req, res, (error) =>
    next(
      error instanceof multer.MulterError
        ? new ApiError(413, 'IMPORT_LIMIT', 'Upload one document smaller than 4 MB.')
        : error,
    ),
  );
knowledgeRouter.post(
  '/imports/document',
  rateLimit(5, 60_000),
  extractionSlot,
  documentUpload,
  async (req, res) => {
    const businessId = owner(req).businessId,
      serviceId = z.string().uuid().parse(req.body.serviceId);
    const service = await serviceById(businessId, serviceId);
    if (!req.file)
      throw new ApiError(400, 'FILE_REQUIRED', 'Choose a PDF, photo, or plain text document.');
    const file = req.file,
      bytes = file.buffer;
    if (
      file.mimetype === 'text/plain' &&
      (bytes.length > 100_000 ||
        bytes.includes(0) ||
        !isUtf8(bytes) ||
        !bytes.toString('utf8').trim())
    )
      throw new ApiError(
        422,
        'INVALID_TEXT',
        'Upload valid UTF-8 plain text smaller than 100 KB containing a job description.',
      );
    const hash = createHash('sha256')
      .update(serviceId)
      .update('\0' + service.unitLabel + '\0')
      .update(bytes)
      .digest('hex');
    const [existing] = await rows(
      'SELECT * FROM import_drafts WHERE business_id=? AND source_hash=?',
      [businessId, hash],
    );
    if (existing) {
      res.json(ok({ draft: draft(existing) }));
      return;
    }
    if (aiMode === 'demo')
      throw new ApiError(
        503,
        'LIVE_AI_REQUIRED',
        'Document extraction needs a live AI provider. You can enter projects manually or import CSV in local test mode.',
      );
    const filename =
      path
        .basename(file.originalname)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 180) || 'document';
    let text: string | undefined,
      images: AiImage[] | undefined,
      documents: AiDocument[] | undefined;
    if (file.mimetype === 'application/pdf' && bytes.toString('ascii', 0, 5) === '%PDF-') {
      await inspectPdf(bytes);
      documents = [
        {
          filename: filename.endsWith('.pdf') ? filename : `${filename}.pdf`,
          mimeType: 'application/pdf',
          dataBase64: bytes.toString('base64'),
        },
      ];
    } else if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      const valid =
        bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
      if (!valid)
        throw new ApiError(
          422,
          'INVALID_IMAGE',
          'The file contents must be a JPEG, PNG, or WebP image.',
        );
      let photo: Buffer;
      try {
        photo = await sharp(bytes, { limitInputPixels: 16_000_000, animated: false })
          .rotate()
          .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch {
        throw new ApiError(422, 'INVALID_IMAGE', 'The document image could not be read.');
      }
      if (photo.length > 1024 * 1024)
        throw new ApiError(413, 'IMAGE_TOO_COMPLEX', 'Upload a smaller document image.');
      images = [{ mimeType: 'image/jpeg', dataBase64: photo.toString('base64') }];
    } else if (file.mimetype === 'text/plain') {
      text = bytes.toString('utf8');
    } else
      throw new ApiError(
        415,
        'UNSUPPORTED_DOCUMENT',
        'Upload a PDF, JPEG, PNG, WebP, or plain text document.',
      );
    const extracted = await withAiUsage(businessId, undefined, () =>
      extractHistoricalProjects({ service, text, images, documents }),
    );
    const projects = extracted.projects.map((item) => ({
      ...item,
      id: randomUUID(),
      inputs: Object.fromEntries(
        item.inputs
          .filter(
            (field) =>
              !['__proto__', 'constructor', 'prototype'].includes(field.name.toLowerCase()),
          )
          .map((field) => [field.name, field.value]),
      ),
    }));
    const id = randomUUID();
    await mutate(
      'INSERT INTO import_drafts (id,business_id,service_id,filename,source_hash,draft_json,unit_label,source_text,source_basis) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        id,
        businessId,
        serviceId,
        filename,
        hash,
        JSON.stringify({ projects, notes: extracted.notes }),
        service.unitLabel,
        text ?? null,
        text === undefined ? 'reviewed_extraction' : 'exact_owner_text',
      ],
    );
    const [saved] = await rows('SELECT * FROM import_drafts WHERE business_id=? AND id=?', [
      businessId,
      id,
    ]);
    res.status(201).json(ok({ draft: draft(saved) }));
  },
);
knowledgeRouter.get('/imports', async (req, res) => {
  const businessId = owner(req).businessId,
    serviceId = req.query.serviceId ? z.string().uuid().parse(req.query.serviceId) : undefined;
  if (serviceId) await serviceById(businessId, serviceId);
  const items = await rows(
    `SELECT * FROM import_drafts WHERE business_id=? ${serviceId ? 'AND service_id=?' : ''} ORDER BY created_at DESC LIMIT 30`,
    serviceId ? [businessId, serviceId] : [businessId],
  );
  res.json(ok({ drafts: items.map((item) => draft(item, false)) }));
});
knowledgeRouter.get('/imports/:id', async (req, res) => {
  const [row] = await rows('SELECT * FROM import_drafts WHERE business_id=? AND id=?', [
    owner(req).businessId,
    z.string().uuid().parse(req.params.id),
  ]);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Import draft not found.');
  res.json(ok({ draft: draft(row) }));
});
knowledgeRouter.post('/imports/:id/confirm', async (req, res) => {
  const businessId = owner(req).businessId,
    id = z.string().uuid().parse(req.params.id);
  const input = importConfirmationSchema.parse(req.body);
  const result = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const [row] = await rows(
      'SELECT * FROM import_drafts WHERE business_id=? AND id=? FOR UPDATE',
      [businessId, id],
      connection,
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Import draft not found.');
    if (row.status === 'confirmed' && (!row.confirmation_hash || !importReceipt(row)))
      throw new ApiError(
        409,
        'IMPORT_ALREADY_CONFIRMED',
        'This source was already imported. Review your saved jobs before importing it again.',
      );
    const projects = resolveImportSelection(row, input),
      fingerprint = importConfirmationHash(id, projects);
    if (row.status === 'confirmed') {
      if (row.confirmation_hash !== fingerprint)
        throw new ApiError(
          409,
          'IMPORT_CONFIRMATION_CONFLICT',
          'This draft was already saved with different details. Your current edits were not saved; review the saved jobs.',
        );
      return { ...importReceipt(row)!, alreadyConfirmed: true, draft: draft(row) };
    }
    await serviceById(businessId, row.service_id, connection, true);
    const numeric = projects
      .filter((project) => !project.saveAsNote)
      .map((project) => ({
        sourceProjectId: project.projectId,
        example: exampleSchema.parse({
          title: project.title,
          description: project.description,
          quantity: project.quantity,
          finalPriceCents: project.finalPriceCents,
          rationale: project.rationale,
          inputs: project.inputs,
          unitLabel: project.unitLabel!,
          serviceId: row.service_id,
          source: 'historical',
        }),
      }));
    const [count] = await rows(
      'SELECT COUNT(*) AS count FROM examples WHERE business_id=?',
      [businessId],
      connection,
    );
    if (Number(count.count) + numeric.length > 500)
      throw new ApiError(
        422,
        'EXAMPLE_LIMIT',
        'This import exceeds the workspace limit of 500 historical projects.',
      );
    const exampleIds: string[] = [],
      jobNoteIds: string[] = [];
    for (const { example: project, sourceProjectId } of numeric) {
      const exampleId = randomUUID();
      await mutate(
        'INSERT INTO examples (id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source,inputs_json,unit_label,source_import_id,source_project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          exampleId,
          businessId,
          row.service_id,
          project.title,
          project.description,
          project.quantity,
          project.finalPriceCents,
          project.rationale,
          'historical',
          JSON.stringify(project.inputs ?? {}),
          project.unitLabel,
          id,
          sourceProjectId,
        ],
        connection,
      );
      exampleIds.push(exampleId);
    }
    for (const project of projects.filter((item) => item.saveAsNote)) {
      const noteId = randomUUID();
      await mutate(
        'INSERT INTO owner_case_notes (id,business_id,service_id,import_draft_id,source_project_id,reviewed_json) VALUES (?,?,?,?,?,?)',
        [noteId, businessId, row.service_id, id, project.projectId, JSON.stringify(project)],
        connection,
      );
      jobNoteIds.push(noteId);
    }
    const receipt = {
      imported: exampleIds.length,
      notesSaved: jobNoteIds.length,
      exampleIds,
      jobNoteIds,
    };
    await invalidateAutomaticReadiness(businessId, row.service_id, connection);
    await mutate(
      "UPDATE import_drafts SET status='confirmed',confirmed_at=UTC_TIMESTAMP(3),confirmation_hash=?,confirmation_result_json=? WHERE business_id=? AND id=?",
      [fingerprint, JSON.stringify(receipt), businessId, id],
      connection,
    );
    return {
      ...receipt,
      alreadyConfirmed: false,
      draft: draft({
        ...row,
        status: 'confirmed',
        confirmation_hash: fingerprint,
        confirmation_result_json: receipt,
      }),
    };
  });
  res.json(ok(result));
});
