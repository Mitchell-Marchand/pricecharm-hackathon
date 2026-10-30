import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customerMessage,
  drawJob,
  jobSpec,
  ownerQuote,
  ownerTotal,
  seeded,
  simulatedOwners,
  type SimOwner,
} from '../src/bench/owners.js';
import { mcnemarP, ownerMoves, pairRuns, tally, type SavedRun } from '../src/bench/compare.js';

const windows = (overrides: Partial<SimOwner['rules']> = {}): SimOwner => ({
  name: 'Test Windows',
  area: 'Raleigh, NC',
  tradeId: 'window-cleaning',
  trade: 'Window cleaning',
  rules: {
    services: [
      {
        name: 'Exterior windows',
        unit: 'windows',
        rate: 800,
        sizes: [8, 45],
        volume: null,
        bands: null,
        height: true,
      },
      {
        name: 'Interior windows',
        unit: 'windows',
        rate: 600,
        sizes: [8, 45],
        volume: null,
        bands: null,
        height: true,
      },
    ],
    minimum: 15000,
    heavy: 0.2,
    height: 0.3,
    addOns: [{ label: 'Screens', per: 'unit', cents: 200 }],
    bundle: 10,
    roundTo: 500,
    itemizes: true,
    ...overrides,
  },
});

test('the same seed makes the same owners, spread across the trades', () => {
  const first = simulatedOwners(7, 30);
  assert.deepEqual(first, simulatedOwners(7, 30));
  assert.notDeepEqual(first, simulatedOwners(8, 30));
  assert.deepEqual([...new Set(first.map((owner) => owner.tradeId))].sort(), [
    'gutters',
    'pressure-washing',
    'window-cleaning',
  ]);
  assert.equal(new Set(first.map((owner) => owner.name)).size, 30, 'Every owner has its own name');
});

test('an owner prices by their rules: surcharges, add-ons, rounding and a two-service discount', () => {
  const quote = ownerQuote(windows(), {
    service: 'Exterior windows',
    quantity: 20,
    heavy: true,
    twoStory: true,
    addOns: [{ label: 'Screens' }],
    second: { service: 'Interior windows', quantity: 20 },
  });
  assert.deepEqual(
    quote.lines.map((line) => [line.label, line.amountCents]),
    [
      ['Exterior windows, 20 windows', 16000],
      ['Extra for heavy hard-water stains', 3000],
      ['Second story', 5000],
      ['Interior windows, 20 windows', 12000],
      ['Screens', 4000],
    ],
  );
  assert.deepEqual(quote.discount, { kind: 'percent', value: 10, reason: 'Two services together' });
});

test('a small job is raised to the minimum, and some owners fold extras into the main price', () => {
  const small = {
    service: 'Exterior windows',
    quantity: 8,
    heavy: false,
    twoStory: false,
    addOns: [],
    second: null,
  };
  assert.equal(ownerTotal(windows(), small), 15000);
  const folded = ownerQuote(windows({ itemizes: false }), { ...small, quantity: 20, heavy: true });
  assert.deepEqual(folded.lines, [{ label: 'Exterior windows, 20 windows', amountCents: 19000 }]);
});

test('the customer says everything the price depends on, and the spec records it', () => {
  const owner = windows();
  const job = {
    service: 'Exterior windows',
    quantity: 24,
    heavy: true,
    twoStory: true,
    addOns: [{ label: 'Screens' }],
    second: null,
  };
  const message = customerMessage(seeded(1), owner, job);
  assert.match(message, /24 windows/);
  assert.match(message, /two-story/);
  assert.match(message, /hard-water/);
  assert.match(message, /screens/);
  assert.deepEqual(jobSpec(owner, job), {
    quantity: 24,
    unit: 'windows',
    condition: 'heavy hard-water stains',
    access: 'two-story',
    extras: ['Screens'],
    timing: '',
  });
  assert.equal(drawJob(seeded(2), owner, 'small').quantity, 8, 'A small job is the smallest size');
});

test('the exact McNemar test weighs jobs fixed against jobs broken', () => {
  assert.equal(mcnemarP(0, 0), 1);
  assert.equal(mcnemarP(16, 8).toFixed(3), '0.152');
  assert.equal(mcnemarP(8, 16), mcnemarP(16, 8), 'Either way round');
  assert.ok(mcnemarP(266, 13) < 1e-60);
  assert.equal(mcnemarP(10, 10), 1);
});

test('two runs of a seed line up job for job, and runs of different jobs are refused', () => {
  const owners = simulatedOwners(5, 2, false);
  const rng = seeded(77);
  const tests = owners.flatMap((owner, index) =>
    [0, 1].map(() => {
      const job = drawJob(rng, owner, 'any');
      return { owner: index, job, ownerCents: ownerTotal(owner, job) };
    }),
  );
  // Within 10% or twice the owner's price, job by job.
  const run = (hits: boolean[]): SavedRun => ({
    seed: 5,
    owners,
    tests: tests.map((test, index) => ({
      ...test,
      formula: { cents: hits[index] ? test.ownerCents : test.ownerCents * 2 },
    })),
  });
  const before = run([true, false, true, false]);
  const after = run([true, true, false, true]);
  const { pairs } = pairRuns([before], [after], 'formula');
  assert.deepEqual(
    { ...tally(pairs), p: undefined },
    { jobs: 4, old: 2, new: 3, fixed: 2, broke: 1, p: undefined },
  );
  assert.deepEqual(ownerMoves(pairs), { better: 1, worse: 0, same: 1 });
  const other = run([true, true, true, true]);
  other.tests[3] = { ...other.tests[3], ownerCents: other.tests[3].ownerCents + 100 };
  assert.throws(() => pairRuns([before], [other], 'formula'), /didn't price the same jobs/);
  assert.throws(() => pairRuns([before], [{ ...after, seed: 6 }], 'formula'), /No seed/);
});
