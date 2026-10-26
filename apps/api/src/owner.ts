import { randomUUID, createHash } from 'node:crypto';
import { Router } from 'express';
import { jobNotesForBusiness } from './job-notes.js';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import {
  businessPatchSchema,
  serviceCreateSchema,
  servicePatchSchema,
  exampleSchema,
  idSchema,
  evaluateService,
  playgroundSchema,
  calculatePrice,
  cents,
  testCaseSchema,
  normalizeFact,
  assessEligibility,
  requiredFields,
  classifierSignature,
  type Quote,
} from './domain.js';
import { ApiError, ok } from './http.js';
import {
  businessById,
  serviceById,
  servicesForBusiness,
  examplesForBusiness,
  trainingForBusiness,
  quotesForBusiness,
  mapQuote,
  latestEvaluation,
  latestServiceEvaluation,
  invalidateAutomaticReadiness,
  testCasesForService,
  addMessage,
  getMessages,
} from './models.js';
import { aiMode, aiProvider, analyzeInquiry } from './ai/index.js';
import { getUsage, withAiUsage } from './usage.js';
import { recordQuoteDelivery } from './integrations/billing.js';
import { queueQuoteNotification } from './notifications.js';
import { createPlaygroundSession } from './public.js';
import { isContactVerified } from './verification.js';
import { automationReadiness, evaluationInvalidation } from './readiness.js';
import { quoteInboxPage } from './quote-inbox.js';
import { serviceAreaSuggestions } from './service-area.js';
import { mapQuoteWithSubmittedIntake } from './quote-intake.js';

async function lockLiveQuote(businessId: string, id: string, connection: Sql) {
  await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
  const [locator] = await rows(
    "SELECT public_session_id FROM quotes WHERE business_id = ? AND id = ? AND source = 'live'",
    [businessId, id],
    connection,
  );
  if (locator?.public_session_id)
    await rows(
      'SELECT id FROM public_sessions WHERE business_id = ? AND id = ? FOR UPDATE',
      [businessId, locator.public_session_id],
      connection,
    );
  const [quote] = await rows(
    "SELECT * FROM quotes WHERE business_id = ? AND id = ? AND source = 'live' FOR UPDATE",
    [businessId, id],
    connection,
  );
  return quote;
}

