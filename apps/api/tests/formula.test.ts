import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fitGaps,
  formulaFits,
  mainWork,
  priceJob,
  type PriceFormula,
} from '../src/pricing/formula.js';

const formula: PriceFormula = {
  services: [
    { name: 'Exterior windows', unit: 'windows', rateCents: 800, points: [], minimumCents: null },
    { name: 'Interior windows', unit: 'windows', rateCents: 600, points: [], minimumCents: null },
  ],
  surcharges: [
    { name: 'Heavy stains', when: 'heavy hard-water stains', percent: 20, flatCents: null },
    { name: 'Second story', when: 'two-story house', percent: 30, flatCents: null },
  ],
  addOns: [{ name: 'Screens', per: 'unit', cents: 200 }],
  bundlePercent: 10,
  roundToCents: 500,
  minimumCents: 15000,
  itemizes: true,
};

test('a formula prices every part of the job, rounds each line, and discounts two services', () => {
  const quote = priceJob(formula, {
    service: 'exterior windows',
    size: 20,
    surcharges: ['Heavy stains', 'Second story'],
    addOns: [{ name: 'Screens', count: null }],
    otherServices: [{ name: 'Interior windows', size: 20 }],
  });
  assert.deepEqual(
    quote?.lines.map((line) => line.amountCents),
    [16000, 3000, 5000, 12000, 4000],
  );
  assert.equal(quote?.discount?.value, 10);
  assert.equal(quote?.totalCents, 36000);
});

test('a small job is raised to the minimum, and a part the formula lacks means no price', () => {
  const small = {
    service: 'Exterior windows',
    size: 8,
    surcharges: [],
    addOns: [],
    otherServices: [],
  };
  assert.equal(priceJob(formula, small)?.totalCents, 15000);
  assert.equal(priceJob(formula, { ...small, surcharges: ['Steep roof'] }), null);
  assert.equal(priceJob(formula, { ...small, addOns: [{ name: 'Gutters', count: null }] }), null);
  assert.equal(priceJob(formula, { ...small, size: null }), null);
});

test('prices that don’t scale evenly follow the owner’s own prices at each size', () => {
  const service = {
    name: 'Driveways',
    unit: 'sq ft',
    rateCents: 20,
    points: [
      { size: 400, cents: 10000 },
      { size: 1000, cents: 19000 },
    ],
    minimumCents: null,
  };
  assert.equal(mainWork(service, 700), 14500, 'Between two sizes it priced');
  assert.equal(mainWork(service, 1200), 22000, 'Past the biggest, at the last step’s rate');
  assert.equal(mainWork(service, 200), 5000, 'Below the smallest, scaled down from it');
});

test('a formula is trusted only when it gives back nearly all the owner’s own prices', () => {
  const parts = {
    service: 'Exterior windows',
    size: 20,
    surcharges: [],
    addOns: [],
    otherServices: [],
  };
  assert.deepEqual(
    fitGaps(formula, [
      { parts, totalCents: 16000 },
      { parts, totalCents: 20000 },
    ]),
    [0, 20],
  );
  assert.equal(formulaFits([0, 2, 8, 1, 6]), true, 'An owner who prices by eye still fits');
  assert.equal(formulaFits([0, 2, 40, 1, 30]), false);
  assert.equal(formulaFits([0, 0]), false, 'Two examples are too few to trust');
});

test('rounding is what every amount the owner wrote shares', async () => {
  const { ownerRounding } = await import('../src/pricing/formula.js');
  assert.equal(ownerRounding([12500, 30000, 5000]), 2500);
  assert.equal(ownerRounding([14000, 8500, 15000]), 500);
  assert.equal(ownerRounding([14000, 8550]), 1);
});

test('an owner who prices by size bands is priced at the nearer size they charged', async () => {
  const { mainWork, priceShape } = await import('../src/pricing/formula.js');
  const points = [
    { size: 23, cents: 22000 },
    { size: 27, cents: 22000 },
    { size: 40, cents: 35000 },
    { size: 41, cents: 35000 },
  ];
  assert.equal(priceShape(points), 'bands');
  const bands = {
    name: 'Interior windows',
    unit: 'windows',
    rateCents: null,
    points,
    shape: 'bands' as const,
    minimumCents: null,
  };
  assert.equal(mainWork(bands, 31), 22000, 'Nearer 27 than 40');
  assert.equal(mainWork(bands, 37), 35000);
  assert.equal(mainWork(bands, 10), 22000, 'Below the smallest, in the smallest band');
});

test('a surcharge is read as a percent or a flat amount, whichever gives back the owner’s quotes', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  const flatFormula = {
    ...formula,
    surcharges: [{ name: 'Second story', when: 'two-story', percent: null, flatCents: 6000 }],
    roundToCents: 100,
    minimumCents: null,
  };
  // The owner adds 30%: $60 on 25 windows, $96 on 40.
  const tall = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: ['Second story'],
    addOns: [],
    otherServices: [],
  });
  const refined = refineFormula(flatFormula, [
    { parts: tall(25), totalCents: 26000 },
    { parts: tall(40), totalCents: 41600 },
  ]);
  assert.equal(refined.surcharges[0].flatCents, null);
  assert.equal(Math.round(refined.surcharges[0].percent ?? 0), 30);
});

test('a minimum on one service holds for the others', async () => {
  const { priceJob } = await import('../src/pricing/formula.js');
  const perService = {
    ...formula,
    minimumCents: null,
    services: formula.services.map((item, index) =>
      index === 0 ? { ...item, minimumCents: 15000 } : item,
    ),
  };
  const small = {
    service: 'Interior windows',
    size: 8,
    surcharges: [],
    addOns: [],
    otherServices: [],
  };
  assert.equal(priceJob(perService, small)?.totalCents, 15000);
});

