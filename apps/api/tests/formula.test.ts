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
  assert.equal(formulaFits([0, 2, 4, 1, 3]), true);
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
  const { mainWork } = await import('../src/pricing/formula.js');
  const bands = {
    name: 'Interior windows',
    unit: 'windows',
    rateCents: null,
    points: [
      { size: 23, cents: 22000 },
      { size: 27, cents: 22000 },
      { size: 40, cents: 35000 },
    ],
    minimumCents: null,
  };
  assert.equal(mainWork(bands, 31), 22000, 'Nearer 27 than 40');
  assert.equal(mainWork(bands, 37), 35000);
  assert.equal(mainWork(bands, 10), (22000 * 10) / 23, 'Below the smallest, scaled down from it');
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
