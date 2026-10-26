import { rows, type Sql } from './db.js';
import type { JobNote } from './domain.js';
import { iso, json } from './models.js';
import { exactGuestHistoricalQuote, statedHistoricalRationale } from './service-setup-ai.js';
import { importSourceBasis, type ReviewedImportProject } from './import-history.js';

/** Owner-only case evidence. These records never become calculator examples or pricing authority. */
export async function jobNotesForBusiness(
  businessId: string,
  serviceId?: string,
  connection?: Sql,
): Promise<JobNote[]> {
  const scoped = serviceId ? ' AND service_id=?' : '';
  const parameters = serviceId ? [businessId, serviceId] : [businessId];
  const setup = await rows(
    `SELECT * FROM service_setup_sessions WHERE business_id=? AND status='confirmed' AND example_id IS NULL${scoped} ORDER BY updated_at DESC LIMIT 200`,
    parameters,
    connection,
  );
  const practice = await rows(
    `SELECT * FROM training_sessions WHERE business_id=? AND status='completed' AND saved_example_id IS NULL AND (completion_outcome='inspection_required' OR (completion_outcome='quote' AND final_price_cents IS NOT NULL))${scoped} ORDER BY updated_at DESC LIMIT 200`,
    parameters,
    connection,
  );
  const imported = await rows(
    `SELECT c.*,d.filename,d.source_text,d.source_basis FROM owner_case_notes c JOIN import_drafts d ON d.id=c.import_draft_id AND d.business_id=c.business_id AND d.service_id=c.service_id WHERE c.business_id=?${serviceId ? ' AND c.service_id=?' : ''} ORDER BY c.created_at DESC,c.id DESC LIMIT 200`,
    parameters,
    connection,
  );
  const ownText = (messages: { role: string; content: string }[]) =>
    messages
      .filter((message) => message.role === 'user' && typeof message.content === 'string')
      .map((message) => message.content)
      .join('\n\n');
  const notes: JobNote[] = setup.map((row) => {
    const draft = json<{
      name: string | null;
      description: string;
      unitLabel: string | null;
      sourcePriceText?: string | null;
      sourceCurrency?: string | null;
      example: {
        title: string;
        description: string;
        quantity: number | null;
        finalPriceCents: number | null;
        rationale: string;
      } | null;
    }>(row.draft_json, { name: null, description: '', unitLabel: null, example: null });
    const example = draft.example,
      sourceNotes = ownText(json(row.messages_json, []));
    return {
      id: row.id,
      serviceId: row.service_id,
      source: 'setup',
      kind: example ? 'historical_job' : 'service_notes',
      title: example?.title || draft.name || 'Service notes',
      description: example?.description || draft.description,
      quantity: example?.quantity ?? null,
      unitLabel: draft.unitLabel,
      finalPriceCents: example?.finalPriceCents ?? null,
      rationale:
        example?.rationale ||
        (exactGuestHistoricalQuote(draft, sourceNotes)
          ? ''
          : statedHistoricalRationale(sourceNotes, example?.finalPriceCents ?? null)) ||
        '',
      sourceNotes,
      sourceBasis: 'exact_owner_text',
      ...(draft.sourcePriceText !== undefined
        ? { sourcePriceText: draft.sourcePriceText, sourceCurrency: draft.sourceCurrency ?? null }
        : {}),
      createdAt: iso(row.updated_at || row.created_at),
    };
  });
  const messages = practice.length
    ? await rows(
        `SELECT conversation_id,role,content FROM messages WHERE business_id=? AND conversation_type='training' AND conversation_id IN (${practice.map(() => '?').join(',')}) ORDER BY position`,
        [businessId, ...practice.map((row) => row.id)],
        connection,
      )
    : [];
  for (const row of practice) {
    const quoted = row.completion_outcome === 'quote';
    const scenario = json<{ title: string; description: string }>(row.scenario_json, {
      title: 'Practice decision',
      description: '',
    });
    const turns = messages.filter((message) => message.conversation_id === row.id) as {
      role: string;
      content: string;
    }[];
    // Completion appends this summary from form fields, not an actual conversation turn.
    // Remove only that final generated message; identical earlier owner text stays intact.
    const completion = turns.at(-1);
    const sourceNotes = ownText(
      quoted &&
        completion?.role === 'user' &&
        completion.content ===
          `Final quote: $${(Number(row.final_price_cents) / 100).toFixed(2)}. ${row.rationale}`
        ? turns.slice(0, -1)
        : turns,
    );
    notes.push({
      id: row.id,
      serviceId: row.service_id,
      source: 'training',
      kind: quoted ? 'practice_quote' : 'inspection_required',
      title: scenario.title,
      description: scenario.description,
      quantity: null,
      unitLabel: quoted ? null : row.unit_label || null,
      finalPriceCents: quoted ? Number(row.final_price_cents) : null,
      rationale: row.rationale || '',
      sourceNotes,
      ...(sourceNotes.trim() ? { sourceBasis: 'exact_owner_text' as const } : {}),
      createdAt: iso(row.updated_at || row.created_at),
    });
  }
  for (const row of imported) {
    const reviewed = json<ReviewedImportProject & { sourceCurrency: string | null }>(
        row.reviewed_json,
        {} as ReviewedImportProject & { sourceCurrency: string | null },
      ),
      sourceBasis = importSourceBasis(row),
      sourceNotes = sourceBasis === 'exact_owner_text' ? row.source_text : '';
    notes.push({
      id: row.id,
      serviceId: row.service_id,
      source: 'import',
      kind: 'historical_job',
      title: reviewed.title,
      description: reviewed.description,
      quantity: reviewed.quantity,
      unitLabel: reviewed.unitLabel || null,
      finalPriceCents: reviewed.finalPriceCents,
      rationale: reviewed.rationale,
      inputs: reviewed.inputs,
      sourceNotes,
      sourceBasis,
      sourceFilename: row.filename,
      sourceCurrency: reviewed.sourceCurrency ?? null,
      createdAt: iso(row.created_at),
    });
  }
  return notes
    .filter(
      (note) =>
        note.serviceId &&
        (note.kind === 'practice_quote' ||
          note.sourceNotes.trim() ||
          (note.source === 'import' && note.description.trim())),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 200);
}
