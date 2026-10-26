export type User = { id: string; name: string; email: string; emailVerified?: boolean };
export type GuestPreview = {
  id: string;
  version: number;
  status: 'processing' | 'ready' | 'failed' | 'claimed';
  content: string;
  expiresAt: string;
  businessNameSuggestion?: string | null;
  receipt: {
    name: string | null;
    description: string;
    unitLabel: string | null;
    example: {
      title: string;
      description: string;
      quantity: number | null;
      finalPriceCents: number | null;
      rationale: string;
    } | null;
    sourcePriceText: string | null;
    sourceCurrency: string | null;
  } | null;
  questions: string[];
  readyToSave: boolean;
  aiMode: 'live' | 'demo';
  error?: { code: string; message: string };
  claim?: { serviceId: string; setupId: string; proposalId: string };
};
export type GuestPreviewState = {
  preview: GuestPreview | null;
  recoverablePreview: GuestPreview | null;
  expiresAt: string;
};
export type QuoteInboxPage = {
  quotes: Quote[];
  counts: { all: number; review: number; issued: number };
  pageSize: 25;
  olderCursor: string | null;
  newerCursor: string | null;
};
export type Business = {
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
};
export type Service = {
  pricingQuantityRequired?: boolean;
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
};
export type Example = {
  sourceBasis?: 'exact_owner_text' | 'reviewed_extraction';
  sourceFilename?: string;
  sourceCurrency?: string | null;
  sourceNotes?: string;
  unitLabel?: string;
  id: string;
  businessId: string;
  serviceId: string;
  title: string;
  description: string;
  quantity: number;
  finalPriceCents: number;
  rationale: string;
  source: 'historical' | 'training';
  createdAt: string;
  inputs?: Record<string, string>;
};
export type JobNote = {
  sourcePriceText?: string | null;
  id: string;
  serviceId: string;
  source: 'setup' | 'training' | 'import';
  sourceBasis?: 'exact_owner_text' | 'reviewed_extraction';
  sourceFilename?: string;
  sourceCurrency?: string | null;
  kind: 'historical_job' | 'inspection_required' | 'service_notes' | 'practice_quote';
  title: string;
  description: string;
  quantity: number | null;
  unitLabel: string | null;
  finalPriceCents: number | null;
  rationale: string;
  sourceNotes: string;
  createdAt: string;
};
export type ImportProject = {
  id: string;
  title: string;
  description: string;
  quantity: number | null;
  unitLabel: string | null;
  finalPriceCents: number | null;
  rationale: string;
  currency: string | null;
  inputs: Record<string, string>;
  issues: string[];
};
export type ImportReceipt = {
  imported: number;
  notesSaved: number;
  exampleIds: string[];
  jobNoteIds: string[];
  alreadyConfirmed: boolean;
};
export type ImportDraft = {
  id: string;
  serviceId: string;
  filename: string;
  sourceFilename: string;
  sourceBasis: 'exact_owner_text' | 'reviewed_extraction';
  sourceNotes?: string;
  status: string;
  projects: ImportProject[];
  notes: string | string[];
  createdAt: string;
  confirmation?: ImportReceipt;
};
export type TrainingPhotoAttachment = {
  id: string;
  url: string;
  alt: string;
  label: string;
  kind: 'sample_photo';
  width: number;
  height: number;
};
export type TrainingMessagePhotos = {
  requestId: string;
  status: 'pending' | 'ready' | 'failed';
  retryable?: boolean;
  error?: string;
  attachments: TrainingPhotoAttachment[];
};
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  author?: 'owner' | 'assistant' | 'ai' | 'customer';
  photos?: TrainingMessagePhotos;
};
export type TrainingSession = {
  unitLabel?: string;
  id: string;
  serviceId: string;
  status: 'active' | 'completed';
  scenario: {
    title: string;
    customerName: string;
    description: string;
    details: Record<string, string>;
  };
  messages: Message[];
  createdAt: string;
  finalPriceCents?: number | null;
  savedExampleId?: string | null;
  outcome?: 'quote' | 'inspection_required';
  rationale?: string;
  pricingProposal?: {
    unitPriceCents: number;
    basePriceCents: number;
    minimumChargeCents: number;
    serviceVersion: number;
    explanation: string;
  };
};
export type Quote = {
  receiptAfterMessageId?: string | null;
  submittedIntake?: {
    inputs: Record<string, string>;
    quantityUnknown: boolean | null;
  } | null;
  manualPriceRequired?: boolean;
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
  lineItems: {
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }[];
  createdAt: string;
  reviewReason?: string;
  issuedBy?: string;
  decisionAt?: string;
};
export type Evaluation = {
  passed: boolean;
  configurationPassed?: boolean;
  automaticReady?: boolean;
  serviceVersion?: number;
  independentCaseCount?: number;
  coverage?: string[];
  checks: { name: string; passed: boolean; detail: string }[];
  cases: {
    title: string;
    expectedCents: number;
    actualCents: number;
    passed: boolean;
    provenance?: string;
    expectedOutcome?: 'quote' | 'review';
    actualOutcome?: 'quote' | 'review';
  }[];
  evaluatedAt: string;
};
export type ServiceReadiness = {
  serviceId: string;
  serviceVersion: number;
  evaluation: Evaluation | null;
  evaluationCurrent: boolean;
  invalidation: null | 'not_evaluated' | 'policy_changed' | 'model_changed' | 'engine_changed';
  approvalCurrent: boolean;
  published: boolean;
  autoQuoteEnabled: boolean;
};
export type Dashboard = {
  business: Business;
  services: Service[];
  serviceAreaSuggestions?: Record<string, string>;
  stats: {
    totalQuotes: number;
    issuedQuotes: number;
    reviewQuotes: number;
    trainingCompleted: number;
    examplesCount: number;
    quotedValueCents: number;
  };
  examples: Example[];
  jobNotes?: JobNote[];
  recentQuotes: Quote[];
  trainingSessions: TrainingSession[];
  usage: { billableQuotes: number; aiCalls: number };
};
export type Settings = {
  providers: { openai: boolean; anthropic: boolean };
  aiMode: 'live' | 'demo';
  billingConfigured: boolean;
};
export type PublicProfile = {
  business: Pick<Business, 'name' | 'slug' | 'description' | 'serviceArea' | 'currency'>;
  services: PublicService[];
};
export type PublicService = Pick<
  Service,
  | 'id'
  | 'name'
  | 'description'
  | 'unitLabel'
  | 'requiredInputs'
  | 'exclusions'
  | 'mode'
  | 'publishedAt'
