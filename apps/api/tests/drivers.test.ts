import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsettledDrivers } from '../src/ai/drivers.js';
import { ifPrices } from '../src/pricing/formula-draft.js';
import type { PriceFormula } from '../src/pricing/formula.js';
import { describeSpec, jobFacts } from '../src/pricing/spec.js';

const formula: PriceFormula = {
  services: [{ name: 'Driveways', unit: 'sq ft', rateCents: 41, points: [], minimumCents: null }],
  surcharges: [
    { name: 'Heavy oil stains', when: 'heavy oil stains', percent: 18, flatCents: null },
    { name: 'Regular visits', when: 'regular visits', percent: -10, flatCents: null },
  ],
  addOns: [
    { name: 'Gutter cleaning', per: 'job', cents: 6000 },
    { name: 'Downspout flush', per: 'item', cents: 1500 },
    { name: 'Trip charge', per: 'job', cents: 2500, always: true },
  ],
  bundlePercent: null,
  roundToCents: 500,
  minimumCents: null,
  itemizes: false,
};
const parts = { service: 'Driveways', size: 600, surcharges: [], addOns: [], otherServices: [] };

test('an open condition or extra that moves the price a lot says by how much, from the formula', () => {
  assert.deepEqual(
    ifPrices(formula, parts, [
      'heavy oil stains',
      'Regular visits',
      'Gutter cleaning',
      'Downspout flush',
    ]),
    [
      // 18% of the $245 main work, rounded to the owner's $5.
      { when: 'heavy oil stains', cents: 4500 },
      { when: 'Gutter cleaning', cents: 6000 },
      // With the trip charge the job is $270, so $25 off for regular visits and $15 a downspout
      // are within how close a quote is held anyway, and are left out.
    ],
  );
});

test('what the job was already priced with, is on every job, or is unknown says nothing', () => {
  assert.deepEqual(
    ifPrices(
      formula,
      {
        ...parts,
        surcharges: ['Heavy oil stains'],
        addOns: [{ name: 'Gutter cleaning', count: null }],
      },
      ['heavy oil stains', 'Gutter cleaning', 'Trip charge', 'moss'],
    ),
    [],
  );
  assert.deepEqual(ifPrices(formula, { ...parts, size: null }, ['heavy oil stains']), []);
});

test('nothing to settle asks the model nothing', async () => {
  assert.deepEqual(await unsettledDrivers({ conversation: [], conditions: [], extras: [] }), {
    open: [],
    question: '',
    chips: [],
  });
});

test('a quote says what it was priced for, without changing what the drafts read', () => {
  const spec = {
    quantity: 600,
    unit: 'sq ft',
    condition: 'oil stains by the garage',
    access: '',
    extras: ['gutter cleaning'],
    timing: 'any weekday in the next two weeks',
  };
  assert.deepEqual(jobFacts(spec), [
    '600 sq ft',
    'Oil stains by the garage',
    'Gutter cleaning',
    'Any weekday in the next two weeks',
  ]);
  assert.equal(
    describeSpec(spec),
    '600 sq ft; oil stains by the garage; adds: gutter cleaning; wants it any weekday in the next two weeks',
  );
  assert.deepEqual(jobFacts(null), []);
});
