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
