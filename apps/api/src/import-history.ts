import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cents, idSchema, quantitySchema, type SourceBasis } from './domain.js';
import { pricingInputsSchema } from './rules.js';
import { ApiError } from './http.js';
import { iso, json, type Row } from './models.js';

const sourceCurrency = z
  .string()
  .trim()
  .max(10)
  .nullable()
  .transform((value) => value?.toUpperCase() || null);
export const importConfirmationSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            projectId: idSchema.optional(),
            saveAsNote: z.boolean().default(false),
            title: z.string().trim().min(2).max(160),
            description: z.string().trim().min(3).max(5000),
            quantity: quantitySchema.nullable(),
            finalPriceCents: cents.nullable(),
            rationale: z.string().trim().max(5000),
            inputs: pricingInputsSchema.default({}),
            currency: sourceCurrency,
            unitLabel: z.string().trim().min(1).max(60).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type ReviewedImportProject = z.infer<typeof importConfirmationSchema>['projects'][number];
export type ImportSourceProject = {
  id: string;
  title: string;
  description: string;
  quantity: number | null;
  finalPriceCents: number | null;
  rationale: string;
  unitLabel?: string | null;
  currency: string | null;
  inputs: Record<string, string>;
  issues: string[];
};
export type ImportReceipt = {
  imported: number;
  notesSaved: number;
  exampleIds: string[];
  jobNoteIds: string[];
};
export function importSourceBasis(row: Row): SourceBasis {
  return row.source_basis === 'exact_owner_text' && typeof row.source_text === 'string'
    ? 'exact_owner_text'
    : 'reviewed_extraction';
}
/** Old draft rows need stable project identities without rewriting their original extraction. */
export function importProjects(row: Row): ImportSourceProject[] {
  const data = json<{ projects: Partial<ImportSourceProject>[] }>(row.draft_json, { projects: [] });
  return data.projects.map((project, index) => {
    const hex = createHash('sha256')
      .update(`quotient-import-project:${row.id}:${index}`)
      .digest('hex');
    const id = idSchema.safeParse(project.id).success
      ? project.id!
      : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return {
      ...project,
      id,
      title: project.title || '',
      description: project.description || '',
      quantity: project.quantity ?? null,
      finalPriceCents: project.finalPriceCents ?? null,
      rationale: project.rationale || '',
      unitLabel: project.unitLabel || null,
      currency: project.currency?.trim().toUpperCase() || null,
      inputs: project.inputs || {},
      issues: project.issues || [],
    };
  });
}
export function importReceipt(row: Row): ImportReceipt | null {
  return json<ImportReceipt | null>(row.confirmation_result_json, null);
}
export function importDraft(row: Row, includeText = true) {
  const sourceBasis = importSourceBasis(row),
    receipt = importReceipt(row);
  return {
    id: row.id,
    serviceId: row.service_id,
    filename: row.filename,
    sourceFilename: row.filename,
    sourceBasis,
    ...(includeText && sourceBasis === 'exact_owner_text' ? { sourceNotes: row.source_text } : {}),
    status: row.status,
    projects: importProjects(row),
    notes: json<{ notes: string[] }>(row.draft_json, { notes: [] }).notes || [],
    ...(receipt ? { confirmation: receipt } : {}),
    createdAt: iso(row.created_at),
  };
}
function meaningfulScope(value: string) {
  return (
    /\p{L}{3}/u.test(value) &&
    !/^(?:unknown|missing|not (?:found|provided|specified)|n\/a|none|unclear|project|job|service)(?:\s+(?:project|job|scope|details|service))?[.!]*$/i.test(
      value.trim(),
    )
  );
}
export function resolveImportSelection(row: Row, input: z.infer<typeof importConfirmationSchema>) {
  const original = importProjects(row),
    selected = new Set<string>();
  if (!original.length)
    throw new ApiError(
      422,
      'IMPORT_NEEDS_JOB',
      'This draft contains no identifiable job to save. Add a job description or choose another source.',
    );
  return input.projects.map((project, index) => {
    const source = project.projectId
      ? original.find((candidate) => candidate.id === project.projectId)
      : !project.saveAsNote
        ? original[index]
        : undefined;
    if (!source || selected.has(source.id))
      throw new ApiError(
        422,
        'IMPORT_PROJECT_INVALID',
        'Choose each job from this draft once before saving.',
      );
    selected.add(source.id);
    if (
      !meaningfulScope(project.description) ||
      !(
        meaningfulScope(source.description) ||
        (meaningfulScope(source.title) &&
          (source.quantity !== null || source.finalPriceCents !== null))
      )
    )
      throw new ApiError(
        422,
        'IMPORT_NEEDS_JOB',
        'Describe the actual work before saving this job. Missing-field notices alone cannot be saved as a job.',
      );
    if (project.currency !== 'USD' && project.finalPriceCents !== null)
      throw new ApiError(
        400,
        'IMPORT_CURRENCY_REQUIRED',
        'Confirm a USD amount, or leave the price unknown and save the original source as a note.',
      );
    if (
      !project.saveAsNote &&
      (project.currency !== 'USD' ||
        project.quantity === null ||
        project.finalPriceCents === null ||
        !project.rationale)
    )
      throw new ApiError(
        400,
        'IMPORT_EXAMPLE_INCOMPLETE',
        'A price example needs a known quantity, confirmed USD price and reason. Save incomplete details as a job note.',
      );
    const unitLabel =
      project.unitLabel !== undefined
        ? project.unitLabel
        : source.unitLabel || (!project.saveAsNote ? row.unit_label : null) || null;
    if (!project.saveAsNote && !unitLabel)
      throw new ApiError(
        422,
        'IMPORT_UNIT_REQUIRED',
        'Confirm the quantity unit before saving a price example.',
      );
    return { ...project, projectId: source.id, unitLabel, sourceCurrency: source.currency };
  });
}
export function importConfirmationHash(
  draftId: string,
  projects: ReturnType<typeof resolveImportSelection>,
) {
  const canonical = projects
    .map((project) => ({
      ...project,
      inputs: Object.fromEntries(
        Object.entries(project.inputs).sort(([left], [right]) => left.localeCompare(right)),
      ),
    }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, draftId, projects: canonical }))
    .digest('hex');
}
