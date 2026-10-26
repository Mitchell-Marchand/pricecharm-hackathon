import type { RowDataPacket } from 'mysql2/promise';
import { rows, type Sql } from './db.js';
import { ApiError } from './http.js';

export type Row = RowDataPacket;

export interface Business {
  id: string;
  name: string;
  slug: string;
  serviceArea: string;
  createdAt: string;
}

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
    serviceArea: row.service_area ?? '',
    createdAt: iso(row.created_at),
  };
}
export async function businessById(businessId: string, connection?: Sql): Promise<Business> {
  const [row] = await rows('SELECT * FROM businesses WHERE id = ?', [businessId], connection);
  if (!row) throw new ApiError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return mapBusiness(row);
}
