import { z } from 'zod';
import {
  applyPricingRules,
  pricingRulesSchema,
  pricingInputsSchema,
  type PricingRule,
} from './rules.js';

export const MAX_CENTS = 100_000_000;
export const cents = z.number().int().min(0).max(MAX_CENTS);
export const quantitySchema = z
  .number()
  .positive()
  .max(10_000_000)
  .refine(
    (value) => Math.abs(Math.round(value * 1000) - value * 1000) < 0.00001,
    'Use at most three decimal places for quantity',
  );
export const idSchema = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
export const serviceCreateSchema = z
  .object({
    name: text(160).min(2),
    description: text(5000).default(''),
    unitLabel: text(60).min(1).default('unit'),
    unitPriceCents: cents.default(0),
    minimumChargeCents: cents.default(0),
    basePriceCents: cents.default(0),
    maxAutoQuoteCents: cents.default(500_000),
    requiredInputs: z.array(text(100).min(1)).max(20).default([]),
    exclusions: z.array(text(300).min(1)).max(30).default([]),
    pricingRules: pricingRulesSchema.default([]),
    mode: z.enum(['review', 'automatic']).default('review'),
  })
  .strict();
// PATCH fields must not inherit create defaults: Zod applies inner defaults even through partial().
export const servicePatchSchema = z
  .object({
    name: text(160).min(2).optional(),
    description: text(5000).optional(),
    unitLabel: text(60).min(1).optional(),
    unitPriceCents: cents.optional(),
    minimumChargeCents: cents.optional(),
    basePriceCents: cents.optional(),
    maxAutoQuoteCents: cents.optional(),
    requiredInputs: z.array(text(100).min(1)).max(20).optional(),
    exclusions: z.array(text(300).min(1)).max(30).optional(),
    pricingRules: pricingRulesSchema.optional(),
    mode: z.enum(['review', 'automatic']).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion'),
    'Provide at least one service field to update.',
  );
export const businessPatchSchema = z
  .object({
    name: text(160).min(2).optional(),
    industry: text(160).optional(),
    description: text(5000).optional(),
    serviceArea: text(500).optional(),
    currency: z.literal('USD').optional(),
    onboardingComplete: z.boolean().optional(),
    autoQuoteEnabled: z.boolean().optional(),
  })
  .strict();
export const exampleSchema = z
  .object({
    serviceId: idSchema,
    title: text(160).min(2),
    description: text(5000).min(1),
    quantity: quantitySchema,
    finalPriceCents: cents,
    rationale: text(5000).min(1),
    source: z.literal('historical').default('historical'),
    unitLabel: text(60).min(1).optional(),
    inputs: pricingInputsSchema.default({}),
  })
  .strict();
export const inquirySchema = z
  .object({
    customerName: text(160).min(1),
    customerEmail: z
      .email()
      .max(254)
      .transform((x) => x.toLowerCase()),
    quantity: quantitySchema,
    description: text(5000).min(3),
    contactConsent: z.literal(true),
    inputs: pricingInputsSchema.default({}),
    quantityUnknown: z.boolean().default(false),
  })
  .strict();
export const playgroundSchema = z
  .object({
    serviceId: idSchema,
    quantity: quantitySchema,
    description: text(5000).min(3),
    customerName: text(160).optional(),
    customerEmail: z.union([z.email().max(254), z.literal('')]).optional(),
    inputs: pricingInputsSchema.default({}),
    quantityUnknown: z.boolean().default(false),
  })
  .strict();

export interface Business {
  id: string;
  name: string;
  slug: string;
  industry: string;
  description: string;
  serviceArea: string;
  currency: string;
  onboardingComplete: boolean;
  autoQuoteEnabled: boolean;
  createdAt: string;
}
export interface Service {
  id: string;
  businessId: string;
  name: string;
  description: string;
  unitLabel: string;
  unitPriceCents: number;
  minimumChargeCents: number;
  basePriceCents: number;
  maxAutoQuoteCents: number;
  requiredInputs: string[];
  exclusions: string[];
  mode: 'review' | 'automatic';
  publishedAt: string | null;
  version: number;
  approvedVersion?: number | null;
  approvedAt?: string | null;
  pricingRules?: PricingRule[];
}
export interface Example {
  id: string;
  businessId: string;
  serviceId: string;
  title: string;
  description: string;
  quantity: number;
  unitLabel?: string;
  finalPriceCents: number;
  rationale: string;
  sourceNotes?: string;
  sourceBasis?: SourceBasis;
  sourceFilename?: string;
  sourceCurrency?: string | null;
  source: 'historical' | 'training';
  createdAt: string;
  inputs?: Record<string, string>;
}
export type SourceBasis = 'exact_owner_text' | 'reviewed_extraction';
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  author?: 'owner' | 'customer' | 'ai';
  photos?: {
    requestId: string;
    status: 'pending' | 'ready' | 'failed';
    error?: string;
    retryable?: boolean;
    attachments: {
      id: string;
      url: string;
      alt: string;
      label: string;
      kind: 'sample_photo';
      width: number;
      height: number;
    }[];
  };
}
export interface JobNote {
  id: string;
  serviceId: string;
  source: 'setup' | 'training' | 'import';
  kind: 'historical_job' | 'inspection_required' | 'practice_quote' | 'service_notes';
  title: string;
  description: string;
  quantity: number | null;
  unitLabel: string | null;
  finalPriceCents: number | null;
  rationale: string;
  sourceNotes: string;
  sourceBasis?: SourceBasis;
  sourceFilename?: string;
  sourceCurrency?: string | null;
  sourcePriceText?: string | null;
  inputs?: Record<string, string>;
  createdAt: string;
}
export interface Scenario {
  title: string;
  customerName: string;
  description: string;
  details: Record<string, string>;
}
export interface TrainingSession {
  id: string;
  serviceId: string;
  savedExampleId?: string | null;
  unitLabel?: string;
  status: 'active' | 'completed';
  outcome?: 'quote' | 'inspection_required';
  scenario: Scenario;
  messages: Message[];
  createdAt: string;
  finalPriceCents?: number | null;
  rationale?: string;
  pricingProposal?: {
    unitPriceCents: number;
    basePriceCents: number;
    minimumChargeCents: number;
    serviceVersion: number;
    explanation: string;
  };
}
export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}
export interface Quote {
  id: string;
  serviceId: string;
  customerName: string;
  customerEmail: string;
  status: 'review' | 'issued' | 'accepted' | 'declined';
  description: string;
  quantity: number;
  totalCents: number;
  currency: string;
  assumptions: string[];
  lineItems: LineItem[];
  createdAt: string;
  reviewReason?: string;
  issuedBy?: 'owner' | 'automatic';
  decisionAt?: string;
  manualPriceRequired?: boolean;
}
export interface Evaluation {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  cases: {
    caseId?: string;
    title: string;
    expectedCents: number;
    actualCents: number;
    passed: boolean;
    expectedOutcome?: 'quote' | 'review';
    actualOutcome?: 'quote' | 'review';
    provenance?: string;
  }[];
  evaluatedAt: string;
  id?: string;
  serviceVersion?: number;
  configurationPassed?: boolean;
  automaticReady?: boolean;
  deterministicReady?: boolean;
  independentCaseCount?: number;
  coverage?: string[];
  engineVersion?: string;
  languageEvaluation?: { provider: string; model: string; passed: boolean; caseCount: number };
}

