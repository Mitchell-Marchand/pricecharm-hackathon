import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PriceFormula } from '../src/pricing/formula.js';
import { disagreement, mostUnsure, pickJob } from '../src/pricing/next-job.js';
import { pickedCustomer } from '../src/practice/plan.js';

const formula = (rateCents: number, parts: Partial<PriceFormula> = {}): PriceFormula =>
  ({
    services: [
      { name: 'Driveways', unit: 'sq ft', rateCents, points: [], minimumCents: null },
      { name: 'Patios', unit: 'sq ft', rateCents: 50, points: [], minimumCents: null },
    ],
    surcharges: [{ name: 'Heavy stains', when: 'heavy stains', percent: 20, flatCents: null }],
    addOns: [{ name: 'Sealing', per: 'unit', cents: 30 }],
    bundlePercent: null,
    roundToCents: 100,
    minimumCents: null,
    itemizes: true,
    ...parts,
  }) as PriceFormula;

const examples = [
  { service: 'Driveways', size: 400, surcharges: [], addOns: [], otherServices: [] },
  { service: 'Driveways', size: 800, surcharges: [], addOns: [], otherServices: [] },
  { service: 'Patios', size: 300, surcharges: [], addOns: [], otherServices: [] },
];
/** A fixed run of draws, so a test isn't down to chance. */
const steady = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const parts = { service: 'Driveways', size: 500, surcharges: [], addOns: [], otherServices: [] };

test('disagreement is how far apart the readings are, and full when only some can price it', () => {
  assert.equal(disagreement([formula(40), formula(40)], parts), 0);
  assert.ok(Math.abs(disagreement([formula(40), formula(50)], parts) - 0.25) < 0.01);
  const noService = formula(40, { services: [] });
  assert.equal(disagreement([formula(40), noService], parts), 1);
});

test('most unsure comes first, and each mix of work gets a turn before any comes back', () => {
  const picked = mostUnsure(
    [
      { job: 'a', score: 0.5, kind: 'one' },
      { job: 'b', score: 0.4, kind: 'one' },
      { job: 'c', score: 0.1, kind: 'two' },
    ],
    2,
  );
  assert.deepEqual(picked, ['a', 'c']);
});

test('a picked job is an everyday one: the owner’s services, at sizes they really do', () => {
  for (let seed = 1; seed < 20; seed += 1) {
    const job = pickJob({
      readings: [formula(40), formula(55)],
      examples,
      extras: [],
      used: [],
      random: steady(seed),
    });
    assert.ok(job);
    assert.ok(['Driveways', 'Patios'].includes(job.parts.service));
    if (job.parts.service === 'Driveways')
      assert.ok((job.parts.size ?? 0) >= 400 && (job.parts.size ?? 0) <= 800, 'Never an odd size');
  }
});

test('with nothing left to settle there’s no pick, and the usual everyday customer comes', () => {
  assert.equal(
    pickJob({
      readings: [formula(40), formula(40)],
      examples,
      extras: [],
      used: [],
      random: steady(7),
    }),
    null,
  );
});

test('what no quote has shown takes turns with what the readings disagree on', () => {
  const asked = (used: string[]) =>
    pickJob({
      readings: [formula(40), formula(55)],
      examples,
      extras: [{ label: 'Rust removal' }, { label: 'Sealing the surface' }],
      used,
      random: steady(11),
    });
  const first = asked([]);
  assert.equal(first?.newThing, 'Rust removal', 'Sealing is already priced, so it isn’t new');
  const second = asked([first!.kind]);
  assert.equal(second?.newThing, '');
  assert.notEqual(second?.kind, first?.kind);
});

test('a picked job reads as a plain customer, and what it teaches goes with the photos', () => {
  const picked = pickedCustomer(
    {
      parts: {
        service: 'Driveways',
        size: 600,
        surcharges: ['Heavy stains'],
        addOns: [{ name: 'Sealing', count: null }],
        otherServices: [{ name: 'Patios', size: 300 }],
      },
      newThing: '',
      kind: 'x',
    },
    formula(40),
    8,
  );
  assert.match(picked.situation, /"Driveways" service.*around 600 sq ft/);
  assert.match(picked.situation, /heavy stains/);
  assert.match(picked.situation, /They want Sealing too/);
  assert.match(picked.situation, /"Patios" service, around 300 sq ft/);
  assert.equal(picked.lesson.photos, 'two_parts');
  assert.equal(picked.pick, 'x');
});
