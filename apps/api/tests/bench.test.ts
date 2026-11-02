import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASSIC_TRADES,
  customerMessage,
  drawJob,
  jobSpec,
  ONE_TIME,
  ownerQuote,
  ownerTotal,
  pastJobs,
  seeded,
  simulatedOwners,
  sizeWords,
  WIDE_TRADES,
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

test('the wide set makes owners in every trade, the classic one only the first three', () => {
  const wide = simulatedOwners(3, 48, true, WIDE_TRADES);
  assert.deepEqual(
    [...new Set(wide.map((owner) => owner.tradeId))].sort(),
    [...WIDE_TRADES].sort(),
  );
  assert.equal(new Set(wide.map((owner) => owner.name)).size, 48, 'Every owner has its own name');
  assert.deepEqual(simulatedOwners(3, 30), simulatedOwners(3, 30, false, CLASSIC_TRADES));
  // Every job any of them could be asked for has a price, and every line is worth something.
  for (const [index, owner] of wide.entries()) {
    const rng = seeded(index);
    for (const job of [
      ...pastJobs(rng, owner, 10),
      ...(['plain', 'other', 'heavy', 'tall', 'small', 'bigger', 'any'] as const).map((shape) =>
        drawJob(rng, owner, shape, 0),
      ),
    ]) {
      const quote = ownerQuote(owner, job);
      assert.ok(ownerTotal(owner, job) > 0, `${owner.tradeId}: ${JSON.stringify(job)}`);
      assert.ok(quote.lines.every((line) => line.amountCents > 0));
    }
  }
});

const owner = (tradeId: SimOwner['tradeId'], rules: Partial<SimOwner['rules']>): SimOwner => ({
  name: 'Test',
  area: 'Raleigh, NC',
  tradeId,
  trade: tradeId,
  rules: {
    services: [],
    minimum: 0,
    heavy: 0,
    height: 0,
    addOns: [],
    bundle: 0,
    roundTo: 100,
    itemizes: true,
    ...rules,
  },
});

const plainJob = { heavy: false, twoStory: false, addOns: [], second: null };

test('a mover bills a crew by the hour, rounded up to the half hour and never under the minimum', () => {
  const movers = owner('moving', {
    services: [
      {
        name: 'Local moves',
        unit: 'bedrooms',
        rate: 0,
        sizes: [1, 4],
        step: 1,
        volume: null,
        bands: null,
        height: true,
        hourly: {
          who: 'movers',
          crews: [
            { upTo: 1, people: 2, rate: 15000 },
            { upTo: 99, people: 3, rate: 22000 },
          ],
          hours: { base: 2, perUnit: 1.2 },
          minimum: 3,
        },
      },
    ],
    heightFlat: 7500,
    fee: { label: 'Trip charge', cents: 10000 },
  });
  const quote = ownerQuote(movers, {
    ...plainJob,
    service: 'Local moves',
    quantity: 2,
    twoStory: true,
  });
  assert.deepEqual(
    quote.lines.map((line) => [line.label, line.amountCents]),
    [
      ['Local moves, 2 bedrooms: 3 movers, 4.5 hours', 99000],
      ['Stairs', 7500],
      ['Trip charge', 10000],
    ],
  );
  const studio = ownerQuote(movers, { ...plainJob, service: 'Local moves', quantity: 0.5 });
  assert.equal(studio.lines[0].label, 'Local moves, 0.5 bedrooms: 2 movers, 3 hours');
});