export const testCaseSchema = z
  .object({
    title: text(160).min(2),
    description: text(5000).min(3),
    quantity: quantitySchema,
    expectedCents: cents,
    inputs: pricingInputsSchema.default({}),
    toleranceCents: cents.max(50_000).default(100),
    tolerancePercent: z.number().min(0).max(20).default(5),
    expectedOutcome: z.enum(['quote', 'review']).default('quote'),
  })
  .strict();
export interface TestCase extends z.infer<typeof testCaseSchema> {
  id: string;
  serviceId: string;
  createdAt: string;
}
export interface InquiryAssessment {
  needsReview: boolean;
  reviewReason: string;
  missingInputs: string[];
  serviceVersion?: number;
  source?: string;
}
export const EVALUATOR_VERSION = 'quotient-pricing-4';
export function classifierSignature(provider: string) {
  return {
    provider,
    model:
      provider === 'openai'
        ? (process.env.OPENAI_MODEL ?? 'gpt-4.1-mini')
        : provider === 'anthropic'
          ? (process.env.ANTHROPIC_MODEL ?? '')
          : 'demo',
  };
}

export function normalizeFact(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim();
}
function normalizedInputs(inputs: Record<string, string>) {
  return new Map(Object.entries(inputs).map(([key, value]) => [normalizeFact(key), value.trim()]));
}
export function requiredFields(service: Service, business: Business): string[] {
  const fields = [
    ...service.requiredInputs,
    ...(service.pricingRules || []).map((rule) => rule.field),
  ];
  if (
    !/^(anywhere|everywhere|remote|online|worldwide|not applicable)$/i.test(
      business.serviceArea.trim(),
    )
  )
    fields.push('location');
  return [...new Map(fields.map((field) => [normalizeFact(field), field])).values()];
}
/** AI can veto an issue, but only the deterministic checks can authorize one. */
export function assessEligibility(
  service: Service,
  business: Business,
  input: {
    quantity: number;
    description: string;
    inputs: Record<string, string>;
    analysis?: InquiryAssessment | null;
  },
) {
  const facts = normalizedInputs(input.inputs),
    missingInputs = requiredFields(service, business).filter(
      (field) => !facts.get(normalizeFact(field)),
    );
  const reasons: string[] = [];
  if (
    new Set(Object.keys(input.inputs).map(normalizeFact)).size !== Object.keys(input.inputs).length
  )
    reasons.push('Conflicting project fields need owner confirmation.');
  if (missingInputs.length) reasons.push(`More details are needed: ${missingInputs.join(', ')}.`);
  const uncertain =
    /\b(?:unknown|unsure|uncertain|maybe|approximately|roughly|tbd|not sure|do not know|don't know|cannot confirm)\b/i;
  if (Object.values(input.inputs).some((value) => uncertain.test(value)))
    reasons.push('A project detail needs confirmation by the owner.');
  const description = normalizeFact([input.description, ...Object.values(input.inputs)].join(' '));
  for (const exclusion of service.exclusions) {
    const terms = normalizeFact(exclusion)
      .split(' ')
      .filter(
        (term) =>
          term.length > 2 &&
          !['the', 'and', 'with', 'for', 'not', 'only', 'services', 'service', 'cleaning'].includes(
            term,
          ),
      );
    if (
      terms.length &&
      terms.every((term) =>
        description
          .split(' ')
          .some((word) => word === term || word.startsWith(term) || term.startsWith(word)),
      )
    )
      reasons.push('This request includes work outside the service scope.');
  }
  const location = facts.get('location') || facts.get('address') || facts.get('service area');
  if (
    location &&
    !/^(anywhere|everywhere|remote|online|worldwide|not applicable)$/i.test(
      business.serviceArea.trim(),
    )
  ) {
    const areas = business.serviceArea
      .split(/[,;\n|]|\band\b/i)
      .map(normalizeFact)
      .filter((area) => area.length > 2);
    if (!areas.some((area) => normalizeFact(location).includes(area)))
      reasons.push('The owner needs to confirm this project is inside the service area.');
  }
  const calculated = calculatePrice(service, input.quantity, input.inputs);
  const areaUnits = /square|sq\.?\s*ft|area/i.test(service.unitLabel);
  for (const [field, measured] of facts) {
    const measuredUnit = field
      .replace(/^(?:total )?(?:number|count|quantity)(?: of)? /, '')
      .replace(/^total /, '')
      .replace(/ (?:count|number|quantity)$/, '');
    const quantityField =
      /^(?:quantity|count|number)$/.test(field) ||
      (areaUnits && /^(area|square feet|square footage|sq ft|sqft)$/.test(field)) ||
      samePricingUnit(measuredUnit, service.unitLabel);
    if (!quantityField) continue;
    const numeric = /^\s*(\d+(?:\.\d{1,3})?)(?:\s*[\p{L}²³][\p{L}\s.²³/-]*)?\s*$/u.exec(
      measured.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, ''),
    );
    if (
      !numeric ||
      Number(numeric[1]) <= 0 ||
      Math.abs(Number(numeric[1]) - input.quantity) > 0.001
    )
      reasons.push('The pricing quantity and supplied measurement need owner confirmation.');
  }
  if (calculated.calculation.needsReview) reasons.push(...calculated.calculation.reviewReasons);
  if (calculated.totalCents > service.maxAutoQuoteCents)
    reasons.push('This project exceeds the approved automatic quote limit.');
  if (input.analysis?.needsReview) reasons.push('The project has details that need owner review.');
  if (input.analysis?.missingInputs.some((field) => !facts.get(normalizeFact(field))))
    reasons.push('Some project details remain unanswered.');
  return {
    eligible: reasons.length === 0,
    missingInputs,
    reasons: [...new Set(reasons)],
    calculated,
  };
}