export const ownerRouter = Router();
ownerRouter.get('/dashboard', async (req, res) => {
  const { businessId } = owner(req);
  const [business, services, examples, trainingSessions, recentQuotes, usage, totals, jobNotes] =
    await Promise.all([
      businessById(businessId),
      servicesForBusiness(businessId),
      examplesForBusiness(businessId),
      trainingForBusiness(businessId),
      quotesForBusiness(businessId),
      getUsage(businessId),
      rows(
        "SELECT COUNT(*) total, SUM(status = 'issued') issued, SUM(status = 'review') review, SUM(CASE WHEN status IN ('issued','accepted') THEN total_cents ELSE 0 END) value_cents FROM quotes WHERE business_id = ? AND source = 'live'",
        [businessId],
      ),
      jobNotesForBusiness(businessId),
    ]);
  const [completed] = await rows(
    "SELECT COUNT(*) count FROM training_sessions WHERE business_id = ? AND status = 'completed'",
    [businessId],
  );
  const areaSuggestions = await serviceAreaSuggestions(
    businessId,
    services.map((service) => service.id),
    business.serviceArea,
  );
  res.json(
    ok({
      business,
      services,
      examples,
      jobNotes,
      serviceAreaSuggestions: areaSuggestions,
      trainingSessions,
      recentQuotes: recentQuotes.slice(0, 10),
      usage,
      stats: {
        totalQuotes: Number(totals[0]?.total || 0),
        issuedQuotes: Number(totals[0]?.issued || 0),
        reviewQuotes: Number(totals[0]?.review || 0),
        trainingCompleted: Number(completed.count || 0),
        examplesCount: examples.length,
        quotedValueCents: Number(totals[0]?.value_cents || 0),
      },
    }),
  );
});
ownerRouter.get('/business', async (req, res) => {
  res.json(ok(await businessById(owner(req).businessId)));
});
ownerRouter.patch('/business', async (req, res) => {
  const { businessId } = owner(req);
  const input = businessPatchSchema.parse(req.body);
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const prior = await businessById(businessId, connection);
    const next = { ...prior, ...input };
    if (input.autoQuoteEnabled) {
      const [account] = await rows(
        'SELECT email_verified_at FROM users WHERE id = ? AND business_id = ?',
        [owner(req).userId, businessId],
        connection,
      );
      if (!account?.email_verified_at)
        throw new ApiError(
          409,
          'OWNER_EMAIL_UNVERIFIED',
          'Verify your account email before enabling automatic quotes.',
        );
    }
    await mutate(
      'UPDATE businesses SET name = ?, industry = ?, description = ?, service_area = ?, currency = ?, onboarding_complete = ?, auto_quote_enabled = ? WHERE id = ?',
      [
        next.name,
        next.industry,
        next.description,
        next.serviceArea,
        next.currency,
        next.onboardingComplete,
        next.autoQuoteEnabled,
        businessId,
      ],
      connection,
    );
    if (
      (input.description !== undefined && input.description !== prior.description) ||
      (input.serviceArea !== undefined && input.serviceArea !== prior.serviceArea) ||
      (input.industry !== undefined && input.industry !== prior.industry)
    ) {
      await mutate(
        'UPDATE services SET version = version + 1, published_at = NULL, approved_version = NULL, approved_at = NULL, approved_evaluation_id = NULL WHERE business_id = ?',
        [businessId],
        connection,
      );
    }
  });
  res.json(ok(await businessById(businessId)));
});
ownerRouter.get('/services', async (req, res) => {
  res.json(ok(await servicesForBusiness(owner(req).businessId)));
});
ownerRouter.get('/services/:id/readiness', async (req, res) => {
  const { businessId } = owner(req),
    id = idSchema.parse(req.params.id);
  const result = await transaction(async (connection) => {
    const service = await serviceById(businessId, id, connection),
      business = await businessById(businessId, connection),
      evaluation = await latestServiceEvaluation(businessId, id, connection);
    return automationReadiness(service, business, evaluation, classifierSignature(aiProvider));
  });
  res.json(ok(result));
});
ownerRouter.post('/services', async (req, res) => {
  const { businessId } = owner(req);
  const input = serviceCreateSchema.parse(req.body);
  if (input.mode === 'automatic')
    throw new ApiError(
      409,
      'PUBLISH_APPROVAL_REQUIRED',
      'Create the service, evaluate independent cases, then approve automatic publishing.',
    );
  const [count] = await rows('SELECT COUNT(*) count FROM services WHERE business_id = ?', [
    businessId,
  ]);
  if (Number(count.count) >= 50)
    throw new ApiError(422, 'SERVICE_LIMIT', 'A business can have up to 50 services.');
  const id = randomUUID();
  await mutate(
    'INSERT INTO services (id, business_id, name, description, unit_label, unit_price_cents, minimum_charge_cents, base_price_cents, max_auto_quote_cents, required_inputs_json, exclusions_json, pricing_rules_json, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      businessId,
      input.name,
      input.description,
      input.unitLabel,
      input.unitPriceCents,
      input.minimumChargeCents,
      input.basePriceCents,
      input.maxAutoQuoteCents,
      JSON.stringify(input.requiredInputs),
      JSON.stringify(input.exclusions),
      JSON.stringify(input.pricingRules),
      input.mode,
    ],
  );
  res.status(201).json(ok(await serviceById(businessId, id)));
});
ownerRouter.patch('/services/:id', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const { expectedVersion, ...input } = servicePatchSchema.parse(req.body);
  if (input.mode === 'automatic')
    throw new ApiError(
      409,
      'PUBLISH_APPROVAL_REQUIRED',
      'Use the publish action to approve the current service version for automatic quotes.',
    );
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const prior = await serviceById(businessId, id, connection, true);
    if (expectedVersion !== undefined && prior.version !== expectedVersion)
      throw new ApiError(
        409,
        'SERVICE_VERSION_CONFLICT',
        'This service changed after the proposal was created. Review the current pricing before applying changes.',
        { expectedVersion, actualVersion: prior.version },
      );
    if (Object.keys(input).length === 1 && input.maxAutoQuoteCents !== undefined) {
      if (input.maxAutoQuoteCents === prior.maxAutoQuoteCents) return;
      await mutate(
        'UPDATE services SET max_auto_quote_cents = ? WHERE business_id = ? AND id = ?',
        [input.maxAutoQuoteCents, businessId, id],
        connection,
      );
      await invalidateAutomaticReadiness(businessId, id, connection);
      return;
    }
    const next = { ...prior, ...input };
    await mutate(
      'UPDATE services SET name = ?, description = ?, unit_label = ?, unit_price_cents = ?, minimum_charge_cents = ?, base_price_cents = ?, max_auto_quote_cents = ?, required_inputs_json = ?, exclusions_json = ?, pricing_rules_json = ?, mode = ?, version = version + 1, published_at = NULL, approved_version = NULL, approved_at = NULL, approved_evaluation_id = NULL WHERE business_id = ? AND id = ?',
      [
        next.name,
        next.description,
        next.unitLabel,
        next.unitPriceCents,
        next.minimumChargeCents,
        next.basePriceCents,
        next.maxAutoQuoteCents,
        JSON.stringify(next.requiredInputs),
        JSON.stringify(next.exclusions),
        JSON.stringify(next.pricingRules || []),
        next.mode,
        businessId,
        id,
      ],
      connection,
    );
  });
  res.json(ok(await serviceById(businessId, id)));
});
ownerRouter.get('/services/:id/test-cases', async (req, res) => {
  const { businessId } = owner(req),
    id = idSchema.parse(req.params.id);
  await serviceById(businessId, id);
  res.json(ok(await testCasesForService(businessId, id)));
});
ownerRouter.post('/services/:id/test-cases', async (req, res) => {
  const { businessId } = owner(req),
    serviceId = idSchema.parse(req.params.id),
    input = testCaseSchema.parse(req.body),
    id = randomUUID();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        description: normalizeFact(input.description),
        quantity: input.quantity,
        inputs: Object.entries(input.inputs).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest('hex');
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    await serviceById(businessId, serviceId, connection, true);
    const existing = await testCasesForService(businessId, serviceId, connection);
    if (existing.length >= 100)
      throw new ApiError(
        422,
        'TEST_CASE_LIMIT',
        'Keep up to 100 representative independent cases per service.',
      );
    const teaching = await examplesForBusiness(businessId, serviceId, connection);
    if (
      teaching.some(
        (example) =>
          normalizeFact(example.description) === normalizeFact(input.description) &&
          example.quantity === input.quantity,
      )
    )
      throw new ApiError(
        409,
        'CASE_NOT_INDEPENDENT',
        'Use a different project from your teaching examples for this independent test.',
      );
    await mutate(
      'INSERT INTO service_test_cases (id,business_id,service_id,title,description,quantity,expected_cents,inputs_json,tolerance_cents,tolerance_percent,expected_outcome,case_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        businessId,
        serviceId,
        input.title,
        input.description,
        input.quantity,
        input.expectedCents,
        JSON.stringify(input.inputs),
        input.toleranceCents,
        input.tolerancePercent,
        input.expectedOutcome,
        fingerprint,
      ],
      connection,
    );
    await invalidateAutomaticReadiness(businessId, serviceId, connection);
  });
  res
    .status(201)
    .json(ok((await testCasesForService(businessId, serviceId)).find((item) => item.id === id)));
});
ownerRouter.delete('/services/:id/test-cases/:caseId', async (req, res) => {
  const { businessId } = owner(req),
    serviceId = idSchema.parse(req.params.id),
    id = idSchema.parse(req.params.caseId);
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    await serviceById(businessId, serviceId, connection, true);
    const result = await mutate(
      'DELETE FROM service_test_cases WHERE business_id = ? AND service_id = ? AND id = ?',
      [businessId, serviceId, id],
      connection,
    );
    if (!result.affectedRows)
      throw new ApiError(404, 'TEST_CASE_NOT_FOUND', 'Test case not found.');
    await invalidateAutomaticReadiness(businessId, serviceId, connection);
  });
  res.json(ok({ ok: true }));
});
ownerRouter.post('/services/:id/evaluate', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const service = await serviceById(businessId, id),
    business = await businessById(businessId);
  const independent = await testCasesForService(businessId, id);
  const result = evaluateService(
    service,
    await examplesForBusiness(businessId, id),
    business,
    independent,
  );
  const signature = classifierSignature(aiProvider);
  result.id = randomUUID();
  const representative = [
    ...independent.filter((item) => item.expectedOutcome === 'quote').slice(0, 3),
    ...independent.filter((item) => item.expectedOutcome === 'review').slice(0, 1),
  ];
  let languagePassed = false;
  if (representative.length === 4) {
    const languageCases = await Promise.all(
      representative.map(async (testCase) => {
        const previous = result.cases.find((item) => item.caseId === testCase.id)!;
        try {
          const analysis = await withAiUsage(
            businessId,
            `evaluation:${result.id}:${testCase.id}`,
            () =>
              analyzeInquiry({
                business,
                service: { ...service, requiredInputs: requiredFields(service, business) },
                messages: [],
                content: `Customer-confirmed project details: ${JSON.stringify({ description: testCase.description, quantity: testCase.quantity, inputs: testCase.inputs })}`,
              }),
          );
          const decision = assessEligibility(service, business, { ...testCase, analysis });
          const actualOutcome = decision.eligible ? ('quote' as const) : ('review' as const);
          const tolerance = Math.max(
            testCase.toleranceCents,
            Math.round((testCase.expectedCents * testCase.tolerancePercent) / 100),
          );
          return {
            ...previous,
            actualOutcome,
            actualCents: decision.calculated.totalCents,
            passed:
              actualOutcome === testCase.expectedOutcome &&
              (actualOutcome === 'review' ||
                Math.abs(decision.calculated.totalCents - testCase.expectedCents) <= tolerance),
          };
        } catch {
          return { ...previous, passed: false };
        }
      }),
    );
    languagePassed = aiMode === 'live' && languageCases.every((item) => item.passed);
    result.cases = result.cases.map(
      (item) => languageCases.find((languageCase) => languageCase.caseId === item.caseId) || item,
    );
  }
  result.languageEvaluation = {
    ...signature,
    passed: languagePassed,
    caseCount: representative.length === 4 ? 4 : 0,
  };
  result.automaticReady = Boolean(
    result.configurationPassed &&
    languagePassed &&
    result.cases.filter((item) => item.provenance === 'independent').every((item) => item.passed) &&
    service.maxAutoQuoteCents > 0,
  );
  const independentCheck = result.checks.find((check) => check.name === 'Independent results');
  if (independentCheck)
    independentCheck.passed = Boolean(
      representative.length === 4 &&
      result.cases.filter((item) => item.provenance === 'independent').every((item) => item.passed),
    );
  result.checks.push({
    name: 'Language scope and handoff checks',
    passed: languagePassed,
    detail:
      'The active inquiry model must correctly handle three independent quote cases and one boundary case. Demo responses and provider failures cannot approve automation.',
  });
  result.coverage?.push(
    'The active inquiry model is exercised on three representative quote cases and one boundary case; all independent case prices are calculated deterministically.',
  );
  const evaluation = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const current = await serviceById(businessId, id, connection, true);
    if (current.version !== service.version)
      throw new ApiError(
        409,
        'SERVICE_VERSION_CONFLICT',
        'This service changed during evaluation. Evaluate its current version again.',
      );
    if (classifierSignature(aiProvider).model !== signature.model)
      throw new ApiError(
        409,
        'MODEL_CHANGED',
        'The active inquiry model changed during evaluation. Run the checks again.',
      );
    await mutate(
      'INSERT INTO evaluations (id, business_id, service_id, service_version, passed, result_json) VALUES (?, ?, ?, ?, ?, ?)',
      [result.id!, businessId, id, service.version, result.passed, JSON.stringify(result)],
      connection,
    );
    return result;
  });
  res.json(ok(evaluation));
});
ownerRouter.post('/services/:id/publish', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const { mode, approveAutomatic } = z
    .object({ mode: z.enum(['review', 'automatic']), approveAutomatic: z.boolean().optional() })
    .strict()
    .parse(req.body);
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const service = await serviceById(businessId, id, connection, true);
    const evaluation = await latestEvaluation(businessId, id, service.version, connection);
    if (mode === 'review') {
      const business = await businessById(businessId, connection);
      if (
        !business.description.trim() ||
        !business.serviceArea.trim() ||
        !service.description.trim()
      )
        throw new ApiError(
          409,
          'REVIEW_SCOPE_REQUIRED',
          'Describe your service and where you work before sharing your quote link.',
        );
    }
    if (mode === 'automatic' && !(evaluation?.configurationPassed ?? evaluation?.passed))
      throw new ApiError(
        409,
        'EVALUATION_REQUIRED',
        'Run and pass the current service checks before publishing.',
        evaluation,
      );
    if (mode === 'automatic') {
      const [account] = await rows(
        'SELECT email_verified_at FROM users WHERE id = ? AND business_id = ?',
        [owner(req).userId, businessId],
        connection,
      );
      if (!account?.email_verified_at)
        throw new ApiError(
          409,
          'OWNER_EMAIL_UNVERIFIED',
          'Verify your account email before publishing automatic quotes.',
        );
      if (approveAutomatic !== true)
        throw new ApiError(
          409,
          'EXPLICIT_APPROVAL_REQUIRED',
          'Explicitly approve automatic issuance for this evaluated service version.',
        );
      if (
        !evaluation?.automaticReady ||
        !evaluation.languageEvaluation?.passed ||
        evaluationInvalidation(evaluation, service.version, classifierSignature(aiProvider)) !==
          null
      )
        throw new ApiError(
          409,
          'INDEPENDENT_EVALUATION_REQUIRED',
          'Pass the current independent quote and handoff cases before automatic publishing.',
          evaluation,
        );
    }
    await mutate(
      'UPDATE services SET mode = ?, published_at = NOW(3), approved_version = ?, approved_at = ?, approved_evaluation_id = ? WHERE business_id = ? AND id = ?',
      [
        mode,
        mode === 'automatic' ? service.version : null,
        mode === 'automatic' ? new Date() : null,
        mode === 'automatic' ? evaluation!.id! : null,
        businessId,
        id,
      ],
      connection,
    );
  });
  res.json(ok(await serviceById(businessId, id)));
});
ownerRouter.post('/services/:id/pause', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  await serviceById(businessId, id);
  await mutate(
    'UPDATE services SET published_at = NULL, approved_version = NULL, approved_at = NULL, approved_evaluation_id = NULL WHERE business_id = ? AND id = ?',
    [businessId, id],
  );
  res.json(ok(await serviceById(businessId, id)));
});
ownerRouter.get('/examples', async (req, res) => {
  res.json(ok(await examplesForBusiness(owner(req).businessId)));
});
ownerRouter.post('/examples', async (req, res) => {
  const { businessId } = owner(req);
  const input = exampleSchema.parse(req.body);
  const id = randomUUID();
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const service = await serviceById(businessId, input.serviceId, connection, true);
    const [count] = await rows(
      'SELECT COUNT(*) count FROM examples WHERE business_id = ?',
      [businessId],
      connection,
    );
    if (Number(count.count) >= 500)
      throw new ApiError(
        422,
        'EXAMPLE_LIMIT',
        'The pilot supports up to 500 examples per business.',
      );
    await mutate(
      'INSERT INTO examples (id, business_id, service_id, title, description, quantity, final_price_cents, rationale, source, inputs_json, unit_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        businessId,
        input.serviceId,
        input.title,
        input.description,
        input.quantity,
        input.finalPriceCents,
        input.rationale,
        input.source,
        JSON.stringify(input.inputs),
        input.unitLabel || service.unitLabel,
      ],
      connection,
    );
    await invalidateAutomaticReadiness(businessId, input.serviceId, connection);
  });
  res
    .status(201)
    .json(ok((await examplesForBusiness(businessId)).find((example) => example.id === id)));
});
ownerRouter.delete('/examples/:id', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId], connection);
    const [example] = await rows(
      'SELECT service_id FROM examples WHERE business_id = ? AND id = ? FOR UPDATE',
      [businessId, id],
      connection,
    );
    if (!example) throw new ApiError(404, 'EXAMPLE_NOT_FOUND', 'Example not found.');
    await mutate(
      'DELETE FROM examples WHERE business_id = ? AND id = ?',
      [businessId, id],
      connection,
    );
    await invalidateAutomaticReadiness(businessId, example.service_id, connection);
  });
  res.json(ok({ ok: true }));
});
ownerRouter.get('/quotes', async (req, res) => {
  res.json(ok(await quotesForBusiness(owner(req).businessId)));
});
ownerRouter.get('/quotes/page', async (req, res) => {
  res.json(ok(await quoteInboxPage(owner(req).businessId, req.query)));
});
ownerRouter.get('/quotes/:id', async (req, res) => {
  const businessId = owner(req).businessId,
    id = idSchema.parse(req.params.id);
  const [quote] = await rows(
    "SELECT * FROM quotes WHERE business_id=? AND id=? AND source='live'",
    [businessId, id],
  );
  if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
  res.json(ok(mapQuoteWithSubmittedIntake(quote)));
});
ownerRouter.post('/quotes/:id/messages', async (req, res) => {
  const { businessId } = owner(req),
    id = idSchema.parse(req.params.id);
  const { content } = z
    .object({ content: z.string().trim().min(1).max(5000) })
    .strict()
    .parse(req.body);
  const result = await transaction(async (connection) => {
    const quote = await lockLiveQuote(businessId, id, connection);
    if (!quote?.public_session_id)
      throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote conversation not found.');
    if (!['review', 'issued'].includes(quote.status))
      throw new ApiError(409, 'CONVERSATION_CLOSED', 'This quote conversation is complete.');
    const messages = await getMessages(businessId, quote.public_session_id, 'public', connection);
    if (messages.length >= 160)
      throw new ApiError(422, 'CONVERSATION_LIMIT', 'This conversation reached its message limit.');
    await mutate(
      'UPDATE public_sessions SET human_handoff = TRUE WHERE business_id = ? AND id = ?',
      [businessId, quote.public_session_id],
      connection,
    );
    await addMessage(
      businessId,
      quote.public_session_id,
      'public',
      'assistant',
      content,
      connection,
      true,
    );
    await queueQuoteNotification(businessId, id, 'owner_message', connection);
    return {
      messages: await getMessages(businessId, quote.public_session_id, 'public', connection),
      status: quote.status,
    };
  });
  res.json(ok(result));
});
ownerRouter.patch('/quotes/:id', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const input = z
    .object({ totalCents: cents, reason: z.string().trim().min(1).max(2000) })
    .strict()
    .parse(req.body);
  const quote = await transaction(async (connection) => {
    const row = await lockLiveQuote(businessId, id, connection);
    if (!row) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
    if (row.status !== 'review')
      throw new ApiError(
        409,
        'QUOTE_NOT_REVIEWABLE',
        'Only a quote awaiting owner review can be revised.',
      );
    const prior = mapQuoteWithSubmittedIntake(row);
    // Retried saves of an unchanged total do not create duplicate adjustments or audit events.
    if (prior.totalCents === input.totalCents && !row.manual_price_required) return prior;
    const adjustment = input.totalCents - prior.totalCents;
    const lineItems = [
      ...prior.lineItems,
      {
        description: prior.manualPriceRequired ? 'Project price' : 'Price change',
        quantity: 1,
        unitPriceCents: adjustment,
        totalCents: adjustment,
      },
    ];
    await mutate(
      'UPDATE quotes SET total_cents = ?, line_items_json = ?, manual_price_required = FALSE WHERE business_id = ? AND id = ?',
      [input.totalCents, JSON.stringify(lineItems), businessId, id],
      connection,
    );
    // The initial calculator snapshot remains unchanged; the private audit explains each override.
    await mutate(
      'INSERT INTO usage_events (id, business_id, kind, quote_id, metadata_json) VALUES (?, ?, ?, ?, ?)',
      [
        randomUUID(),
        businessId,
        'quote_revised',
        id,
        JSON.stringify({
          billable: false,
          source: 'owner_review',
          originalTotalCents: prior.totalCents,
          newTotalCents: input.totalCents,
          reason: input.reason,
          userId: owner(req).userId,
        }),
      ],
      connection,
    );
    return { ...prior, totalCents: input.totalCents, lineItems, manualPriceRequired: undefined };
  });
  res.json(ok(quote));
});
ownerRouter.post('/quotes/:id/approve', async (req, res) => {
  const { businessId } = owner(req);
  const id = idSchema.parse(req.params.id);
  const quote = await transaction(async (connection) => {
    const row = await lockLiveQuote(businessId, id, connection);
    if (!row) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
    if (row.status === 'issued') return mapQuoteWithSubmittedIntake(row);
    if (row.status !== 'review')
      throw new ApiError(409, 'QUOTE_NOT_REVIEWABLE', 'This quote can no longer be approved.');
    if (row.manual_price_required)
      throw new ApiError(
        409,
        'PRICE_CONFIRMATION_REQUIRED',
        'Set the final price with a reason before approving this request with an unknown quantity.',
      );
    const assumptions = mapQuote(row).assumptions.filter(
      (item) => item !== 'Owner approval is required before this price is issued.',
    );
    assumptions.push('Reviewed and approved by the business owner.');
    await mutate(
      "UPDATE quotes SET status = 'issued', issued_by = 'owner', review_reason = NULL, verified_contact = ?, assumptions_json = ?, approved_at = NOW(3) WHERE business_id = ? AND id = ?",
      [false, JSON.stringify(assumptions), businessId, id],
      connection,
    );
    await queueQuoteNotification(businessId, id, 'issued', connection);
    const verifiedContact = Boolean(
      row.public_session_id &&
      (await isContactVerified(businessId, row.public_session_id, row.customer_email, connection)),
    );
    await mutate(
      'UPDATE quotes SET verified_contact=? WHERE business_id=? AND id=?',
      [verifiedContact, businessId, id],
      connection,
    );
    await recordQuoteDelivery(connection, {
      businessId,
      quoteId: id,
      totalCents: Number(row.total_cents),
      currency: row.currency,
      source: 'owner_review',
      verifiedContact,
    });
    if (row.public_session_id) {
      await mutate(
        "UPDATE public_sessions SET status = 'issued' WHERE business_id = ? AND id = ?",
        [businessId, row.public_session_id],
        connection,
      );
      await addMessage(
        businessId,
        row.public_session_id,
        'public',
        'assistant',
        `The business owner has approved your quote. Review the scope and price, then accept or decline.`,
        connection,
        true,
      );
    }
    return {
      ...mapQuoteWithSubmittedIntake(row),
      status: 'issued' as const,
      assumptions,
      issuedBy: 'owner' as const,
      reviewReason: undefined,
    };
  });
  res.json(ok(quote));
});
ownerRouter.post('/playground/sessions', async (req, res) => {
  const { businessId } = owner(req),
    { serviceId } = z.object({ serviceId: idSchema }).strict().parse(req.body);
  res
    .status(201)
    .json(
      ok(
        await createPlaygroundSession(
          await businessById(businessId),
          await serviceById(businessId, serviceId),
        ),
      ),
    );
});
ownerRouter.post('/playground', async (req, res) => {
  const { businessId } = owner(req);
  const input = playgroundSchema.parse(req.body);
  const service = await serviceById(businessId, input.serviceId);
  const business = await businessById(businessId);
  const calculated = calculatePrice(service, input.quantity, input.inputs);
  const quote: Quote = {
    id: randomUUID(),
    serviceId: service.id,
    customerName: input.customerName || 'Owner test',
    customerEmail: input.customerEmail || '',
    status: 'review',
    description: input.description,
    quantity: input.quantity,
    totalCents: input.quantityUnknown ? 0 : calculated.totalCents,
    currency: business.currency,
    assumptions: [
      'Owner test only. Never delivered or billed.',
      'Unit quantity and service eligibility require owner confirmation.',
      ...service.exclusions.map((item) => `Excluded: ${item}`),
    ],
    lineItems: input.quantityUnknown ? [] : calculated.lineItems,
    ...(input.quantityUnknown ? { manualPriceRequired: true } : {}),
    createdAt: new Date().toISOString(),
  };
  res.json(
    ok({
      quote,
      calculation: calculated.calculation,
      evaluation: await latestEvaluation(businessId, service.id, service.version),
    }),
  );
});
ownerRouter.get('/usage', async (req, res) => {
  res.json(ok(await getUsage(owner(req).businessId)));
});
ownerRouter.get('/settings', async (_req, res) => {
  res.json(
    ok({
      providers: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      },
      aiMode,
      billingConfigured:
        Boolean(process.env.STRIPE_SECRET_KEY) || process.env.BILLING_PROVIDER === 'local',
      billingNote:
        'Verified automatic quote deliveries use your trial or billing plan. Owner-reviewed requests and tests are nonbillable.',
    }),
  );
});
