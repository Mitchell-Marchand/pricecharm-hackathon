import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { devTokensAllowed } from './config.js';
import { hashToken, newToken } from './auth.js';
import { mutate, rows, transaction, type Sql } from './db.js';
import {
  idSchema,
  publicService,
  requiresPricingQuantity,
  calculatePrice,
  inquirySchema,
  requiredFields,
  assessEligibility,
  normalizeFact,
  EVALUATOR_VERSION,
  classifierSignature,
  type Quote,
  type Service,
  type Business,
  type InquiryAssessment,
} from './domain.js';
import { ApiError, ok, rateLimit } from './http.js';
import {
  addMessage,
  getMessages,
  iso,
  json,
  mapBusiness,
  mapQuote,
  mapService,
  serviceById,
  latestEvaluation,
  type Row,
} from './models.js';
import { aiMode, aiProvider, analyzeInquiry, type InquiryAnalysis } from './ai/index.js';
import { withAiUsage } from './usage.js';
import { loadConversationImages } from './uploads.js';
import {
  requestContactVerification,
  verifyContactVerification,
  isContactVerified,
} from './verification.js';
import { assertBillingAccess } from './billing.js';
import { recordQuoteDelivery } from './integrations/billing.js';
import { queueQuoteNotification } from './notifications.js';
import { mapQuoteWithSubmittedIntake } from './quote-intake.js';