/** Round money only once, at the line boundary. BigInt prevents binary decimal price drift. */
export function calculatePrice(
  service: Pick<
    Service,
    | 'name'
    | 'unitLabel'
    | 'unitPriceCents'
    | 'basePriceCents'
    | 'minimumChargeCents'
    | 'maxAutoQuoteCents'
  > & { pricingRules?: PricingRule[] },
  quantity: number,
  inputs: Record<string, string> = {},
) {
  quantitySchema.parse(quantity);
  cents.parse(service.unitPriceCents);
  cents.parse(service.basePriceCents);
  cents.parse(service.minimumChargeCents);
  const thousandths = BigInt(Math.round(quantity * 1000));
  const variable = Number((BigInt(service.unitPriceCents) * thousandths + 500n) / 1000n);
  const subtotal = variable + service.basePriceCents;
  const rules = applyPricingRules(service.pricingRules, inputs, quantity, subtotal);
  const totalCents = Math.max(0, subtotal + rules.adjustmentCents, service.minimumChargeCents);
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_CENTS) {
    throw new RangeError(
      'This request exceeds the maximum supported quote amount. Ask the owner for a custom quote.',
    );
  }
  const lineItems: LineItem[] = [];
  if (service.basePriceCents > 0)
    lineItems.push({
      description: 'Base charge',
      quantity: 1,
      unitPriceCents: service.basePriceCents,
      totalCents: service.basePriceCents,
    });
  lineItems.push({
    description: `${service.name} (${service.unitLabel})`,
    quantity,
    unitPriceCents: service.unitPriceCents,
    totalCents: variable,
  });
  lineItems.push(...rules.lineItems);
  if (totalCents > subtotal + rules.adjustmentCents)
    lineItems.push({
      description: 'Minimum charge adjustment',
      quantity: 1,
      unitPriceCents: totalCents - subtotal - rules.adjustmentCents,
      totalCents: totalCents - subtotal - rules.adjustmentCents,
    });
  return {
    totalCents,
    lineItems,
    calculation: {
      quantity,
      unitPriceCents: service.unitPriceCents,
      basePriceCents: service.basePriceCents,
      minimumChargeCents: service.minimumChargeCents,
      variableCents: variable,
      totalCents,
      exceedsAutomaticLimit: totalCents > service.maxAutoQuoteCents,
      needsReview: rules.needsReview,
      reviewReasons: rules.reasons,
      missingInputs: rules.missingInputs,
      matchedRules: rules.matchedRules,
    },
  };
}

