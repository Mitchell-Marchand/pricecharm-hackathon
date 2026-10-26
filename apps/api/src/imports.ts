import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { owner } from './auth.js';
import { mutate, rows, transaction } from './db.js';
import { exampleSchema } from './domain.js';
import { ApiError, ok } from './http.js';
import { examplesForBusiness, invalidateAutomaticReadiness, serviceById } from './models.js';

/** Bounded RFC-4180 style CSV parser, including quoted commas and multiline text. */
export function parseCsv(source: string): string[][] {
  if (source.length > 262144)
    throw new ApiError(413, 'IMPORT_TOO_LARGE', 'The CSV must be smaller than 256 KB.');
  const records: string[][] = [];
  let record: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  const text = source.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else value += char;
    } else if (char === '"') {
      if (value.length || closed)
        throw new ApiError(400, 'INVALID_CSV', 'Quotes must surround the entire CSV field.');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      record.push(value);
      value = '';
      closed = false;
      if (char !== ',') {
        if (record.some((cell) => cell.trim())) records.push(record);
        record = [];
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else {
      if (closed) {
        if (char !== ' ' && char !== '\t')
          throw new ApiError(400, 'INVALID_CSV', 'Unexpected text after a quoted CSV field.');
      } else value += char;
    }
    if (records.length > 101 || record.length > 20 || value.length > 10000)
      throw new ApiError(
        422,
        'IMPORT_LIMIT',
        'Import at most 100 projects, with fields under 10,000 characters.',
      );
  }
  if (quoted)
    throw new ApiError(400, 'INVALID_CSV', 'A quoted CSV field is missing its closing quote.');
  record.push(value);
  if (record.some((cell) => cell.trim())) records.push(record);
  if (records.length > 101)
    throw new ApiError(422, 'IMPORT_LIMIT', 'Import at most 100 projects at a time.');
  return records;
}
export function parseHistoricalCsv(source: string, serviceId: string) {
  const [header, ...records] = parseCsv(source);
  const required = ['title', 'description', 'quantity', 'finalPrice', 'rationale'];
  if (
    !header ||
    header.length !== new Set(header).size ||
    !required.every((field) => header.includes(field))
  ) {
    throw new ApiError(
      400,
      'CSV_HEADERS',
      `Include these CSV columns: ${required.join(', ')}. finalPrice is in dollars.`,
    );
  }
  if (!records.length)
    throw new ApiError(400, 'CSV_EMPTY', 'Add at least one historical project to the CSV.');
  return records.map((record, index) => {
    if (record.length !== header.length)
      throw new ApiError(400, 'CSV_ROW', `Row ${index + 2} has the wrong number of columns.`);
    const fields = Object.fromEntries(
      header.map((field, position) => [field, record[position].trim()]),
    );
    if (!/^\d+(?:\.\d{1,2})?$/.test(fields.finalPrice))
      throw new ApiError(
        400,
        'CSV_PRICE',
        `Row ${index + 2}: finalPrice must be a non-negative dollar amount with at most two decimal places.`,
      );
    const [dollars, fractional = ''] = fields.finalPrice.split('.');
    const finalPriceCents = Number(dollars) * 100 + Number(fractional.padEnd(2, '0'));
    const result = exampleSchema.safeParse({
      serviceId,
      title: fields.title,
      description: fields.description,
      quantity: Number(fields.quantity),
      finalPriceCents,
      rationale: fields.rationale,
      source: 'historical',
    });
    if (!result.success)
      throw new ApiError(
        400,
        'CSV_ROW',
        `Row ${index + 2}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    return result.data;
  });
}
export const importRouter = Router();
importRouter.post(
  '/examples/import',
  express.text({ type: 'text/csv', limit: '256kb' }),
  async (req, res) => {
    const serviceId = z.string().uuid().parse(req.query.serviceId);
    if (typeof req.body !== 'string')
      throw new ApiError(415, 'CSV_REQUIRED', 'Upload CSV content with Content-Type text/csv.');
    const projects = parseHistoricalCsv(req.body, serviceId);
    const businessId = owner(req).businessId;
    await transaction(async (connection) => {
      await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
      const service = await serviceById(businessId, serviceId, connection, true);
      const existing = await examplesForBusiness(businessId, undefined, connection);
      if (existing.length + projects.length > 500)
        throw new ApiError(
          422,
          'EXAMPLE_LIMIT',
          'This import exceeds the workspace limit of 500 historical projects.',
        );
      for (const project of projects) {
        await mutate(
          'INSERT INTO examples (id,business_id,service_id,title,description,quantity,final_price_cents,rationale,source,unit_label) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [
            randomUUID(),
            businessId,
            serviceId,
            project.title,
            project.description,
            project.quantity,
            project.finalPriceCents,
            project.rationale,
            'historical',
            service.unitLabel,
          ],
          connection,
        );
      }
      await invalidateAutomaticReadiness(businessId, serviceId, connection);
    });
    res.status(201).json(ok({ imported: projects.length }));
  },
);
