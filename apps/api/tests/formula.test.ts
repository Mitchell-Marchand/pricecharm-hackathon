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
  // $100 for 400 sq ft and $190 for 1,000 is $40 every job pays plus 15¢ a foot, so 200 sq ft
  // is more than half of $100, but only a little more: $52.50, not the line's $70.
  assert.equal(mainWork(service, 200), 5250, 'Below the smallest, a little over scaling down');
  const steeper = {
    ...service,
    points: [
      { size: 400, cents: 8000 },
      { size: 1000, cents: 21000 },
    ],
  };
  assert.equal(mainWork(steeper, 200), 4000, 'Never under scaling straight down');
});

test('a formula is trusted only when it gives back most of the owner’s own prices', async () => {
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
  assert.equal(formulaFits([0, 2, 40, 1, 30]), true, 'Three of five is most');
  assert.equal(formulaFits([0, 25, 40, 1, 30]), false);
  assert.equal(formulaFits([0, 0]), false, 'Two examples are too few to trust');
  const { formulaUsable } = await import('../src/pricing/formula.js');
  assert.equal(formulaUsable([0, 25, 40, 1, 30]), true, 'Two of five still prices, as a range');
  assert.equal(formulaUsable([0, 25, 40, 31, 30]), false);
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

test('a service charged only the minimum has no rate past the sizes charged', async () => {
  const { priceJob } = await import('../src/pricing/formula.js');
  // The prod test: 8 inside windows at the $150 minimum, which the AI read as $18.75 a window.
  const floored = {
    ...formula,
    roundToCents: 100,
    services: [
      formula.services[0],
      { ...formula.services[1], rateCents: 1875, points: [{ size: 8, cents: 15000 }] },
    ],
  };
  const inside = (size: number) => ({
    service: 'Interior windows',
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
  });
  assert.equal(priceJob(floored, inside(6))?.totalCents, 15000);
  assert.equal(priceJob(floored, inside(8))?.totalCents, 15000);
  assert.equal(priceJob(floored, inside(22)), null, 'The Charm’s usual draft prices it');
  assert.equal(
    priceJob(floored, {
      ...inside(22),
      service: 'Exterior windows',
      otherServices: [{ name: 'Interior windows', size: null }],
    }),
    null,
  );
  // A price above the minimum is a real rate, and so is one under it: a line on a bigger job.
  const priced = (cents: number) => ({
    ...floored,
    services: [
      floored.services[0],
      { ...floored.services[1], rateCents: cents / 20, points: [{ size: 20, cents }] },
    ],
  });
  assert.equal(priceJob(priced(20000), inside(22))?.totalCents, 22000);
  assert.equal(priceJob(priced(12000), inside(30))?.totalCents, 18000);
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
  assert.deepEqual(refined.addOns[0], {
    name: 'Screens',
    per: 'unit',
    cents: 200,
    unit: 'windows',
    jobCents: 6000,
  });
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
  assert.deepEqual(refined.addOns[0], {
    name: 'Screens',
    per: 'unit',
    cents: 200,
    unit: 'windows',
    jobCents: 4000,
  });
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

test('a discount comes off the main work’s line, whether or not the owner itemizes', async () => {
  const { priceJob } = await import('../src/pricing/formula.js');
  const visits = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [
      { name: 'Every two weeks', when: 'every two weeks', percent: -15, flatCents: null },
      { name: 'Second story', when: 'two-story house', percent: 30, flatCents: null },
    ],
  };
  const job = {
    service: 'Exterior windows',
    size: 20,
    surcharges: ['Every two weeks', 'Second story'],
    addOns: [],
    otherServices: [],
  };
  assert.deepEqual(
    priceJob(visits, job)?.lines.map((line) => [line.label, line.amountCents]),
    [
      ['Exterior windows, 20 windows', 13600],
      ['Second story', 4800],
    ],
  );
  assert.equal(priceJob({ ...visits, itemizes: false }, job)?.totalCents, 18400);
});

test('a charge on every quote the owner itemized is on every job, asked for or not', async () => {
  const { priceJob, refineFormula } = await import('../src/pricing/formula.js');
  const movers = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [],
    addOns: [{ name: 'Trip charge', per: 'job' as const, cents: 10000 }],
  };
  const job = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
  });
  const quote = (size: number) => ({
    parts: job(size),
    totalCents: size * 800 + 9000,
    lines: [
      { label: `Exterior windows, ${size} windows`, amountCents: size * 800 },
      { label: 'Trip charge', amountCents: 9000 },
    ],
  });
  const refined = refineFormula(movers, [quote(20), quote(30), quote(40)]);
  assert.deepEqual(refined.addOns[0], {
    name: 'Trip charge',
    per: 'job',
    cents: 9000,
    always: true,
  });
  assert.equal(priceJob(refined, job(25))?.totalCents, 29000);
});

