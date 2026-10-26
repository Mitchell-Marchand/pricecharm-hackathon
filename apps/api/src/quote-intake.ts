import { idSchema, type Quote } from './domain.js';
import { json, mapQuote, type Row } from './models.js';

export interface SubmittedIntake {
  inputs: Record<string, string>;
  quantityUnknown: boolean | null;
}

/** A legacy timestamp or message text is never a substitute for the exact event ID. */
export function receiptAfterMessageId(snapshot: unknown): string | null {
  const value = json<Record<string, unknown> | null>(snapshot, null);
  if (!value || Array.isArray(value) || !Object.hasOwn(value, 'receiptAfterMessageId')) return null;
  const parsed = idSchema.safeParse(value.receiptAfterMessageId);
  return parsed.success ? parsed.data : null;
}

/** Only the immutable submitted facts are projected, never calculator internals. */
export function submittedIntake(snapshot: unknown): SubmittedIntake | null {
  try {
    const value = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const inputs = value.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
    const prototype = Object.getPrototypeOf(inputs);
    if (prototype !== null && prototype !== Object.prototype) return null;
    const entries = Object.entries(inputs);
    if (
      entries.length > 40 ||
      entries.some(
        ([key, answer]) =>
          !key.trim() ||
          key.length > 100 ||
          ['__proto__', 'prototype', 'constructor'].includes(key.trim().toLowerCase()) ||
          typeof answer !== 'string' ||
          answer.length > 2000,
      )
    )
      return null;
    return {
      inputs: Object.fromEntries(entries) as Record<string, string>,
      quantityUnknown: typeof value.quantityUnknown === 'boolean' ? value.quantityUnknown : null,
    };
  } catch {
    return null;
  }
}

/** Call only after exact owner or customer capability authorization for a live quote. */
export function mapQuoteWithSubmittedIntake(
  row: Row,
): Quote & { submittedIntake: SubmittedIntake | null; receiptAfterMessageId: string | null } {
  return {
    ...mapQuote(row),
    submittedIntake: submittedIntake(row.calculation_json),
    receiptAfterMessageId: receiptAfterMessageId(row.calculation_json),
  };
}