const slugSchema = z.string().regex(/^[a-z0-9-]{1,180}$/);
type StoredAnalysis = InquiryAssessment & {
  source: string;
  serviceVersion: number;
  analyzedAt: string;
};
async function publicBusiness(slug: unknown, connection?: Sql) {
  const [row] = await rows(
    'SELECT * FROM businesses WHERE slug = ? AND deletion_requested_at IS NULL',
    [slugSchema.parse(slug)],
    connection,
  );
  if (!row) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This quote page is unavailable.');
  return mapBusiness(row);
}
export async function publicAccess(req: Request, connection?: Sql, lock = false) {
  let business = await publicBusiness(req.params.slug, connection);
  if (lock) {
    const [current] = await rows(
      'SELECT * FROM businesses WHERE id = ? AND deletion_requested_at IS NULL FOR UPDATE',
      [business.id],
      connection,
    );
    if (!current) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'This quote page is unavailable.');
    business = mapBusiness(current);
  }
  const id = idSchema.parse(req.params.id);
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) throw new ApiError(401, 'SESSION_REQUIRED', 'A valid inquiry session is required.');
  const tokenHash = hashToken(token);
  const [session] = await rows(
    `SELECT *,CASE WHEN token_hash=? AND expires_at>UTC_TIMESTAMP(3) THEN expires_at ELSE email_token_expires_at END AS access_expires_at FROM public_sessions WHERE business_id = ? AND id = ? AND status<>'expired' AND ((token_hash = ? AND expires_at>UTC_TIMESTAMP(3)) OR (email_token_hash = ? AND email_token_expires_at > UTC_TIMESTAMP(3)))${lock ? ' FOR UPDATE' : ''}`,
    [tokenHash, business.id, id, tokenHash, tokenHash],
    connection,
  );
  if (!session)
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'This inquiry is unavailable or has expired.');
  const service = await serviceById(business.id, session.service_id, connection, lock);
  return { business, service, session };
}
function accessExpiry(session: Row) {
  return iso(session.access_expires_at || session.expires_at);
}
function customerQuote(quote: Quote, privateCalculation = false): Quote {
  if (privateCalculation) return quote;
  const { reviewReason: _privateReason, ...safeQuote } = quote;
  if (quote.status !== 'review') return safeQuote;
  return {
    ...safeQuote,
    totalCents: 0,
    lineItems: [],
    assumptions: [
      'The business owner is reviewing your project. A price will appear after approval.',
    ],
  };
}
function customerQuoteFromRow(row: Row, overrides: Partial<Quote> = {}) {
  const quote = row.source === 'live' ? mapQuoteWithSubmittedIntake(row) : mapQuote(row);
  return customerQuote({ ...quote, ...overrides }, row.source === 'playground');
}
async function sessionResponse(
  business: Business,
  service: Service,
  session: Row,
  connection?: Sql,
) {
  const [row] = await rows(
    'SELECT * FROM quotes WHERE business_id = ? AND public_session_id = ?',
    [business.id, session.id],
    connection,
  );
  const collectedInputs = json<Record<string, string>>(session.facts_json, {});
  const keys = new Map(
    Object.entries(collectedInputs).map(([key, value]) => [normalizeFact(key), value]),
  );
  const missingInputs = requiredFields(service, business).filter(
    (field) => !keys.get(normalizeFact(field)),
  );
  const verified =
    session.source === 'playground' ||
    Boolean(
      session.verified_email &&
      (await isContactVerified(business.id, session.id, session.verified_email, connection)),
    );
  const analysis = json<StoredAnalysis | null>(session.analysis_json, null);
  return {
    id: session.id,
    serviceId: session.service_id,
    serviceVersion: Number(session.service_version),
    quoteMode: service.mode,
    pricingQuantityRequired: requiresPricingQuantity(service),
    requiredInputs: requiredFields(service, business),
    expiresAt: accessExpiry(session),
    status: session.status,
    source: session.source || 'live',
    humanHandoff: Boolean(session.human_handoff),
    messages: await getMessages(business.id, session.id, 'public', connection),
    collectedInputs,
    missingInputs,
    contact: { verified, ...(verified ? { email: session.verified_email } : {}) },
    ...(session.source === 'playground' && row?.review_reason
      ? { reviewReason: row.review_reason }
      : session.source === 'playground' && analysis?.needsReview
        ? { reviewReason: 'Some project details need owner review.' }
        : {}),
    ...(row ? { quote: customerQuoteFromRow(row) } : {}),
  };
}
function trustedExtractedFacts(
  analysis: InquiryAnalysis,
  customerText: string,
  previous: Record<string, string>,
): Record<string, string> {
  const evidence = ` ${normalizeFact(customerText).replace(/\.(?=\s|$)/g, '')} `,
    result = { ...previous };
  for (const fact of analysis.extractedInputs) {
    const value = normalizeFact(fact.value).replace(/\.(?=\s|$)/g, '');
    if (value && evidence.includes(` ${value} `)) result[fact.name] = fact.value;
  }
  return result;
}
export async function createPlaygroundSession(business: Business, service: Service) {
  const token = newToken(),
    id = randomUUID();
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [business.id], connection);
    await mutate(
      'INSERT INTO public_sessions (id,business_id,service_id,service_version,token_hash,expires_at,facts_json,source) VALUES (?,?,?,?,?,?,?,?)',
      [
        id,
        business.id,
        service.id,
        service.version,
        hashToken(token),
        new Date(Date.now() + 24 * 60 * 60_000),
        '{}',
        'playground',
      ],
      connection,
    );
    await addMessage(
      business.id,
      id,
      'public',
      'assistant',
      `${aiMode === 'demo' ? '[Demo assistant] ' : ''}Describe a ${service.name.toLowerCase()} project as a customer would.`,
      connection,
    );
  });
  const [session] = await rows('SELECT * FROM public_sessions WHERE business_id = ? AND id = ?', [
    business.id,
    id,
  ]);
  return { token, session: await sessionResponse(business, service, session) };
}
export const publicRouter = Router();
publicRouter.use(rateLimit(120, 60_000));
publicRouter.get('/:slug', async (req, res) => {
  const business = await publicBusiness(req.params.slug);
  const services = (
    await rows(
      'SELECT * FROM services WHERE business_id = ? AND published_at IS NOT NULL ORDER BY name',
      [business.id],
    )
  )
    .map(mapService)
    .map((service) => ({
      ...publicService(service),
      requiredInputs: requiredFields(service, business),
    }));
  res.json(
    ok({
      business: {
        name: business.name,
        slug: business.slug,
        description: business.description,
        serviceArea: business.serviceArea,
        currency: business.currency,
      },
      services,
    }),
  );
});
publicRouter.post('/:slug/sessions', rateLimit(20, 60_000), async (req, res) => {
  const business = await publicBusiness(req.params.slug),
    { serviceId } = z.object({ serviceId: idSchema }).strict().parse(req.body);
  const token = newToken(),
    id = randomUUID();
  const service = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id = ? FOR UPDATE', [business.id], connection);
    const service = await serviceById(business.id, serviceId, connection, true);
    if (!service.publishedAt)
      throw new ApiError(
        404,
        'SERVICE_UNAVAILABLE',
        'This service is not accepting quote requests.',
      );
    await mutate(
      'INSERT INTO public_sessions (id,business_id,service_id,service_version,token_hash,expires_at,facts_json) VALUES (?,?,?,?,?,?,?)',
      [
        id,
        business.id,
        serviceId,
        service.version,
        hashToken(token),
        new Date(Date.now() + 7 * 24 * 60 * 60_000),
        '{}',
      ],
      connection,
    );
    await addMessage(
      business.id,
      id,
      'public',
      'assistant',
      `${aiMode === 'demo' ? '[Demo assistant] ' : ''}Tell us about your ${service.name.toLowerCase()} project. ${service.mode === 'review' ? 'The business owner will review the details and prepare your quote.' : 'We’ll ask for the details needed to prepare your quote.'}`,
      connection,
    );
    return service;
  });
  const [session] = await rows('SELECT * FROM public_sessions WHERE business_id = ? AND id = ?', [
    business.id,
    id,
  ]);
  res.status(201).json(ok({ token, session: await sessionResponse(business, service, session) }));
});
publicRouter.get('/:slug/sessions/:id', async (req, res) => {
  const access = await publicAccess(req);
  res.json(ok(await sessionResponse(access.business, access.service, access.session)));
});
publicRouter.post(
  '/:slug/sessions/:id/verification',
  rateLimit(8, 15 * 60_000),
  async (req, res) => {
    const access = await publicAccess(req),
      { email } = z
        .object({
          email: z
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
        })
        .strict()
        .parse(req.body);
    if (access.session.source === 'playground')
      throw new ApiError(
        409,
        'PLAYGROUND_CONTACT',
        'Private owner tests do not send contact verification emails.',
      );
    if (!['active', 'submitted'].includes(access.session.status))
      throw new ApiError(
        409,
        'SESSION_CLOSED',
        'This request no longer needs contact verification.',
      );
    res.json(
      ok(
        await requestContactVerification({
          businessId: access.business.id,
          sessionId: access.session.id,
          email,
          ip: req.ip,
          exposeCode: devTokensAllowed(req),
        }),
      ),
    );
  },
);
publicRouter.post(
  '/:slug/sessions/:id/verify-contact',
  rateLimit(15, 15 * 60_000),
  async (req, res) => {
    const access = await publicAccess(req),
      input = z
        .object({ verificationId: idSchema, code: z.string().trim().min(4).max(12) })
        .strict()
        .parse(req.body);
    if (access.session.source === 'playground')
      throw new ApiError(
        409,
        'PLAYGROUND_CONTACT',
        'Private owner tests do not need contact verification.',
      );
    res.json(
      ok(
        await verifyContactVerification({
          businessId: access.business.id,
          sessionId: access.session.id,
          ...input,
        }),
      ),
    );
  },
);
publicRouter.post('/:slug/sessions/:id/messages', rateLimit(40, 60_000), async (req, res) => {
  const access = await publicAccess(req),
    { content } = z
      .object({ content: z.string().trim().min(1).max(5000) })
      .strict()
      .parse(req.body);
  if (['accepted', 'declined'].includes(access.session.status))
    throw new ApiError(
      409,
      'SESSION_CLOSED',
      'This quote decision is complete. Start a new inquiry for another project.',
    );
  const messages = await getMessages(access.business.id, access.session.id, 'public');
  if (messages.length >= 160)
    throw new ApiError(422, 'CONVERSATION_LIMIT', 'This conversation reached its message limit.');
  let analysis: InquiryAnalysis | undefined;
  if (access.session.status === 'active' && !access.session.human_handoff) {
    const images = await loadConversationImages(access.business.id, access.session.id);
    analysis = await withAiUsage(access.business.id, access.session.id, () =>
      analyzeInquiry({
        business: access.business,
        service: {
          ...access.service,
          requiredInputs: requiredFields(access.service, access.business),
        },
        messages,
        content,
        images,
        knownInputs: json<Record<string, string>>(access.session.facts_json, {}),
        experience: {
          privatePreview: access.session.source === 'playground',
          requestSubmitted: access.session.status !== 'active',
          expiresAt: accessExpiry(access.session),
        },
      }),
    );
  }
  await transaction(async (connection) => {
    const locked = await publicAccess(req, connection, true),
      current = await getMessages(access.business.id, access.session.id, 'public', connection);
    if (
      current.length !== messages.length ||
      ['accepted', 'declined'].includes(locked.session.status)
    )
      throw new ApiError(
        409,
        'CONVERSATION_CHANGED',
        'This conversation changed. Refresh before sending again.',
      );
    await addMessage(access.business.id, access.session.id, 'public', 'user', content, connection);
    if (locked.session.human_handoff || locked.session.status !== 'active') {
      const [quote] = await rows(
        'SELECT id FROM quotes WHERE business_id = ? AND public_session_id = ?',
        [access.business.id, access.session.id],
        connection,
      );
      if (quote)
        await queueQuoteNotification(access.business.id, quote.id, 'customer_message', connection);
    }
    if (analysis && locked.session.status === 'active' && !locked.session.human_handoff) {
      const facts = trustedExtractedFacts(
        analysis,
        [
          ...messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content),
          content,
        ].join('\n'),
        json(locked.session.facts_json, {}),
      );
      const stored: StoredAnalysis = {
        needsReview: analysis.needsReview,
        missingInputs: analysis.missingInputs,
        reviewReason: analysis.reviewReason,
        serviceVersion: locked.service.version,
        source: 'server_ai',
        analyzedAt: new Date().toISOString(),
      };
      await mutate(
        'UPDATE public_sessions SET facts_json = ?, analysis_json = ?, analysis_version = analysis_version + 1 WHERE business_id = ? AND id = ?',
        [JSON.stringify(facts), JSON.stringify(stored), access.business.id, access.session.id],
        connection,
      );
      await addMessage(
        access.business.id,
        access.session.id,
        'public',
        'assistant',
        analysis.reply,
        connection,
      );
    }
  });
  const updated = await publicAccess(req);
  res.json(
    ok({ session: await sessionResponse(updated.business, updated.service, updated.session) }),
  );
});
publicRouter.post('/:slug/sessions/:id/quote', async (req, res) => {
  const input = inquirySchema.parse(req.body),
    initial = await publicAccess(req);
  const [prior] = await rows(
    'SELECT * FROM quotes WHERE business_id = ? AND public_session_id = ?',
    [initial.business.id, initial.session.id],
  );
  if (prior) {
    res.json(ok(customerQuoteFromRow(prior)));
    return;
  }
  const requestId = randomUUID();
  const lease = await mutate(
    "UPDATE public_sessions SET quote_request_id = ?, quote_processing_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 90 SECOND) WHERE business_id = ? AND id = ? AND status = 'active' AND (quote_processing_until IS NULL OR quote_processing_until < UTC_TIMESTAMP(3))",
    [requestId, initial.business.id, initial.session.id],
  );
  if (!lease.affectedRows) {
    const [completed] = await rows(
      'SELECT * FROM quotes WHERE business_id = ? AND public_session_id = ?',
      [initial.business.id, initial.session.id],
    );
    if (completed) {
      res.json(ok(customerQuoteFromRow(completed)));
      return;
    }
    throw new ApiError(
      409,
      'QUOTE_PROCESSING',
      'This request is being prepared. Please check the conversation in a moment.',
    );
  }
  try {
    const initialFacts = {
      ...json<Record<string, string>>(initial.session.facts_json, {}),
      ...input.inputs,
    };
    let assessment: StoredAnalysis = {
      source: 'server_fallback',
      serviceVersion: initial.service.version,
      analyzedAt: new Date().toISOString(),
      needsReview: true,
      missingInputs: [],
      reviewReason: 'This request needs owner review.',
    };
    const initiallyVerified =
      initial.session.source === 'playground' ||
      (await isContactVerified(initial.business.id, initial.session.id, input.customerEmail));
    let deterministicEligible = false;
    try {
      deterministicEligible = assessEligibility(initial.service, initial.business, {
        ...input,
        inputs: initialFacts,
      }).eligible;
    } catch {
      /* A custom amount always goes to the owner. */
    }
    if (
      initiallyVerified &&
      deterministicEligible &&
      (initial.session.source === 'playground' ||
        (initial.service.mode === 'automatic' && initial.business.autoQuoteEnabled)) &&
      !input.quantityUnknown &&
      !initial.session.human_handoff
    ) {
      try {
        const images = await loadConversationImages(initial.business.id, initial.session.id);
        const messages = await getMessages(initial.business.id, initial.session.id, 'public');
        const analysis = await withAiUsage(initial.business.id, initial.session.id, () =>
          analyzeInquiry({
            business: initial.business,
            service: {
              ...initial.service,
              requiredInputs: requiredFields(initial.service, initial.business),
            },
            messages,
            content: `Customer-confirmed project details: ${JSON.stringify({ description: input.description, quantity: input.quantity, inputs: initialFacts })}`,
            knownInputs: initialFacts,
            experience: {
              privatePreview: initial.session.source === 'playground',
              requestSubmitted: false,
              expiresAt: accessExpiry(initial.session),
            },
            images,
          }),
        );
        assessment = {
          source: 'server_ai',
          serviceVersion: initial.service.version,
          analyzedAt: new Date().toISOString(),
          needsReview: analysis.needsReview,
          reviewReason: analysis.reviewReason,
          missingInputs: analysis.missingInputs,
        };
      } catch {
        /* Provider and spend limits produce a durable owner handoff, never a guessed price. */
      }
    }
    const quote = await transaction(async (connection) => {
      await rows(
        'SELECT id FROM businesses WHERE id = ? FOR UPDATE',
        [initial.business.id],
        connection,
      );
      const access = await publicAccess(req, connection, true);
      const [existing] = await rows(
        'SELECT * FROM quotes WHERE business_id = ? AND public_session_id = ?',
        [access.business.id, access.session.id],
        connection,
      );
      if (existing) return customerQuoteFromRow(existing);
      if (access.session.quote_request_id !== requestId)
        throw new ApiError(
          409,
          'QUOTE_PROCESSING',
          'This request is being prepared. Please refresh the conversation.',
        );
      if (access.session.status !== 'active')
        throw new ApiError(409, 'SESSION_CLOSED', 'This inquiry is already submitted.');
      const facts = {
        ...json<Record<string, string>>(access.session.facts_json, {}),
        ...input.inputs,
      };
      let eligibility: ReturnType<typeof assessEligibility>,
        manualPriceRequired = input.quantityUnknown;
      try {
        eligibility = assessEligibility(access.service, access.business, {
          ...input,
          inputs: facts,
          analysis: assessment,
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        manualPriceRequired = true;
        eligibility = {
          eligible: false,
          missingInputs: [],
          reasons: ['The project requires a custom price from the business owner.'],
          calculated: calculatePrice(
            {
              ...access.service,
              unitPriceCents: 0,
              basePriceCents: 0,
              minimumChargeCents: 0,
              pricingRules: [],
            },
            input.quantity,
            {},
          ),
        };
      }
      const evaluation = await latestEvaluation(
        access.business.id,
        access.service.id,
        access.service.version,
        connection,
      );
      const playground = access.session.source === 'playground';
      const verified =
        playground ||
        (await isContactVerified(
          access.business.id,
          access.session.id,
          input.customerEmail,
          connection,
        ));
      const reasons = [...eligibility.reasons];
      if (manualPriceRequired)
        reasons.push('The owner needs to confirm the project quantity and final price.');
      if (
        !playground &&
        (access.service.mode !== 'automatic' ||
          !access.business.autoQuoteEnabled ||
          !access.service.publishedAt)
      )
        reasons.push('The business owner will review this request.');
      if (
        (!playground && access.service.approvedVersion !== access.service.version) ||
        access.session.service_version !== access.service.version ||
        assessment.serviceVersion !== access.service.version ||
        !evaluation?.automaticReady ||
        !evaluation.languageEvaluation?.passed ||
        evaluation.languageEvaluation.provider !== aiProvider ||
        evaluation.languageEvaluation.model !== classifierSignature(aiProvider).model ||
        evaluation.engineVersion !== EVALUATOR_VERSION
      )
        reasons.push('The owner needs to review this request against the current pricing policy.');
      if (!verified) reasons.push('The owner needs to confirm the customer contact details.');
      if (access.session.human_handoff)
        reasons.push('The business owner is handling this conversation.');
      let automatic = reasons.length === 0;
      if (automatic && !playground) {
        const billing = await assertBillingAccess(
          access.business.id,
          connection,
          eligibility.calculated.totalCents,
        );
        if (!billing.canIssue) {
          reasons.push('The business owner will review and issue this quote.');
          automatic = false;
        }
      }
      const id = randomUUID(),
        status = automatic ? 'issued' : 'review',
        totalCents = manualPriceRequired ? 0 : eligibility.calculated.totalCents;
      const assumptions = [
        automatic
          ? 'Calculated using the business owner’s approved pricing policy and your confirmed project details.'
          : 'Owner approval is required before this price is issued.',
        'Scope is limited to the supplied project details. Changes may require a new quote.',
        ...access.service.exclusions.map((item) => `Excluded: ${item}`),
      ];
      await mutate(
        'INSERT INTO quotes (id,business_id,service_id,public_session_id,service_version,customer_name,customer_email,status,description,quantity,total_cents,currency,assumptions_json,line_items_json,calculation_json,source,verified_contact,review_reason,issued_by,approved_at,automation_json,manual_price_required) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          access.business.id,
          access.service.id,
          access.session.id,
          access.service.version,
          input.customerName,
          input.customerEmail,
          status,
          input.description,
          input.quantity,
          totalCents,
          access.business.currency,
          JSON.stringify(
            playground
              ? ['Private owner test. No customer notification or delivery fee.', ...assumptions]
              : assumptions,
          ),
          JSON.stringify(manualPriceRequired ? [] : eligibility.calculated.lineItems),
          JSON.stringify({
            ...eligibility.calculated.calculation,
            quantityUnknown: input.quantityUnknown,
            manualPriceRequired,
            inputs: facts,
          }),
          playground ? 'playground' : 'live',
          verified,
          automatic ? null : [...new Set(reasons)].join(' ').slice(0, 1000),
          automatic ? 'automatic' : null,
          automatic ? new Date() : null,
          JSON.stringify({
            assessment,
            evaluationId: evaluation?.id,
            serviceVersion: access.service.version,
            eligibilityReasons: reasons,
            verifiedContact: verified,
          }),
          manualPriceRequired,
        ],
        connection,
      );
      await mutate(
        'UPDATE public_sessions SET status = ?, contact_consent_at = NOW(3), facts_json = ?, analysis_json = ?, analysis_version = analysis_version + 1, human_handoff = ? WHERE business_id = ? AND id = ?',
        [
          automatic ? 'issued' : 'submitted',
          JSON.stringify(facts),
          JSON.stringify(assessment),
          !automatic,
          access.business.id,
          access.session.id,
        ],
        connection,
      );
      if (automatic && !playground)
        await recordQuoteDelivery(connection, {
          businessId: access.business.id,
          quoteId: id,
          totalCents,
          currency: access.business.currency,
          source: 'automatic',
          verifiedContact: verified,
        });
      if (!playground)
        await queueQuoteNotification(
          access.business.id,
          id,
          automatic ? 'issued' : 'review_requested',
          connection,
        );
      const receiptAfterMessageId = await addMessage(
        access.business.id,
        access.session.id,
        'public',
        'assistant',
        playground
          ? 'Your private customer test is ready below. No customer request or notification was sent.'
          : automatic
            ? 'Your quote is ready below. Review the scope and price, then accept or decline.'
            : 'Your request has been sent to the business owner for review. You can continue this conversation to clarify the project.',
        connection,
      );
      if (!playground)
        await mutate(
          "UPDATE quotes SET calculation_json=JSON_SET(calculation_json,'$.receiptAfterMessageId',?) WHERE business_id=? AND id=?",
          [receiptAfterMessageId, access.business.id, id],
          connection,
        );
      const [saved] = await rows(
        'SELECT * FROM quotes WHERE business_id = ? AND id = ?',
        [access.business.id, id],
        connection,
      );
      return customerQuoteFromRow(saved);
    });
    res.status(201).json(ok(quote));
  } finally {
    await mutate(
      'UPDATE public_sessions SET quote_request_id = NULL, quote_processing_until = NULL WHERE business_id = ? AND id = ? AND quote_request_id = ?',
      [initial.business.id, initial.session.id, requestId],
    );
  }
});
publicRouter.post('/:slug/sessions/:id/decision', async (req, res) => {
  const { decision } = z
    .object({ decision: z.enum(['accepted', 'declined']) })
    .strict()
    .parse(req.body);
  const quote = await transaction(async (connection) => {
    const access = await publicAccess(req, connection, true);
    const [row] = await rows(
      'SELECT * FROM quotes WHERE business_id = ? AND public_session_id = ? FOR UPDATE',
      [access.business.id, access.session.id],
      connection,
    );
    if (!row) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
    if (row.status === decision) return customerQuoteFromRow(row);
    if (row.status !== 'issued')
      throw new ApiError(
        409,
        'QUOTE_NOT_ISSUED',
        'Only an issued quote can be accepted or declined.',
      );
    await mutate(
      'UPDATE quotes SET status = ?, decision_at = NOW(3) WHERE business_id = ? AND id = ?',
      [decision, access.business.id, row.id],
      connection,
    );
    await mutate(
      'UPDATE public_sessions SET status = ? WHERE business_id = ? AND id = ?',
      [decision, access.business.id, access.session.id],
      connection,
    );
    await mutate(
      'INSERT INTO usage_events (id,business_id,kind,quote_id,metadata_json) VALUES (?,?,?,?,?)',
      [
        randomUUID(),
        access.business.id,
        'quote_decided',
        row.id,
        JSON.stringify({ decision, billable: false }),
      ],
      connection,
    );
    await addMessage(
      access.business.id,
      access.session.id,
      'public',
      'assistant',
      decision === 'accepted'
        ? 'You accepted the quote. The business can follow up to confirm scheduling and next steps.'
        : 'You declined the quote. Thank you for letting the business know.',
      connection,
    );
    return customerQuoteFromRow(row, { status: decision, decisionAt: new Date().toISOString() });
  });
  res.json(ok(quote));
});
