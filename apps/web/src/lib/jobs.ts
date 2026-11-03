import { api, json } from './api';
import { readPhoto } from './util';

export interface Discount {
  kind: 'amount' | 'percent';
  /** Cents for an amount, whole percent for a percentage. */
  value: number;
  reason: string;
}

export interface JobPhoto {
  id: string;
  url: string;
}

/** Which of a service's jobs the owner meant to add: a small one, a usual one or a big one. */
export type SizeSlot = 'small' | 'usual' | 'big';
export const SIZE_SLOTS: SizeSlot[] = ['small', 'usual', 'big'];

export interface PastJob {
  id: string;
  serviceName: string;
  description: string;
  priceCents: number;
  size: string;
  /** The size as pricing reads it. Null when neither the size nor the description has one. */
  quantity: number | null;
  unit: string | null;
  slot: SizeSlot | null;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: Discount | null;
  notes: string;
  source: 'manual' | 'invoice';
  photos: JobPhoto[];
  createdAt: string;
}

export type JobFields = Omit<
  PastJob,
  'id' | 'photos' | 'createdAt' | 'priceCents' | 'quantity' | 'unit'
> & {
  priceCents: number | null;
};

/** A job as read from an old quote or invoice, for the owner to check. */
export type ReadJob = Omit<JobFields, 'source' | 'slot'>;

/** One dropped file: being read, read, or not readable. It waits on the list until saved or dropped. */
export interface JobImport {
  id: string;
  filename: string;
  status: 'reading' | 'ready' | 'empty' | 'failed';
  job: ReadJob | null;
  issues: string[];
  failure: string | null;
}

export const listJobs = () => api<PastJob[]>('/onboarding/jobs');

export function saveJob(id: string | null, fields: JobFields, photoIds: string[]) {
  return api<PastJob>(id ? `/onboarding/jobs/${id}` : '/onboarding/jobs', {
    method: id ? 'PUT' : 'POST',
    ...json({ ...fields, photoIds }),
  });
}

export const removeJob = (id: string) => api(`/onboarding/jobs/${id}`, { method: 'DELETE' });

/** Shrinks the photo in the browser first, so uploads stay quick on a phone connection. */
export async function uploadJobPhoto(file: File): Promise<JobPhoto> {
  const dataUrl = await readPhoto(file, 1600);
  const blob = await (await fetch(dataUrl)).blob();
  const body = new FormData();
  body.append('file', blob, file.name.replace(/\.[^.]+$/, '') + '.jpg');
  return api<JobPhoto>('/onboarding/photos', { method: 'POST', body });
}

export const listImports = () => api<JobImport[]>('/onboarding/imports');

/** Sends one file. It's read on the server, so it shows as reading until the list says otherwise. */
export function uploadImport(file: File) {
  const body = new FormData();
  body.append('file', file);
  return api<JobImport>('/onboarding/imports', { method: 'POST', body });
}

export const removeImport = (id: string) => api(`/onboarding/imports/${id}`, { method: 'DELETE' });

export interface QuickBooks {
  /** False until PriceCharm's QuickBooks keys are set, and then it isn't offered. */
  available: boolean;
  connection: { companyName: string } | null;
}

export const quickbooksStatus = () => api<QuickBooks>('/onboarding/quickbooks');

/** Where to send the owner to pick their company. They come back to `returnTo`. */
export const connectQuickBooks = (returnTo: string) =>
  api<{ url: string }>('/onboarding/quickbooks/connect', {
    method: 'POST',
    ...json({ returnTo }),
  });

/** Brings the next invoices onto the import list, as many as it has room for. */
export const pullQuickBooks = () =>
  api<{ added: number; full: boolean; imports: JobImport[] }>('/onboarding/quickbooks/pull', {
    method: 'POST',
  });

export const disconnectQuickBooks = () => api('/onboarding/quickbooks', { method: 'DELETE' });

export const saveImports = (jobs: { importId: string; job: ReadJob }[]) =>
  api<{ jobs: PastJob[]; imports: JobImport[] }>('/onboarding/imports/save', {
    method: 'POST',
    ...json({ jobs }),
  });