test('a cleaner prices bedrooms and bathrooms past the first, regular visits for less, ending in 9', () => {
  const cleaner = owner('house-cleaning', {
    services: [
      {
        name: 'Standard clean',
        unit: 'bedrooms',
        rate: 3000,
        base: 10000,
        sizes: [1, 5],
        step: 1,
        volume: null,
        bands: null,
        height: false,
        extra: { unit: 'bathrooms', rate: 2000, range: [1, 4], included: 1 },
      },
    ],
    roundTo: 500,
    endsIn9: true,
    heavyFlat: 3000,
    recurring: [{ label: 'every two weeks', share: 0.15 }],
  });
  const job = { ...plainJob, service: 'Standard clean', quantity: 3, extra: 2 };
  // $100 + 3 × $30 + 1 × $20 = $210, which ends in 9 as $209.
  assert.equal(ownerTotal(cleaner, { ...job, frequency: ONE_TIME }), 20900);
  assert.equal(ownerTotal(cleaner, { ...job, frequency: 'every two weeks' }), 17900);
  assert.deepEqual(
    ownerQuote(cleaner, { ...job, heavy: true, frequency: ONE_TIME }).lines.map(
      (line) => line.label,
    ),
    ['Standard clean, 3 bedrooms, 2 bathrooms', 'Pet hair'],
  );
  const message = customerMessage(seeded(4), cleaner, { ...job, frequency: 'every two weeks' });
  assert.match(message, /3 bedrooms, 2 bathrooms/);
  assert.match(message, /every two weeks/);
});

test('a carpet cleaner charges pet odor by the room, and counts a rug as one room', async () => {
  const carpets = owner('carpet', {
    services: [
      {
        name: 'Carpet',
        unit: 'rooms',
        rate: 6000,
        sizes: [1, 8],
        step: 1,
        volume: null,
        bands: null,
        height: false,
      },
      {
        name: 'Area rugs',
        unit: 'sq ft',
        rate: 150,
        sizes: [24, 150],
        step: 1,
        volume: null,
        bands: null,
        height: false,
      },
    ],
    addOns: [{ label: 'Pet odor treatment', per: 'unit', unit: 'rooms', cents: 3000 }],
  });
  const odor = [{ label: 'Pet odor treatment' }];
  // 3 rooms at $60 and $30 a room for odor; a 100 sq ft rug at $1.50 and one room's $30.
  assert.equal(
    ownerTotal(carpets, { ...plainJob, service: 'Carpet', quantity: 3, addOns: odor }),
    27000,
  );
  const rug = { ...plainJob, service: 'Area rugs', quantity: 100, addOns: odor };
  assert.equal(ownerTotal(carpets, rug), 18000);
  // Quoted only on a rug, its price by the room on carpet was never shown.
  const { informationGaps } = await import('../src/bench/metrics.js');
  const carpet = { ...plainJob, service: 'Carpet', quantity: 4, addOns: odor };
  assert.deepEqual(
    informationGaps(
      carpets,
      [rug, ...[3, 4, 5].map((rooms) => ({ ...carpet, quantity: rooms, addOns: [] }))],
      carpet,
    ),
    ['add-on never quoted on a job measured this way'],
  );
});

test('a stretch customer is a plain job past any size priced for the service priced least', async () => {
  const { sizesShown, stretchedJob, stretchSize } = await import('../src/bench/owners.js');
  const shown = { carpet: [2, 3, 5, 7], 'area rugs': [80, 120] };
  const services = ['Carpet', 'Area rugs'];
  assert.deepEqual(stretchSize(services, shown, 'bigger'), { service: 'Area rugs', around: 200 });
  assert.deepEqual(stretchSize(services, shown, 'smaller'), { service: 'Area rugs', around: 40 });
  assert.equal(
    stretchSize(['Carpet'], { carpet: [1, 2] }, 'smaller'),
    null,
    'Nothing under a room',
  );
  const rule = { step: 1, volume: null, bands: null, height: false };
  const carpets = owner('carpet', {
    services: [
      { ...rule, name: 'Carpet', unit: 'rooms', rate: 6000, sizes: [1, 8] },
      { ...rule, name: 'Area rugs', unit: 'sq ft', rate: 150, sizes: [24, 150] },
    ],
    addOns: [{ label: 'Pet odor treatment', per: 'unit', unit: 'rooms', cents: 3000 }],
  });
  const rug = stretchedJob(seeded(1), carpets, 'Area rugs', 200);
  assert.deepEqual(
    { service: rug.service, quantity: rug.quantity, addOns: rug.addOns, heavy: rug.heavy },
    { service: 'Area rugs', quantity: 200, addOns: [], heavy: false },
  );
  assert.deepEqual(
    sizesShown([rug, { ...plainJob, service: 'Carpet', quantity: 3, second: rug }]),
    { 'area rugs': [200, 200], carpet: [3] },
  );
});

