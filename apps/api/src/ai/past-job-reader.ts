import { z } from 'zod';
import { aiMode, requestJson, type AiDocument, type AiImage } from './index.js';

/** A past job as the setup form holds it. Unknown values are empty or null, never guessed. */
export type ReadJob = {
  serviceName: string;
  description: string;
  priceCents: number | null;
  size: string;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: { kind: 'amount' | 'percent'; value: number; reason: string } | null;
  notes: string;
};

const jobJson = {
  type: 'object',
  properties: {
    serviceName: { type: 'string' },
    description: { type: 'string' },
    priceCents: { type: ['integer', 'null'] },
    size: { type: 'string' },
    duration: { type: 'string' },
    when: { type: 'string' },
    materialsCents: { type: ['integer', 'null'] },
    discountKind: { type: 'string', enum: ['none', 'amount', 'percent'] },
    discountValue: { type: ['integer', 'null'] },
    discountReason: { type: 'string' },
    notes: { type: 'string' },
  },
  required: [
    'serviceName',
    'description',
    'priceCents',
    'size',
    'duration',
    'when',
    'materialsCents',
    'discountKind',
    'discountValue',
    'discountReason',
    'notes',
  ],
  additionalProperties: false,
};
const resultJson = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    job: jobJson,
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['found', 'job', 'issues'],
  additionalProperties: false,
};
const cents = z.number().int().min(0).max(100_000_000).nullable();
const resultSchema = z.object({
  found: z.boolean(),
  job: z.object({
    serviceName: z.string().trim().max(200),
    description: z.string().trim().max(2000),
    priceCents: cents,
    size: z.string().trim().max(200),
    duration: z.string().trim().max(200),
    when: z.string().trim().max(200),
    materialsCents: cents,
    discountKind: z.enum(['none', 'amount', 'percent']),
    discountValue: cents,
    discountReason: z.string().trim().max(400),
    notes: z.string().trim().max(2000),
  }),
  issues: z.array(z.string().trim().max(400)).max(10),
});

/**
 * Reads one past job from an owner's old quote or invoice (a PDF or a photo of one), into the same
 * fields the owner fills in by hand. The owner checks every field before saving.
 */
export async function readPastJob(input: {
  trade: string;
  services: string[];
  file: { document?: AiDocument; image?: AiImage };
}): Promise<{ found: boolean; job: ReadJob; issues: string[] }> {
  if (aiMode === 'demo')
    return {
      found: true,
      job: {
        serviceName: input.services[0] ?? '',
        description: 'Driveway wash, about 900 sq ft, with oil stain treatment.',
        priceCents: 32000,
        size: '900 sq ft',
        duration: '3 hours',
        when: '',
        materialsCents: 2500,
        discount: { kind: 'amount', value: 2000, reason: 'Repeat customer' },
        notes: '',
      },
      issues: ['Demo mode: this is sample data, not read from your file.'],
    };
  const result = await requestJson(
    'read_past_job',
    `Read the attached quote or invoice from a ${input.trade} business and fill in one past job for the owner to check.
- found: false when the file isn't a quote or invoice for work this business did. Then leave every field empty or null.
- Lines for the same visit, like screens cleaned along with the windows, are one job: priceCents is their total and description names each part with its price. Only separate jobs, on different dates or at different places, are more than one; then use the main one and say so in issues.
- serviceName: exactly one of the business's services listed in the input, or an empty string if none fits.
- description: one or two plain sentences about the work, such as what was done, how big it was and any extras. No names, street addresses, phone numbers, emails or account numbers.
- priceCents: what the customer paid for the job, in cents. Leave out tax when it's listed separately. Null if the total isn't clear.
- size: the measured size or count if it's stated, like "900 sq ft" or "24 windows". When parts of the job are the same kind of work in the same unit, like a patio and a walkway, it's their total, like "620 sq ft". duration: how long it took, if stated. when: the month and year of the job, like "June 2026".
- materialsCents: materials cost if it's listed separately, else null.
- discount: discountKind "amount" with discountValue in cents, or "percent" with a whole-number percent, plus the reason if one is given. Otherwise discountKind "none" and discountValue null.
- notes: anything the document says made the job cost more or less. Otherwise empty.
- Only use what the document shows. Never guess a value. In issues, briefly name anything the owner should check, in a short plain sentence: a price, service or size that's missing or unclear, or a second job on the same document. Duration, date, materials and discounts are optional, so never say they're missing.`,
    { services: input.services },
    resultJson,
    resultSchema,
    input.file.image ? [input.file.image] : [],
    input.file.document ? [input.file.document] : [],
  );
  const job = result.job;
  const serviceName =
    input.services.find((name) => name.toLowerCase() === job.serviceName.toLowerCase()) ?? '';
  const discount =
    job.discountKind !== 'none' && job.discountValue
      ? {
          kind: job.discountKind,
          value:
            job.discountKind === 'percent' ? Math.min(job.discountValue, 100) : job.discountValue,
          reason: job.discountReason.slice(0, 160),
        }
      : null;
  return {
    found: result.found,
    job: {
      serviceName,
      description: job.description.slice(0, 2000),
      priceCents: job.priceCents || null,
      size: job.size.slice(0, 80),
      duration: job.duration.slice(0, 80),
      when: job.when.slice(0, 80),
      materialsCents: job.materialsCents,
      discount,
      notes: job.notes.slice(0, 2000),
    },
    issues: result.issues,
  };
}