> & { pricingQuantityRequired?: boolean; version?: number };
export type PrivatePreviewProfile = Omit<PublicProfile, 'services'> & { services: Service[] };
export type PublicSession = {
  pricingQuantityRequired?: boolean;
  id: string;
  serviceId?: string;
  serviceVersion?: number;
  quoteMode?: 'review' | 'automatic';
  requiredInputs?: string[];
  source?: 'live' | 'playground';
  expiresAt?: string;
  messages: Message[];
  quote?: Quote;
  status?: 'active' | 'submitted' | 'issued' | 'accepted' | 'declined';
  humanHandoff?: boolean;
  collectedInputs?: Record<string, string>;
  missingInputs?: string[];
  contact?: { verified: boolean; email?: string };
  reviewReason?: string;
};
export type TestCase = {
  id: string;
  title: string;
  description: string;
  quantity: number;
  expectedCents: number;
  expectedOutcome: 'quote' | 'review';
  inputs: Record<string, string>;
  toleranceCents?: number;
  tolerancePercent?: number;
};
export type PricingRule = {
  id: string;
  name: string;
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string;
  kind: 'fixed' | 'per_unit' | 'percent' | 'review';
  amount: number;
};
export type Pricing = {
  currency: string;
  monthlyCents: number;
  includedQuotes: number;
  overageCents: number | null;
  feeBasisPoints: number;
  minimumFeeCents: number;
  maximumFeeCents: number;
  trialQuotes: number;
  trialDays: number;
};
export type Billing = {
  provider: 'stripe' | 'local';
  configured: boolean;
  status: string;
  canIssue: boolean;
  reason?: string;
  trial: { remainingQuotes: number; quoteLimit: number; endsAt: string };
  usage: { deliveredQuotes: number; billableQuotes: number; feesCents: number; month: string };
  tariff: {
    basisPoints: number;
    minimumFeeCents: number;
    maximumFeeCents: number;
    currency: string;
    version: string;
  };
  spendingCapCents: number;
  subscription: { status: string; cancelAtPeriodEnd: boolean; periodEnd: string | null } | null;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
};