export function samePricingUnit(left: string, right: string) {
  const key = (value: string) =>
    value
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/square (?:feet|foot)|sq\.?\s*ft\.?|sqft/g, 'sqft')
      .replace(/\b(?:jobs?|projects?)\b/g, 'project')
      .replace(/\b(?:hours?|hrs?)\b/g, 'hour')
      .replace(/\b(?:feet|foot)\b/g, 'foot')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .replace(/(?<!s)s$/, '');
  return key(left) === key(right);
}
export function evaluateService(
  service: Service,
  examples: Example[],
  business: Business,
  independent: TestCase[] = [],
): Evaluation {
  const matchingExamples = examples.filter(
    (example) => !example.unitLabel || samePricingUnit(example.unitLabel, service.unitLabel),
  );
  const cases = matchingExamples.map((example) => {
    let actualCents = -1;
    try {
      actualCents = calculatePrice(service, example.quantity, example.inputs).totalCents;
    } catch {
      /* Unsupported size fails this case. */
    }
    const tolerance = Math.max(100, Math.round(example.finalPriceCents * 0.05));
    return {
      title: example.title,
      expectedCents: example.finalPriceCents,
      actualCents,
      passed: actualCents >= 0 && Math.abs(actualCents - example.finalPriceCents) <= tolerance,
      provenance: 'teaching',
    };
  });
  const checks = [
    {
      name: 'Business profile',
      passed: Boolean(business.description.trim() && business.serviceArea.trim()),
      detail: 'Add a business description and service area.',
    },
    {
      name: 'Service scope',
      passed: Boolean(service.description.trim() && service.requiredInputs.length),
      detail: 'Describe the scope and at least one input the owner must confirm.',
    },
    {
      name: 'Pricing configured',
      passed: service.unitPriceCents + service.basePriceCents + service.minimumChargeCents > 0,
      detail: 'Set a unit price, base charge, or minimum charge.',
    },
    {
      name: 'Representative examples',
      passed: matchingExamples.length >= 3,
      detail: `${matchingExamples.length}/3 examples use the current measurement unit; ${examples.length - matchingExamples.length} older-unit examples excluded. This is a configuration check, not proof of autonomous accuracy.`,
    },
    {
      name: 'Example agreement',
      passed: cases.length >= 3 && cases.every((item) => item.passed),
      detail:
        'The calculator must match every example within 5% or $1, whichever is greater. Review exceptions before publishing.',
    },
  ];
  const configurationPassed = checks.every((check) => check.passed);
  const independentResults = independent.map((testCase) => {
    let actualCents = -1,
      actualOutcome: 'quote' | 'review' = 'review';
    try {
      const result = assessEligibility(service, business, testCase);
      actualCents = result.calculated.totalCents;
      actualOutcome = result.eligible ? 'quote' : 'review';
    } catch {
      /* An unsupported request must hand off, never issue. */
    }
    const tolerance = Math.max(
      testCase.toleranceCents,
      Math.round((testCase.expectedCents * testCase.tolerancePercent) / 100),
    );
    return {
      caseId: testCase.id,
      title: testCase.title,
      expectedCents: testCase.expectedCents,
      actualCents,
      expectedOutcome: testCase.expectedOutcome,
      actualOutcome,
      passed:
        actualOutcome === testCase.expectedOutcome &&
        (actualOutcome === 'review' || Math.abs(actualCents - testCase.expectedCents) <= tolerance),
      provenance: 'independent',
    };
  });
  const quotedCases = independent.filter((item) => item.expectedOutcome === 'quote');
  const reviewCases = independent.filter((item) => item.expectedOutcome === 'review');
  const independentEnough = quotedCases.length >= 3 && reviewCases.length >= 1;
  const automaticReady =
    configurationPassed &&
    independentEnough &&
    independentResults.every((item) => item.passed) &&
    service.maxAutoQuoteCents > 0;
  checks.push(
    {
      name: 'Independent quote cases',
      passed: quotedCases.length >= 3,
      detail: `${quotedCases.length}/3 owner-labelled quote cases, separate from teaching examples.`,
    },
    {
      name: 'Boundary handoff case',
      passed: reviewCases.length >= 1,
      detail: `${reviewCases.length}/1 independent case that must hand off for owner review.`,
    },
    {
      name: 'Independent results',
      passed: independentEnough && independentResults.every((item) => item.passed),
      detail:
        'Every independent case must match its owner-labelled price tolerance and issue/handoff outcome.',
    },
  );
  return {
    passed: configurationPassed,
    checks,
    cases: [...cases, ...independentResults],
    evaluatedAt: new Date().toISOString(),
    configurationPassed,
    automaticReady: false,
    deterministicReady: automaticReady,
    independentCaseCount: independent.length,
    serviceVersion: service.version,
    engineVersion: EVALUATOR_VERSION,
    coverage: [
      'Cases are owner-labelled and evaluated by the deterministic calculator, separately from teaching examples.',
      'Passing cases do not establish statistical confidence outside the tested scope.',
      'Missing facts, exclusions, policy changes, unverified contacts, billing limits, and ambiguous requests require owner review.',
    ],
  };
}