test('an add-on’s line on the owner’s quote says what it cost, even when the main work is off', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  // The AI read the main work at $10 a window and brightening at the $85 the owner wrote; the
  // owner's main work is $9 a window, so totals alone would move the $5 a job onto brightening.
  const read = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [],
    services: [{ ...formula.services[0], rateCents: 1000 }],
    addOns: [{ name: 'Brightening', per: 'job' as const, cents: 8500 }],
  };
  const quote = (size: number) => ({
    parts: {
      service: 'Exterior windows',
      size,
      surcharges: [],
      addOns: [{ name: 'Brightening', count: null }],
      otherServices: [],
    },
    totalCents: size * 900 + 8500,
    lines: [
      { label: `Exterior windows, ${size} windows`, amountCents: size * 900 },
      { label: 'Brightening', amountCents: 8500 },
    ],
  });
  const refined = refineFormula(read, [quote(20), quote(30)]);
  assert.deepEqual(refined.addOns[0], { name: 'Brightening', per: 'job', cents: 8500 });
});

test('jobs of about the same size can’t make a surcharge a flat amount', async () => {
  const { refineFormula } = await import('../src/pricing/formula.js');
  const flat = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [{ name: 'Second story', when: 'two-story', percent: null, flatCents: 6000 }],
  };
  const tall = (size: number, totalCents: number) => ({
    parts: {
      service: 'Exterior windows',
      size,
      surcharges: ['Second story'],
      addOns: [],
      otherServices: [],
    },
    totalCents,
  });
  // 25 and 28 windows: a flat $60 fits these two a little better, but can't be told from 30%.
  const refined = refineFormula(flat, [tall(25, 26000), tall(28, 28400)]);
  assert.equal(refined.surcharges[0].flatCents, null);
  const percent = refined.surcharges[0].percent ?? 0;
  assert.ok(percent >= 26 && percent <= 31, `${percent}%`);
});

test('below a band owner’s sizes, a small job costs the business’s minimum', async () => {
  const { priceJob } = await import('../src/pricing/formula.js');
  const bands = {
    ...formula,
    minimumCents: 25800,
    roundToCents: 100,
    services: [
      {
        name: 'Driveways',
        unit: 'sq ft',
        rateCents: null,
        shape: 'bands' as const,
        minimumCents: null,
        points: [
          { size: 900, cents: 33000 },
          { size: 1080, cents: 39000 },
          { size: 1320, cents: 52500 },
        ],
      },
    ],
  };
  const job = { service: 'Driveways', size: 550, surcharges: [], addOns: [], otherServices: [] };
  assert.equal(priceJob(bands, job)?.totalCents, 25800);
});

test('a small job the AI read as a price, at the owner’s cheapest total, is their minimum', async () => {
  const { priceJob, refineFormula } = await import('../src/pricing/formula.js');
  // $9.50 a window, and $104 for both 8 and 12 windows, which no rate gives: the AI put the 8 down
  // as a price of its own.
  const read = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [],
    addOns: [],
    services: [
      {
        name: 'Exterior windows',
        unit: 'windows',
        rateCents: 950,
        minimumCents: null,
        points: [
          { size: 8, cents: 10400 },
          { size: 20, cents: 19000 },
          { size: 30, cents: 28500 },
          { size: 40, cents: 38000 },
        ],
      },
    ],
  };
  const job = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
  });
  const refined = refineFormula(read, [
    { parts: job(8), totalCents: 10400 },
    { parts: job(12), totalCents: 10400 },
    { parts: job(20), totalCents: 19000 },
    { parts: job(30), totalCents: 28500 },
    { parts: job(40), totalCents: 38000 },
  ]);
  assert.equal(refined.minimumCents, 10400);
  assert.equal(priceJob(refined, job(5))?.totalCents, 10400);
});

test('a second count, like bathrooms, adds its price past the ones the main price includes', async () => {
  const { priceJob, refineFormula } = await import('../src/pricing/formula.js');
  const cleaning = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [],
    addOns: [],
    services: [
      {
        name: 'Standard clean',
        unit: 'bedrooms',
        rateCents: 4000,
        points: [],
        minimumCents: null,
        extra: { unit: 'bathrooms', rateCents: 3000, included: 1 },
      },
    ],
  };
  const job = (size: number, extraSize: number | null) => ({
    service: 'Standard clean',
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
    extraSize,
  });
  assert.equal(priceJob(cleaning, job(3, 2))?.totalCents, 15000);
  assert.equal(priceJob(cleaning, job(3, 1))?.totalCents, 12000);
  assert.equal(priceJob(cleaning, job(3, null)), null, 'Without the count, the formula can’t say');
  // The owner charges $25 a bathroom past the first.
  const refined = refineFormula(cleaning, [
    { parts: job(3, 2), totalCents: 14500 },
    { parts: job(2, 3), totalCents: 13000 },
    { parts: job(4, 1), totalCents: 16000 },
  ]);
  assert.deepEqual(refined.services[0].extra, { unit: 'bathrooms', rateCents: 2500, included: 1 });
});

