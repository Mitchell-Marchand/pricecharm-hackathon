import { z } from 'zod';
import { idSchema, type Quote } from './domain.js';
import { readOnlySnapshot, rows, type Sql, type SqlParameters } from './db.js';
import { ApiError } from './http.js';
import { iso, mapQuote, type Row } from './models.js';

const PAGE_SIZE = 25;
const filterSchema = z.enum(['all', 'review', 'issued']);
const cursorSchema = z
  .object({
    v: z.literal(1),
    businessId: idSchema,
    filter: filterSchema,
    direction: z.enum(['older', 'newer']),
    createdAt: z.iso.datetime({ precision: 3 }).refine((value) => {
      const date = new Date(value);
      return (
        date.getUTCFullYear() >= 1000 &&
        date.getUTCFullYear() <= 9999 &&
        date.toISOString() === value
      );
    }),
    id: idSchema,
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
export interface QuoteInboxPage {
  quotes: Quote[];
  counts: { all: number; review: number; issued: number };
  pageSize: 25;
  olderCursor: string | null;
  newerCursor: string | null;
}

function decodeCursor(value: unknown, businessId: string, filter: Cursor['filter']): Cursor {
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error('Invalid cursor transport');
    const bytes = Buffer.from(value, 'base64url'),
      text = bytes.toString('utf8');
    if (bytes.toString('base64url') !== value || !Buffer.from(text).equals(bytes))
      throw new Error('Invalid cursor encoding');
    const cursor = cursorSchema.parse(JSON.parse(text));
    if (cursor.businessId !== businessId || cursor.filter !== filter)
      throw new Error('Invalid cursor context');
    return cursor;
  } catch {
    throw new ApiError(
      400,
      'INVALID_CURSOR',
      'This request page is unavailable. Open the newest requests to continue.',
    );
  }
}

/** Cursors carry a position, never authority; every query independently scopes tenant, source and filter. */
export async function quoteInboxPage(businessId: string, query: unknown): Promise<QuoteInboxPage> {
  const input = z
    .object({ filter: filterSchema.default('all'), cursor: z.unknown().optional() })
    .strict()
    .parse(query);
  const cursor =
    input.cursor === undefined ? null : decodeCursor(input.cursor, businessId, input.filter);
  const newer = cursor?.direction === 'newer',
    operator = newer ? '>' : '<',
    order = newer ? 'ASC' : 'DESC';
  const where = `business_id=? AND source='live'${input.filter === 'all' ? '' : ' AND status=?'}`;
  const scoped: SqlParameters = input.filter === 'all' ? [businessId] : [businessId, input.filter];
  const tuple = (comparison: '<' | '>') =>
    `(created_at ${comparison} ? OR (created_at=? AND id ${comparison} ?))`;
  return readOnlySnapshot(async (connection) => {
    const [counts] = await rows(
      "SELECT COUNT(*) AS all_count,COALESCE(SUM(status='review'),0) AS review_count,COALESCE(SUM(status='issued'),0) AS issued_count FROM quotes WHERE business_id=? AND source='live'",
      [businessId],
      connection,
    );
    const fetched = await rows(
      `SELECT * FROM quotes WHERE ${where}${cursor ? ` AND ${tuple(operator)}` : ''} ORDER BY created_at ${order},id ${order} LIMIT 26`,
      cursor
        ? [...scoped, new Date(cursor.createdAt), new Date(cursor.createdAt), cursor.id]
        : scoped,
      connection,
    );
    const page = fetched.slice(0, PAGE_SIZE);
    if (newer) page.reverse();
    const boundary = (row: Row, direction: Cursor['direction']) =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          businessId,
          filter: input.filter,
          direction,
          createdAt: iso(row.created_at),
          id: row.id,
        } satisfies Cursor),
      ).toString('base64url');
    const exists = async (row: Row, comparison: '<' | '>', sql: Sql) =>
      (
        await rows(
          `SELECT id FROM quotes WHERE ${where} AND ${tuple(comparison)} LIMIT 1`,
          [...scoped, row.created_at, row.created_at, row.id],
          sql,
        )
      ).length > 0;
    const first = page[0],
      last = page.at(-1);
    const hasOlder = Boolean(
      last && (newer ? await exists(last, '<', connection) : fetched.length > PAGE_SIZE),
    );
    const hasNewer = Boolean(
      first && (newer ? fetched.length > PAGE_SIZE : await exists(first, '>', connection)),
    );
    return {
      quotes: page.map(mapQuote),
      counts: {
        all: Number(counts.all_count),
        review: Number(counts.review_count),
        issued: Number(counts.issued_count),
      },
      pageSize: PAGE_SIZE,
      olderCursor: hasOlder ? boundary(last!, 'older') : null,
      newerCursor: hasNewer ? boundary(first, 'newer') : null,
    };
  });
}
