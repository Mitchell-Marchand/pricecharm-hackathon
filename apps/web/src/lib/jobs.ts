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

export interface PastJob {
  id: string;
  serviceName: string;
  description: string;
  priceCents: number;
  size: string;
  duration: string;
  when: string;
  materialsCents: number | null;
  discount: Discount | null;
  notes: string;
  source: 'manual' | 'invoice';
  photos: JobPhoto[];
  createdAt: string;
}

export type JobFields = Omit<PastJob, 'id' | 'photos' | 'createdAt' | 'priceCents'> & {
  priceCents: number | null;
};

export interface ReadResult {
  found: boolean;
  job: Omit<JobFields, 'source'>;
  issues: string[];
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

export function readDocument(file: File) {
  const body = new FormData();
  body.append('file', file);
  return api<ReadResult>('/onboarding/jobs/read', { method: 'POST', body });
}
