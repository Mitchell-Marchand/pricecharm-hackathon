import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptAfterMessageId, submittedIntake } from '../src/quote-intake.js';

test('submitted intake retains exact strings and the explicit quantity flag without calculator fields', () => {
  const inputs = {
    location: 'Round Rock',
    Condition: 'unknown',
    'Pet hair': 'false',
    Passengers: '0',
    Notes: '',
    Spacing: '  keep this  ',
  };
  const snapshot = {
    inputs,
    quantityUnknown: true,
    unitPriceCents: 90000,
    totalCents: 270000,
    matchedRules: ['private-rule'],
    explanation: 'Private calculator details',
  };
  assert.deepEqual(submittedIntake(JSON.stringify(snapshot)), { inputs, quantityUnknown: true });
  assert.deepEqual(submittedIntake({ inputs: {}, quantityUnknown: false }), {
    inputs: {},
    quantityUnknown: false,
  });
  assert.deepEqual(submittedIntake({ inputs }), { inputs, quantityUnknown: null });
  assert.deepEqual(submittedIntake({ inputs, quantityUnknown: 'false' }), {
    inputs,
    quantityUnknown: null,
  });
});

test('absent and malformed legacy snapshots stay absent rather than inferring answers or measurement', () => {
  for (const value of [
    null,
    undefined,
    '',
    '{broken',
    [],
    {},
    { quantityUnknown: true },
    { inputs: null },
    { inputs: [] },
    { inputs: { Count: 0 } },
    { inputs: { Present: false } },
    { inputs: { Missing: null } },
  ])
    assert.equal(submittedIntake(value), null);
});

test('submitted intake rejects oversized or unsafe keys and values without truncating saved evidence', () => {
  for (const inputs of [
    { '': 'empty field' },
    { ['x'.repeat(101)]: 'long key' },
    { Condition: 'x'.repeat(2001) },
    Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`Field ${index}`, 'answer'])),
    JSON.parse('{"__proto__":"unsafe"}'),
    { constructor: 'unsafe' },
    Object.assign(Object.create({ hidden: 'prototype' }), { location: 'Austin' }),
  ])
    assert.equal(submittedIntake({ inputs, quantityUnknown: false }), null);
});

test('the receipt boundary uses only its exact stored UUID, never a timestamp or plausible message', () => {
  const id = 'd2800000-0000-4000-8000-000000000001';
  assert.equal(receiptAfterMessageId({ receiptAfterMessageId: id }), id);
  assert.equal(receiptAfterMessageId(JSON.stringify({ receiptAfterMessageId: id })), id);
  assert.equal(receiptAfterMessageId({ inputs: [], receiptAfterMessageId: id }), id);
  assert.equal(submittedIntake({ inputs: [], receiptAfterMessageId: id }), null);
  for (const value of [
    null,
    undefined,
    '{}',
    '{broken',
    [],
    { receiptAfterMessageId: '' },
    { receiptAfterMessageId: 'not-a-uuid' },
    { receiptAfterMessageId: 1 },
    { receiptAfterMessageId: null },
    { receiptAfterMessageId: ` ${id}` },
    Object.create({ receiptAfterMessageId: id }),
    { createdAt: '2026-10-28T12:00:00.000Z', messageId: id },
  ])
    assert.equal(receiptAfterMessageId(value), null);
});
