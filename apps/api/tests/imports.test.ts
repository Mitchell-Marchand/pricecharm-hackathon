import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseHistoricalCsv } from '../src/imports.js';
const service = '00000000-0000-4000-8000-000000000001';
test('CSV supports quoted commas, escaped quotes, line breaks, and a UTF-8 BOM', () => {
  assert.deepEqual(
    parseCsv('\uFEFFtitle,description\r\n"Patio, east","One ""large""\npatio"\r\n'),
    [
      ['title', 'description'],
      ['Patio, east', 'One "large"\npatio'],
    ],
  );
});
test('CSV money parsing is exact and validates units before persistence', () => {
  const [project] = parseHistoricalCsv(
    'title,description,quantity,finalPrice,rationale\nDriveway,Concrete driveway,12.5,39.99,Minimum applies',
    service,
  );
  assert.equal(project.finalPriceCents, 3999);
  assert.equal(project.quantity, 12.5);
  assert.throws(() =>
    parseHistoricalCsv(
      'title,description,quantity,finalPrice,rationale\nDriveway,Concrete driveway,-1,39.99,Minimum applies',
      service,
    ),
  );
});
test('CSV rejects malformed or ambiguous money and unmatched quotes', () => {
  assert.throws(() => parseCsv('"unclosed'));
  assert.throws(() => parseCsv('a,"b"nope'));
  assert.throws(() =>
    parseHistoricalCsv(
      'title,description,quantity,finalPrice,rationale\nDriveway,Concrete driveway,12,1e3,Standard',
      service,
    ),
  );
  assert.throws(() =>
    parseHistoricalCsv(
      'title,description,quantity,finalPrice,rationale\nDriveway,Concrete driveway,12,1.999,Standard',
      service,
    ),
  );
});
test('CSV enforces batch size before opening a database transaction', () => {
  const header = 'title,description,quantity,finalPrice,rationale\n';
  assert.throws(() =>
    parseHistoricalCsv(header + 'Driveway,Concrete,10,10,Standard\n'.repeat(101), service),
  );
});