test('a quote it can’t back with the owner’s own quotes is one it doubts', async () => {
  const { doubtsAbout, priceJob } = await import('../src/pricing/formula.js');
  const plainFormula = { ...formula, minimumCents: null, roundToCents: 100 };
  const job = (size: number) => ({
    service: 'Exterior windows',
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
  });
  const examples = [20, 25, 30, 35].map((size) => ({ parts: job(size), totalCents: size * 800 }));
  const doubts = (size: number) =>
    doubtsAbout(plainFormula, examples, job(size), priceJob(plainFormula, job(size))!);
  assert.deepEqual(doubts(28), [], 'Inside what they priced, nothing to doubt');
  assert.ok(doubts(60).some((doubt) => /much bigger/.test(doubt)));
  assert.ok(doubts(10).some((doubt) => /much smaller/.test(doubt)));
  assert.ok(doubts(10).some((doubt) => /less than anything/.test(doubt)));
  assert.deepEqual(
    doubtsAbout(plainFormula, [], job(60), priceJob(plainFormula, job(60))!),
    [],
    'With none of their quotes to go on, it says nothing',
  );
});

test('a job lifted well up to a minimum its service was never charged is one it doubts', async () => {
  const { doubtsAbout, priceJob } = await import('../src/pricing/formula.js');
  const floored = { ...formula, minimumCents: 30000, roundToCents: 100, surcharges: [] };
  const job = (service: string, size: number) => ({
    service,
    size,
    surcharges: [],
    addOns: [],
    otherServices: [],
  });
  // The $300 minimum was only ever charged for outside windows.
  const examples = [
    { parts: job('Exterior windows', 20), totalCents: 30000 },
    { parts: job('Exterior windows', 40), totalCents: 32000 },
    { parts: job('Interior windows', 60), totalCents: 36000 },
    { parts: job('Interior windows', 70), totalCents: 42000 },
  ];
  const lifted = (parts: ReturnType<typeof job>) =>
    doubtsAbout(floored, examples, parts, priceJob(floored, parts)!).some((doubt) =>
      /lifted to your minimum/.test(doubt),
    );
  assert.equal(lifted(job('Interior windows', 20)), true);
  assert.equal(lifted(job('Exterior windows', 25)), false, 'Outside windows were charged it');
});

test('at a size the owner priced, the main work is their own price there', () => {
  // Movers whose crew grows with the home: one line through these misses every one of them.
  const movers = {
    name: 'Local moves',
    unit: 'bedrooms',
    rateCents: null,
    shape: 'fit' as const,
    minimumCents: null,
    points: [
      { size: 1, cents: 58300 },
      { size: 2, cents: 86400 },
      { size: 3, cents: 157700 },
      { size: 4, cents: 257500 },
      { size: 4, cents: 252500 },
    ],
  };
  assert.equal(mainWork(movers, 1), 58300);
  assert.equal(mainWork(movers, 4), 255000, 'The average of what they charged at that size');
  assert.notEqual(mainWork(movers, 2.5), null);
});

test('an add-on priced by the window or the system isn’t multiplied by square feet', async () => {
  const { doubtsAbout, priceJob, refineFormula } = await import('../src/pricing/formula.js');
  const hvac = {
    ...formula,
    minimumCents: null,
    roundToCents: 100,
    surcharges: [],
    services: [
      { name: 'Tune-ups', unit: 'units', rateCents: 15000, points: [], minimumCents: null },
      { name: 'Duct cleaning', unit: 'sq ft', rateCents: 25, points: [], minimumCents: null },
    ],
    addOns: [{ name: 'Blower cleaning', per: 'unit' as const, cents: 10900 }],
  };
  const tuneUp = (units: number) => ({
    service: 'Tune-ups',
    size: units,
    surcharges: [],
    addOns: [{ name: 'Blower cleaning', count: null }],
    otherServices: [],
  });
  const examples = [1, 2, 3].map((units) => ({
    parts: tuneUp(units),
    totalCents: units * 15000 + units * 10900,
  }));
  const refined = refineFormula(hvac, examples);
  const ducts = { ...tuneUp(1500), service: 'Duct cleaning' };
  const quote = priceJob(refined, ducts)!;
  assert.equal(
    quote.lines[1].amountCents,
    21800,
    'What it came to on the tune-ups it was quoted on',
  );
  // The other way round: per room, quoted only on rugs measured in square feet.
  const carpet = {
    ...refined,
    services: [{ name: 'Carpet', unit: 'rooms', rateCents: 6000, points: [], minimumCents: null }],
    addOns: [
      { name: 'Pet odor', per: 'unit' as const, cents: 5000, unit: 'sq ft', jobCents: 540000 },
    ],
  };
  const rooms = {
    service: 'Carpet',
    size: 5,
    surcharges: [],
    addOns: [{ name: 'Pet odor', count: null }],
    otherServices: [],
  };
  assert.equal(priceJob(carpet, rooms)?.lines[1].amountCents, 25000, 'The more modest reading');
  assert.ok(doubtsAbout(refined, examples, ducts, quote).some((doubt) => /other jobs/.test(doubt)));
});