/** Customers need the measurement behavior, never the private prices that determine it. */
export function requiresPricingQuantity(service: Service) {
  return (
    service.mode === 'automatic' ||
    service.unitPriceCents > 0 ||
    service.basePriceCents > 0 ||
    service.minimumChargeCents > 0 ||
    Boolean(service.pricingRules?.some((rule) => rule.kind !== 'review' && rule.amount !== 0))
  );
}

export function publicService(service: Service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    unitLabel: service.unitLabel,
    requiredInputs: [
      ...new Set([
        ...service.requiredInputs,
        ...(service.pricingRules || []).map((rule) => rule.field),
      ]),
    ],
    exclusions: service.exclusions,
    mode: service.mode,
    pricingQuantityRequired: requiresPricingQuantity(service),
    publishedAt: service.publishedAt,
  };
}

export function isBillableQuote(input: {
  source: string;
  verifiedContact: boolean;
  automatic: boolean;
  status: string;
}): boolean {
  return (
    input.source === 'live' && input.verifiedContact && input.automatic && input.status === 'issued'
  );
}

export function proposeUnitPrice(
  service: Service,
  quantity: number,
  finalPriceCents: number,
): TrainingSession['pricingProposal'] | undefined {
  if (service.pricingRules?.length) return undefined;
  if (
    !quantitySchema.safeParse(quantity).success ||
    finalPriceCents <= service.minimumChargeCents ||
    finalPriceCents < service.basePriceCents
  )
    return undefined;
  const scaledQuantity = BigInt(Math.round(quantity * 1000));
  const residual = BigInt(finalPriceCents - service.basePriceCents) * 1000n;
  const unitPriceCents = Number((residual + scaledQuantity / 2n) / scaledQuantity);
  if (!cents.safeParse(unitPriceCents).success) return undefined;
  return {
    unitPriceCents,
    basePriceCents: service.basePriceCents,
    minimumChargeCents: service.minimumChargeCents,
    serviceVersion: service.version,
    explanation: `Your final price for ${quantity} ${service.unitLabel} suggests a unit rate of $${(unitPriceCents / 100).toFixed(2)} with the current base charge and minimum. This is a proposal from one example. Review scope and other examples before explicitly applying it to the service.`,
  };
}
