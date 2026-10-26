import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { rows, mutate, type Sql } from './db.js';
import { ApiError } from './http.js';
import { enrichTrainingPhotos } from './training-photos.js';
import { importProjects, importSourceBasis } from './import-history.js';
import type {
  Business,
  Service,
  Example,
  Message,
  TrainingSession,
  Quote,
  Evaluation,
  TestCase,
} from './domain.js';

export type Row = RowDataPacket;
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === 'object' ? (value as T) : fallback;
}
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export function mapBusiness(row: Row): Business {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    industry: row.industry,
    description: row.description,
    serviceArea: row.service_area,
    currency: row.currency,
    onboardingComplete: Boolean(row.onboarding_complete),
    autoQuoteEnabled: Boolean(row.auto_quote_enabled),
    createdAt: iso(row.created_at),
  };
}
export function mapService(row: Row): Service {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    unitLabel: row.unit_label,
    unitPriceCents: Number(row.unit_price_cents),
    minimumChargeCents: Number(row.minimum_charge_cents),
    basePriceCents: Number(row.base_price_cents),
    maxAutoQuoteCents: Number(row.max_auto_quote_cents),
    requiredInputs: json(row.required_inputs_json, []),
    exclusions: json(row.exclusions_json, []),
    mode: row.mode,
    publishedAt: row.published_at ? iso(row.published_at) : null,
    version: row.version,
    approvedVersion: row.approved_version == null ? null : Number(row.approved_version),
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    pricingRules: json(row.pricing_rules_json, []),
  };
}
export function mapExample(row: Row): Example {
  const setupNotes = json<{ role: string; content: string }[]>(row.source_messages_json, [])
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n\n');
  const sourceNotes =
    row.import_source_basis === 'exact_owner_text' && typeof row.import_source_text === 'string'
      ? row.import_source_text
      : setupNotes;
  return {
    id: row.id,
    businessId: row.business_id,
    serviceId: row.service_id,
    title: row.title,
    description: row.description,
    quantity: Number(row.quantity),
    ...(row.unit_label ? { unitLabel: row.unit_label } : {}),
    finalPriceCents: Number(row.final_price_cents),
    rationale: row.rationale,
    ...(sourceNotes ? { sourceNotes } : {}),
    ...(row.import_source_basis
      ? {
          sourceBasis: row.import_source_basis,
          sourceFilename: row.import_source_filename,
          sourceCurrency: row.import_source_currency ?? null,
        }
      : sourceNotes
        ? { sourceBasis: 'exact_owner_text' as const }
        : {}),
    source: row.source,
    createdAt: iso(row.created_at),
    inputs: json(row.inputs_json, {}),
  };
}
export function mapQuote(row: Row): Quote {
  return {
    id: row.id,
    serviceId: row.service_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    status: row.status,
    description: row.description,
    quantity: Number(row.quantity),
    totalCents: Number(row.total_cents),
    currency: row.currency,
    assumptions: json(row.assumptions_json, []),
    lineItems: json(row.line_items_json, []),
    createdAt: iso(row.created_at),
    ...(row.review_reason ? { reviewReason: row.review_reason } : {}),
    ...(row.issued_by ? { issuedBy: row.issued_by } : {}),
    ...(row.decision_at ? { decisionAt: iso(row.decision_at) } : {}),
    ...(row.manual_price_required ? { manualPriceRequired: true } : {}),
  };
}
export async function businessById(businessId: string, connection?: Sql): Promise<Business> {
  const [row] = await rows('SELECT * FROM businesses WHERE id = ?', [businessId], connection);
  if (!row) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return mapBusiness(row);
}
export async function serviceById(
  businessId: string,
  serviceId: string,
  connection?: Sql,
  lock = false,
): Promise<Service> {
  const [row] = await rows(
    `SELECT * FROM services WHERE business_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`,
    [businessId, serviceId],
    connection,
  );
  if (!row) throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Service not found.');
  return mapService(row);
}
export async function servicesForBusiness(
  businessId: string,
  connection?: Sql,
): Promise<Service[]> {
  return (
    await rows(
      'SELECT * FROM services WHERE business_id = ? ORDER BY created_at DESC, id DESC',
      [businessId],
      connection,
    )
  ).map(mapService);
}
export async function examplesForBusiness(
  businessId: string,
  serviceId?: string,
  connection?: Sql,
): Promise<Example[]> {
  const result = serviceId
    ? await rows(
        'SELECT * FROM examples WHERE business_id = ? AND service_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
        [businessId, serviceId],
        connection,
      )
    : await rows(
        'SELECT * FROM examples WHERE business_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
        [businessId],
        connection,
      );
  const sources = result.length
    ? await rows(
        `SELECT example_id,messages_json FROM service_setup_sessions WHERE business_id=? AND status='confirmed' AND example_id IN (${result.map(() => '?').join(',')})`,
        [businessId, ...result.map((example) => example.id)],
        connection,
      )
    : [];
  const sourceMessages = new Map(
    sources.map((source) => [source.example_id, source.messages_json]),
  );
  const importIds = [...new Set(result.map((example) => example.source_import_id).filter(Boolean))];
  const importSources = importIds.length
    ? await rows(
        `SELECT * FROM import_drafts WHERE business_id=? AND id IN (${importIds.map(() => '?').join(',')})`,
        [businessId, ...importIds],
        connection,
      )
    : [];
  const imports = new Map(importSources.map((source) => [source.id, source]));
  return result.map((example) => {
    const source = imports.get(example.source_import_id),
      project = source
        ? importProjects(source).find((item) => item.id === example.source_project_id)
        : undefined;
    return mapExample({
      ...example,
      source_messages_json: sourceMessages.get(example.id),
      ...(source
        ? {
            import_source_basis: importSourceBasis(source),
            import_source_text: source.source_text,
            import_source_filename: source.filename,
            import_source_currency: project?.currency ?? null,
          }
        : {}),
    });
  });
}
export async function getMessages(
  businessId: string,
  conversationId: string,
  type: 'training' | 'public',
  connection?: Sql,
): Promise<Message[]> {
  const messages: Message[] = (
    await rows(
      'SELECT * FROM messages WHERE business_id = ? AND conversation_id = ? AND conversation_type = ? ORDER BY position ASC LIMIT 200',
      [businessId, conversationId, type],
      connection,
    )
  ).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: iso(row.created_at),
    author: row.owner_authored ? 'owner' : row.role === 'user' ? 'customer' : 'ai',
  }));
  return type === 'training' ? enrichTrainingPhotos(businessId, messages, connection) : messages;
}
export async function addMessage(
  businessId: string,
  conversationId: string,
  type: 'training' | 'public',
  role: 'user' | 'assistant',
  content: string,
  connection?: Sql,
  ownerAuthored = false,
) {
  const id = randomUUID();
  await mutate(
    'INSERT INTO messages (id, business_id, conversation_id, conversation_type, role, content, owner_authored) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, businessId, conversationId, type, role, content, ownerAuthored],
    connection,
  );
  return id;
}
export async function trainingById(
  businessId: string,
  id: string,
  connection?: Sql,
): Promise<TrainingSession> {
  const [row] = await rows(
    'SELECT * FROM training_sessions WHERE business_id = ? AND id = ?',
    [businessId, id],
    connection,
  );
  if (!row) throw new ApiError(404, 'TRAINING_NOT_FOUND', 'Training conversation not found.');
  return mapTraining(row, await getMessages(businessId, id, 'training', connection));
}
function mapTraining(row: Row, messages: Message[]): TrainingSession {
  return {
    id: row.id,
    serviceId: row.service_id,
    savedExampleId: row.saved_example_id || null,
    ...(row.unit_label ? { unitLabel: row.unit_label } : {}),
    status: row.status,
    scenario: json(row.scenario_json, {
      title: '',
      customerName: '',
      description: '',
      details: {},
    }),
    messages,
    ...(row.status === 'completed' ? { outcome: row.completion_outcome || 'quote' } : {}),
    createdAt: iso(row.created_at),
    ...(row.final_price_cents != null
      ? { finalPriceCents: Number(row.final_price_cents) }
      : row.completion_outcome === 'inspection_required'
        ? { finalPriceCents: null }
        : {}),
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.pricing_proposal_json
      ? { pricingProposal: json(row.pricing_proposal_json, undefined) }
      : {}),
  };
}
export async function trainingForBusiness(businessId: string): Promise<TrainingSession[]> {
  const list = await rows(
    'SELECT * FROM training_sessions WHERE business_id = ? ORDER BY created_at DESC, id DESC LIMIT 50',
    [businessId],
  );
  if (!list.length) return [];
  const messages = await rows(
    `SELECT * FROM messages WHERE business_id = ? AND conversation_type = 'training' AND conversation_id IN (${list.map(() => '?').join(',')}) ORDER BY position ASC`,
    [businessId, ...list.map((row) => String(row.id))],
  );
  const grouped = new Map<string, Message[]>();
  for (const row of messages) {
    const group = grouped.get(row.conversation_id) || [];
    group.push({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: iso(row.created_at),
      author: row.owner_authored ? 'owner' : row.role === 'user' ? 'customer' : 'ai',
    });
    grouped.set(row.conversation_id, group);
  }
  const enriched = await enrichTrainingPhotos(businessId, [...grouped.values()].flat());
  const byId = new Map(enriched.map((message) => [message.id, message]));
  for (const [id, group] of grouped)
    grouped.set(
      id,
      group.map((message) => byId.get(message.id)!),
    );
  return list.map((row) => mapTraining(row, grouped.get(row.id) || []));
}
export async function quotesForBusiness(businessId: string): Promise<Quote[]> {
  return (
    await rows(
      "SELECT * FROM quotes WHERE business_id = ? AND source = 'live' ORDER BY created_at DESC, id DESC LIMIT 200",
      [businessId],
    )
  ).map(mapQuote);
}
export async function latestEvaluation(
  businessId: string,
  serviceId: string,
  version: number,
  connection?: Sql,
): Promise<Evaluation | null> {
  const [row] = await rows(
    'SELECT id, result_json FROM evaluations WHERE business_id = ? AND service_id = ? AND service_version = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [businessId, serviceId, version],
    connection,
  );
  if (!row) return null;
  const result = json<Evaluation | null>(row.result_json, null);
  return result ? { ...result, id: row.id } : null;
}
/** Include stale versions for read-only recovery; callers must check the evaluation signature. */
export async function latestServiceEvaluation(
  businessId: string,
  serviceId: string,
  connection?: Sql,
): Promise<Evaluation | null> {
  const [row] = await rows(
    'SELECT id, result_json FROM evaluations WHERE business_id = ? AND service_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [businessId, serviceId],
    connection,
  );
  const result = row ? json<Evaluation | null>(row.result_json, null) : null;
  return result ? { ...result, id: row.id } : null;
}
export async function invalidateService(businessId: string, serviceId: string, connection?: Sql) {
  await mutate(
    'UPDATE services SET version = version + 1, published_at = NULL, approved_version = NULL, approved_at = NULL, approved_evaluation_id = NULL WHERE business_id = ? AND id = ?',
    [businessId, serviceId],
    connection,
  );
}