test('an aimed customer asks for what the trade usually charges for and this owner hasn’t priced', async () => {
  const { aimedJob, tradeOfferings } = await import('../src/bench/owners.js');
  const rule = { step: 1, volume: null, bands: null, height: false };
  const services = [
    { ...rule, name: 'Carpet', unit: 'rooms', rate: 6000, sizes: [1, 8] as [number, number] },
    { ...rule, name: 'Area rugs', unit: 'sq ft', rate: 150, sizes: [24, 150] as [number, number] },
  ];
  const odor = { label: 'Pet odor treatment', per: 'job' as const, cents: 3000 };
  const stairs = { label: 'Stairs', per: 'job' as const, cents: 4000 };
  const protector = { label: 'Protector', per: 'job' as const, cents: 2500 };
  const mine = owner('carpet', { services, addOns: [stairs, protector] });
  const others = [
    owner('carpet', { services, addOns: [odor, stairs] }),
    owner('carpet', { services, addOns: [odor] }),
  ];
  const offerings = tradeOfferings([mine, ...others]);
  assert.deepEqual(offerings.get('carpet')!.extras, ['Pet odor treatment', 'Stairs', 'Protector']);
  const shown = [{ ...plainJob, service: 'Carpet', quantity: 3, addOns: [{ label: 'Stairs' }] }];
  const asked = new Set<string>();
  // The trade's most usual extra, which this owner doesn't offer: they price the job without it.
  const odorJob = aimedJob(seeded(1), mine, 'extra', offerings, shown, asked)!;
  assert.deepEqual(odorJob.addOns, []);
  // Stairs were priced, so the next is the protector, which they do charge for.
  const next = aimedJob(seeded(2), mine, 'extra', offerings, shown, asked)!;
  assert.deepEqual(next.addOns, [{ label: 'Protector', count: undefined }]);
  assert.equal(aimedJob(seeded(3), mine, 'extra', offerings, shown, asked), null);
  const bigger = aimedJob(seeded(4), mine, 'size', offerings, shown, asked)!;
  assert.deepEqual([bigger.service, bigger.quantity], ['Carpet', 6]);
});

test('a chat customer knows each fact of the job, and which ones the price depends on', async () => {
  const { jobFacts, practiceFacts } = await import('../src/bench/customer.js');
  const rule = { step: 1, volume: null, bands: null, height: false };
  const carpets = owner('carpet', {
    services: [
      { ...rule, name: 'Carpet', unit: 'rooms', rate: 6000, sizes: [1, 8] },
      { ...rule, name: 'Area rugs', unit: 'sq ft', rate: 150, sizes: [24, 150] },
    ],
    addOns: [{ label: 'Pet odor treatment', per: 'job', cents: 3000 }],
  });
  const job = {
    ...plainJob,
    service: 'Carpet',
    quantity: 4,
    heavy: true,
    addOns: [{ label: 'Pet odor treatment' }],
  };
  const facts = jobFacts(carpets, job);
  assert.deepEqual(
    facts.map(({ key, needed }) => [key, needed]),
    [
      ['service', true],
      ['size', true],
      ['condition', true],
      ['extra1', true],
    ],
  );
  assert.match(facts[1].text, /4 rooms/);
  assert.deepEqual(
    practiceFacts(carpets, { ...job, heavy: false }).map((fact) => fact.question),
    [
      'About how many rooms is it?',
      'What shape is it in right now?',
      'Anything else you’d like done while we’re there?',
    ],
  );
});