test('an add-on’s price is corrected to what the owner’s quotes say it cost', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  const wrong = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    addOns: [{ name: 'Screens', per: 'job' as const, cents: 5000 }],
  };
  // The owner charges $2 a window for screens: $40 on 20 windows, $60 on 30.
  const job = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: [],
    addOns: [{ name: 'Screens', count: null }],
    otherServices: [],
  });
  const refined = refineFormula(wrong, [
    { parts: job(20), totalCents: 20000 },
    { parts: job(30), totalCents: 30000 },
  ]);
  assert.deepEqual(refined.addOns[0], { name: 'Screens', per: 'unit', cents: 200 });
});

test('two sizes that round to the same price aren’t taken for size bands', async () => {
  const { priceShape } = await import('../src/pricing/formula.js');
  // $2.11 a foot, to the dollar: 190 and 192 feet come within a dollar of each other.
  const points = [80, 124, 184, 190, 192, 225, 267].map((size) => ({
    size,
    cents: Math.round((size * 211) / 100) * 100,
  }));
  assert.notEqual(priceShape(points), 'bands');
});

test('an owner who prices by eye is followed by one line through all their prices', async () => {
  const { mainWork, priceShape } = await import('../src/pricing/formula.js');
  const strays = [0.06, -0.05, 0.04, -0.06, 0.05, -0.04];
  const points = [10, 16, 22, 28, 34, 40].map((size, index) => ({
    size,
    cents: Math.round(size * 800 * (1 + strays[index])),
  }));
  assert.equal(priceShape(points), 'fit');
  const service = { name: 'Windows', unit: 'windows', rateCents: null, points, minimumCents: null };
  const priced = mainWork({ ...service, shape: 'fit' }, 25) ?? 0;
  assert.ok(Math.abs(priced - 20000) / 20000 < 0.03, `${priced} is near $8 a window`);
});

test('past the biggest size, a few odd prices can’t send the rate running away', async () => {
  const { mainWork } = await import('../src/pricing/formula.js');
  const service = {
    name: 'Patios',
    unit: 'sq ft',
    rateCents: null,
    points: [
      { size: 410, cents: 11000 },
      { size: 430, cents: 15200 },
    ],
    minimumCents: null,
  };
  // $2.10 a foot between those two; their price per foot at the biggest is about 35 cents.
  assert.equal(Math.round(mainWork(service, 680) ?? 0), Math.round(15200 + (250 * 15200) / 430));
});

test('“the inside too” with no size of its own is priced at the same size', async () => {
  const { priceJob } = await import('../src/pricing/formula.js');
  const quote = priceJob(formula, {
    service: 'Exterior windows',
    size: 20,
    surcharges: [],
    addOns: [],
    otherServices: [{ name: 'Interior windows', size: null }],
  });
  assert.deepEqual(
    quote?.lines.map((line) => line.amountCents),
    [16000, 12000],
  );
});

test('from one job, an add-on keeps how the AI read it’s charged, and a surcharge is a percent', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  const read = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [{ name: 'Second story', when: 'two-story', percent: null, flatCents: 4800 }],
    addOns: [{ name: 'Screens', per: 'unit' as const, cents: 150 }],
  };
  const job = (surcharges: string[], addOns: { name: string; count: null }[]) => ({
    service: 'Exterior windows',
    size: 20,
    surcharges,
    addOns,
    otherServices: [],
  });
  // 20 windows at $8: $40 more for screens on one job, $48 for a second story on another.
  const refined = refineFormula(read, [
    { parts: job([], [{ name: 'Screens', count: null }]), totalCents: 20000 },
    { parts: job(['Second story'], []), totalCents: 20800 },
  ]);
  assert.deepEqual(refined.addOns[0], { name: 'Screens', per: 'unit', cents: 200 });
  assert.equal(refined.surcharges[0].flatCents, null);
  assert.equal(refined.surcharges[0].percent, 30);
});

test('below the sizes priced, a band owner’s lowest band can be the one the AI read as a minimum', async () => {
  const { mainWork } = await import('../src/pricing/formula.js');
  const service = {
    name: 'Exterior windows',
    unit: 'windows',
    rateCents: null,
    points: [
      { size: 27, cents: 32500 },
      { size: 31, cents: 32500 },
      { size: 36, cents: 40000 },
      { size: 39, cents: 42500 },
    ],
    shape: 'bands' as const,
  };
  assert.equal(mainWork({ ...service, minimumCents: 20000 }, 12), 20000);
  assert.equal(mainWork({ ...service, minimumCents: null }, 12), 32500);
});

test('a price the owner’s note gives isn’t tuned back to older quotes that disagree', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  const noted = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    addOns: [{ name: 'Screens', per: 'unit' as const, cents: 300 }],
    setByNotes: ['Screens'],
  };
  // Their old quotes charged $2 a window for screens; their note says $3 now.
  const job = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: [],
    addOns: [{ name: 'Screens', count: null }],
    otherServices: [],
  });
  const examples = [
    { parts: job(20), totalCents: 20000 },
    { parts: job(30), totalCents: 30000 },
  ];
  assert.equal(refineFormula(noted, examples).addOns[0].cents, 300);
  assert.equal(refineFormula({ ...noted, setByNotes: [] }, examples).addOns[0].cents, 200);
});

test('an owner who rounds to $25 isn’t taken for pricing by size bands', async () => {
  const { priceShape } = await import('../src/pricing/formula.js');
  // 75¢ a foot, each price rounded to $25: neighbors share a price without any bands.
  const points = [174, 188, 190, 202, 217, 227, 235, 267, 278].map((size) => ({
    size,
    cents: Math.round((size * 75) / 2500) * 2500,
  }));
  assert.notEqual(priceShape(points), 'bands');
});