/** Private evidence and automation settings stale checks without interrupting reviewed intake. */
export async function invalidateAutomaticReadiness(
  businessId: string,
  serviceId: string,
  connection?: Sql,
) {
  await mutate(
    "UPDATE services SET version = version + 1, published_at = CASE WHEN mode = 'review' THEN published_at ELSE NULL END, approved_version = NULL, approved_at = NULL, approved_evaluation_id = NULL WHERE business_id = ? AND id = ?",
    [businessId, serviceId],
    connection,
  );
}

export async function testCasesForService(
  businessId: string,
  serviceId: string,
  connection?: Sql,
): Promise<TestCase[]> {
  return (
    await rows(
      'SELECT * FROM service_test_cases WHERE business_id = ? AND service_id = ? ORDER BY created_at, id',
      [businessId, serviceId],
      connection,
    )
  ).map((row) => ({
    id: row.id,
    serviceId: row.service_id,
    title: row.title,
    description: row.description,
    quantity: Number(row.quantity),
    expectedCents: Number(row.expected_cents),
    inputs: json(row.inputs_json, {}),
    toleranceCents: Number(row.tolerance_cents),
    tolerancePercent: Number(row.tolerance_percent),
    expectedOutcome: row.expected_outcome,
    createdAt: iso(row.created_at),
  }));
}