test('a detailer scales the price by vehicle size, and junk is a share of the truck', () => {
  const detailer = owner('detailing', {
    services: [
      {
        name: 'Full detail',
        unit: 'cars',
        rate: 20000,
        sizes: [1, 1.7],
        step: 1,
        volume: null,
        bands: null,
        height: false,
        options: [
          { label: 'sedan', share: 1 },
          { label: 'SUV', share: 1.2 },
        ],
      },
    ],
  });
  const suv = { ...plainJob, service: 'Full detail', quantity: 1, option: 'SUV' };
  assert.equal(ownerTotal(detailer, suv), 24000);
  assert.match(customerMessage(seeded(1), detailer, suv), /full detail on my SUV/);
  assert.equal(sizeWords(0.375, 'loads'), 'three eighths of a truckload');
  assert.equal(sizeWords(1, 'loads'), 'a full truckload');
  assert.equal(sizeWords(24, 'windows'), '24 windows');
});

test('every measure of how close prices came, a job with no price counting as a 100% miss', async () => {
  const { closeness } = await import('../src/bench/metrics.js');
  const c = closeness([
    { cents: 10000, ownerCents: 10000 },
    { cents: 11000, ownerCents: 10000 },
    { cents: 8000, ownerCents: 10000 },
    { cents: null, ownerCents: 10000 },
  ]);
  assert.equal(c.within10, 0.5);
  assert.equal(c.within15, 0.5);
  assert.equal(c.mean, (0 + 10 + 20 + 100) / 4);
  assert.equal(c.median, 15);
  assert.equal(c.worst, 100);
  assert.equal(Math.round(c.bias * 100) / 100, Math.round(((0 + 10 - 20) / 3) * 100) / 100);
});

test('a job is tagged by what the owner’s own quotes never showed', async () => {
  const { informationGaps } = await import('../src/bench/metrics.js');
  const owner = simulatedOwners(3, 1, false, ['lawn'])[0];
  const job = (quantity: number, frequency?: string) => ({
    service: 'Mowing',
    quantity,
    heavy: false,
    twoStory: false,
    addOns: [],
    second: null,
    frequency,
  });
  const examples = [job(0.3, 'every week'), job(0.5, 'every week'), job(0.7, 'every week')];
  assert.deepEqual(informationGaps(owner, examples, job(0.5, 'every week')), []);
  assert.ok(
    informationGaps(owner, examples, job(0.2, 'every week')).includes('smaller than any priced'),
  );
  assert.ok(
    informationGaps(owner, examples, job(0.5, 'every two weeks')).includes(
      'visit frequency never quoted',
    ),
  );
});

test('the sealed test set only runs on purpose', async () => {
  const { isSealed } = await import('../src/bench/owners.js');
  assert.equal(isSealed(16, WIDE_TRADES), false);
  assert.equal(isSealed(9001, CLASSIC_TRADES), true);
  assert.equal(isSealed(16, ['pools']), true, 'A held-out trade is sealed on any seed');
});

test('a change that moves nothing has no clear difference, and one that breaks jobs is dropped', async () => {
  const { verdict } = await import('../src/bench/compare.js');
  const owners = simulatedOwners(5, 6, false);
  const rng = seeded(11);
  const tests = owners.flatMap((owner, index) =>
    [0, 1, 2, 3].map(() => {
      const job = drawJob(rng, owner, 'any');
      return { owner: index, job, ownerCents: ownerTotal(owner, job), gaps: [] as string[] };
    }),
  );
  const run = (price: (owner: number) => number): SavedRun => ({
    seed: 5,
    owners,
    tests: tests.map((test) => ({
      ...test,
      formula: { cents: Math.round(test.ownerCents * price(test.owner)) },
    })),
  });
  const exact = run(() => 1);
  const { pairs: same } = pairRuns([exact], [exact], 'formula');
  assert.match(verdict(same).decision, /No clear difference/);
  const { pairs: broken } = pairRuns([exact], [run(() => 1.5)], 'formula');
  assert.match(verdict(broken).decision, /Drop it/);
});
