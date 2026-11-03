import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDraft } from '../src/pricing/accuracy.js';
import { ownerChange, similarHistory } from '../src/pricing/history.js';
import { combineRates, MARKET_MIN_BUSINESSES } from '../src/pricing/market.js';
import {
  chargesLine,
  describeRate,
  estimateFor,
  estimateGap,
  fitRates,
  rateWords,
  withinEstimate,
  type PricePoint,
} from '../src/pricing/rates.js';
import { agentReadiness, serviceReadiness, type Comparison } from '../src/pricing/readiness.js';
import {
  priceStyle,
  priceText,
  pricedAs,
  rangeAround,
  rangeSpread,
  restyle,
} from '../src/pricing/style.js';
import type { Quote } from '../src/practice/types.js';
import { cleanSpec, describeSpec, specFromScenario } from '../src/pricing/spec.js';
import { canonicalUnit, formatQuantity, parseQuantity, roundSize } from '../src/pricing/units.js';
import { focusSituation, planSituation, SITUATIONS, type PlanInput } from '../src/practice/plan.js';
import type { DraftedQuote, PracticeScenario, Quote } from '../src/practice/types.js';
import { summarize } from '../src/replay.js';
import type { PricingHistory } from '../src/ai/quote-engine.js';

test('sizes come out of the way people write them', () => {
  const cases: [string, number, string][] = [
    ['Driveway wash, about 900 sq ft, with oil stain treatment.', 900, 'sq ft'],
    ['Back patio and walkway, about 600 square feet.', 600, 'sq ft'],
    ['2,000 sq ft house', 2000, 'sq ft'],
    ['Two-story house, 24 windows inside and out', 24, 'windows'],
    ['Single-story ranch, about 160 feet of gutter', 160, 'ft'],
    ['Quarter-acre lot, weekly mowing', 0.25, 'acres'],
    ['Rebuilt the stairs on a 12 by 16 deck', 192, 'sq ft'],
    ['Spring tune-up on two AC units and one furnace.', 2, 'units'],
    ['Four bedrooms and a hallway, pet stains', 4, 'bedrooms'],
    ['Front beds refreshed, 6 yards of mulch', 6, 'yards'],
    ['Somewhere between 20 to 25 windows', 22.5, 'windows'],
    ['Two-car driveway wash.', 2, 'cars'],
    ['Two-car driveway, about 800 sq ft. Moss along the edges.', 800, 'sq ft'],
    ['regular 2 car driveway, maybe 40 by 20', 800, 'sq ft'],
    ['3 bedroom house, 1,800 sq ft', 1800, 'sq ft'],
    ['3 bedrooms, 2 baths, about 1,800 sq ft', 3, 'bedrooms'],
    ['Detailed 2 cars, about 3 hours', 2, 'cars'],
    ['Half a truckload from a garage', 0.5, 'loads'],
  ];
  for (const [text, quantity, unit] of cases)
    assert.deepEqual(parseQuantity(text), { quantity, unit }, text);
  assert.equal(parseQuantity('Charged $250 for the whole thing'), null, 'Prices aren’t sizes');
  assert.equal(parseQuantity('Hung TVs and patched drywall'), null);
  assert.equal(canonicalUnit('Square Feet'), 'sq ft');
  assert.equal(canonicalUnit('banana'), null);
  assert.equal(formatQuantity(1, 'acres'), '1 acre');
  assert.equal(formatQuantity(1200, 'sq ft'), '1,200 sq ft');
  assert.equal(roundSize(2350), 2400);
  assert.equal(roundSize(115, 'up'), 150);
  assert.equal(roundSize(1830, 'down'), 1800);
  assert.equal(roundSize(3.5, 'up'), 4, 'Whole windows, rooms and cars');
});

const points = (service: string, unit: string, pairs: [number, number][]): PricePoint[] =>
  pairs.map(([quantity, cents]) => ({ service, unit, quantity, cents, source: 'job' }));

test('a rate card comes from the owner’s own prices, with a floor for small jobs', () => {
  const rates = fitRates([
    ...points('Driveways', 'sq ft', [
      [300, 15000],
      [600, 25000],
      [1000, 40000],
    ]),
    ...points('Windows', 'windows', [[20, 18000]]),
    { service: 'Driveways', unit: 'sq ft', quantity: 0, cents: 9000, source: 'job' },
  ]);
  const driveways = rates.find((rate) => rate.service === 'Driveways')!;
  assert.equal(driveways.points, 3, 'A size of zero is ignored');
  assert.ok(Math.abs(driveways.centsPerUnit - 41.67) < 0.01, 'The middle rate per square foot');
  assert.equal(driveways.floorCents, 15000);
  assert.equal(
    describeRate(driveways),
    'Driveways: about $0.42 per sq ft, lowest $150 (3 prices, 300 to 1,000 sq ft)',
  );
  // Once a formula prices the quotes, "lowest" is its minimum, or nothing when it has none.
  assert.equal(rateWords(driveways, 20000).price, 'about $0.42 per sq ft, lowest $200');
  assert.equal(rateWords(driveways, null).price, 'about $0.42 per sq ft');

  // A practice quote's rate line is worked out from the size it was priced at, not guessed.
  assert.equal(chargesLine(45000, 15, 'windows'), 'Charges about $30 per window');
  assert.equal(chargesLine(28000, 550, 'sq ft'), 'Charges about $0.51 per sq ft');
  assert.deepEqual(
    specFromScenario({
      facts: [
        { key: 'quantity', answer: 'There are 15 windows on the outside that need cleaning.' },
      ],
    } as PracticeScenario),
    { quantity: 15, unit: 'windows', condition: '', access: '', extras: [], timing: '' },
    'A size answer under any key, like the window practice customers give',
  );

  const usual = estimateFor(rates, 'driveways', 800, 'sq ft')!;
  assert.equal(usual.cents, 33300);
  assert.equal(usual.solid, true);
  assert.equal(
    estimateFor(rates, 'Driveways', 100, 'sq ft')!.cents,
    15000,
    'Never under the floor',
  );
  assert.equal(estimateFor(rates, 'Driveways', 5000, 'sq ft')!.solid, false, 'Far bigger');
  assert.equal(estimateGap(estimateFor(rates, 'Driveways', 5000, 'sq ft')!), 'bigger');
  assert.equal(estimateGap(estimateFor(rates, 'Driveways', 100, 'sq ft')!), 'smaller');
  assert.equal(estimateGap(usual), null);
  assert.equal(estimateFor(rates, 'Windows', 22, 'windows')!.solid, false, 'One job isn’t enough');
  assert.equal(estimateGap(estimateFor(rates, 'Windows', 22, 'windows')!), 'few');
  assert.equal(estimateFor(rates, 'Driveways', 800, 'windows'), null);
  assert.equal(estimateFor(rates, 'Driveways', null, 'sq ft'), null);
  assert.ok(withinEstimate(40000, usual), 'Add-ons can take it up');
  assert.ok(!withinEstimate(20000, usual), 'Far under the usual rate');
});

test('a minimum charged on two services isn’t read as a rate for either', () => {
  // The prod test: $150 is the least they charge, on 12 outside windows and on 8 inside ones.
  const rates = fitRates([
    ...points('Exterior windows', 'windows', [
      [12, 15000],
      [20, 20000],
      [30, 29000],
    ]),
    ...points('Interior windows', 'windows', [[8, 15000]]),
  ]);
  const exterior = rates.find((rate) => rate.service === 'Exterior windows')!;
  const interior = rates.find((rate) => rate.service === 'Interior windows')!;
  assert.ok(Math.abs(exterior.centsPerUnit - 983.33) < 0.01, 'The minimum job is left out');
  assert.equal(exterior.minimumOnly, false);
  assert.equal(interior.minimumOnly, true);
  assert.equal(estimateFor(rates, 'Interior windows', 6, 'windows')!.cents, 15000);
  assert.equal(estimateFor(rates, 'Interior windows', 22, 'windows'), null, 'Not $18.75 a window');
  assert.equal(
    describeRate(interior),
    'Interior windows: only the minimum so far, $150 (1 price, 8 windows)',
  );
  // One service's lowest price is just its lowest price.
  const alone = fitRates(points('Interior windows', 'windows', [[8, 15000]]))[0];
  assert.equal(alone.minimumOnly, false);
  assert.equal(alone.centsPerUnit, 1875);
});

test('other businesses’ rates only combine when there are enough of them', () => {
  const rates = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      businessId: `b${index}`,
      unit: 'sq ft',
      centsPerUnit: 30 + index * 5,
    }));
  assert.equal(combineRates(rates(MARKET_MIN_BUSINESSES - 1)), null);
  const many = [
    ...rates(MARKET_MIN_BUSINESSES),
    // One business with lots of jobs still counts once.
    ...Array.from({ length: 20 }, () => ({ businessId: 'b0', unit: 'sq ft', centsPerUnit: 500 })),
  ];
  const combined = combineRates(many)!;
  assert.equal(combined.businesses, MARKET_MIN_BUSINESSES);
  assert.equal(combined.unit, 'sq ft');
  assert.equal(
    combined.centsPerUnit,
    45,
    "Not 500, which twenty of one business's jobs would give",
  );
  // A first price starts a little above the middle: 35, 40, 45, 50, 500 gives 47.
  assert.equal(combined.upperCentsPerUnit, 47);
  assert.equal(combineRates(many, 'windows'), null);
});

test('job details read as fields and as a line for the owner', () => {
  const spec = cleanSpec({
    quantity: 600,
    unit: 'square feet',
    condition: 'heavy moss',
    access: '',
    extras: ['sealing', ''],
    timing: 'next week',
  });
  assert.deepEqual(spec, {
    quantity: 600,
    unit: 'sq ft',
    condition: 'heavy moss',
    access: '',
    extras: ['sealing'],
    timing: 'next week',
  });
  assert.equal(describeSpec(spec), '600 sq ft; heavy moss; adds: sealing; wants it next week');
  assert.equal(cleanSpec({ ...spec, quantity: 0 }).unit, '', 'No unit without a size');
  const scenario = {
    facts: [{ key: 'area', label: 'size', question: 'How big?', answer: 'Maybe 550 sq ft?' }],
  } as PracticeScenario;
  assert.equal(specFromScenario(scenario).quantity, 550);
  assert.equal(specFromScenario({ ...scenario, quantity: 18, unit: 'Windows' }).unit, 'windows');
});

test('after setup, practice goes to a service never priced, then everyday customers', () => {
  const base: PlanInput = {
    position: 3,
    setupCount: 3,
    services: ['Driveways', 'House wash'],
    examples: { driveways: 2, 'house wash': 0 },
    asked: [],
  };
  assert.equal(planSituation({ ...base, position: 1 }), SITUATIONS[1], 'Setup keeps its mix');
  assert.match(planSituation(base), /"House wash" service.*haven't priced/);

  // With no past jobs, setup walks through how they price: a usual job, the small end, a big one
  // with an extra, each other service, the two together, rough shape, then timing.
  const fresh = { ...base, pastJobs: 0, examples: {} };
  const plan = [0, 1, 2, 3, 4, 5, 6].map((position) => planSituation({ ...fresh, position }));
  assert.match(plan[0], /usual job for their "Driveways".*Clear/);
  assert.match(plan[1], /small "Driveways" job/);
  assert.match(plan[2], /big "Driveways" job.*extra/);
  assert.match(plan[3], /usual job for their "House wash"/);
  assert.match(plan[4], /"Driveways" and "House wash".*together/);
  assert.match(plan[5], /rough shape.*harder to reach/);
  assert.match(plan[6], /timing matters/);
  assert.match(
    planSituation({ ...fresh, position: 7, examples: { driveways: 2 } }),
    /"House wash" service.*haven't priced/,
  );
  const covered = { ...base, examples: { driveways: 2, 'house wash': 1 } };
  // Each draw below 0.3 says yes: the other service, an extra or two, bad shape, and so on.
  const draws =
    (...values: number[]) =>
    () =>
      values.shift() ?? 0.99;
  assert.equal(
    planSituation({ ...covered, random: draws(0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9) }),
    'An everyday customer for their "Driveways" service, like the ones they get all the time, with a job on the smaller side of their usual jobs for it. It’s in normal shape. No extras. If the work comes in versions, like materials or grades, they pick the one that suits them.',
  );
  const busy = planSituation({ ...covered, random: draws(0.9, 0.1, 0.9, 0.5, 0.1, 0.1, 0.1, 0.1) });
  assert.match(busy, /"Driveways" service.* in the middle .* rough shape.* harder to reach/);
  assert.match(busy, /two extras.*another of their services.*regular schedule/);
  assert.match(planSituation({ ...covered, random: draws(0.1, 0) }), /"House wash" service/);

  const driveways = points('Driveways', 'sq ft', [
    [500, 20000],
    [900, 32000],
  ]);

  // Practice for one service the owner picked goes after what that service still needs.
  assert.match(focusSituation('House wash', driveways), /"House wash" service, sized like a usual/);
  assert.match(
    focusSituation('Driveways', points('Driveways', 'sq ft', [[600, 25000]])),
    /a bit bigger than the one they've priced, around 900 sq ft/,
  );
  assert.match(focusSituation('driveways', driveways), /smaller "driveways" job .* 300 sq ft/);
  const three = [...driveways, ...points('Driveways', 'sq ft', [[1200, 42000]])];
  assert.match(
    focusSituation('Driveways', three),
    /usual "Driveways" job, around 900 sq ft/,
    'With enough sizes, a usual one checks its guess',
  );
});

const draft = (cents: number, decision: 'quote' | 'site_visit' = 'quote'): DraftedQuote => ({
  decision,
  reason: '',
  lines: [{ label: 'Driveway', amountCents: cents }],
  discount: null,
  start: '',
  duration: '',
  confidence: 'medium',
  reasoning: '',
});
const sent = (cents: number, label = 'Driveway') =>
  ({ lines: [{ id: 'a', label, amountCents: cents }], discount: null }) as unknown as Quote;

test('owner changes and the AI’s record on real quotes', () => {
  assert.equal(ownerChange(draft(31000), sent(35000)), "The owner changed the AI's $310 to $350.");
  assert.equal(ownerChange(draft(31000), sent(31000)), 'The owner sent the AI’s draft as it was.');
  assert.match(ownerChange(draft(31000), sent(31000, 'Driveway, 2 cars')), /reworded/);
  assert.match(ownerChange(draft(0, 'site_visit'), sent(20000)), /didn't price it/);

  assert.deepEqual(compareDraft(draft(31000), 35000), { draftCents: 31000, gap: 11, agree: true });
  assert.equal(compareDraft(draft(31000, 'site_visit'), 35000).agree, false);

  assert.deepEqual(
    summarize([
      {
        businessId: 'b',
        kind: 'live',
        number: 1,
        ownerCents: 100,
        draftCents: 90,
        gap: 10,
        agree: true,
      },
      {
        businessId: 'b',
        kind: 'live',
        number: 2,
        ownerCents: 100,
        draftCents: 50,
        gap: 50,
        agree: false,
      },
      {
        businessId: 'b',
        kind: 'practice',
        number: 1,
        ownerCents: null,
        draftCents: null,
        gap: null,
        agree: true,
      },
    ]),
    { quotes: 3, priced: 2, agreed: 2, medianGap: 30 },
  );
});

test('each service is trained once it has learned the owner’s prices for it', () => {
  const rates = fitRates([
    ...points('Driveways', 'sq ft', [
      [300, 15000],
      [600, 25000],
      [1000, 40000],
    ]),
    ...points('House wash', 'sq ft', [[2000, 45000]]),
  ]);
  // Oldest first: each one a day after the last.
  const drafts = (service: string, agrees: boolean[]): Comparison[] =>
    agrees.map((agree, index) => ({
      service,
      agree,
      at: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
    }));
  const check = (comparisons: Comparison[]) =>
    serviceReadiness(['Driveways', 'House wash', 'Patios'], rates, comparisons);

  let [driveways, house, patios] = check([]);
  assert.equal(driveways.ready, false, 'Prices alone aren’t enough');
  assert.equal(driveways.jobsToGo, 0);
  assert.equal(driveways.matchesToGo, 2);
  assert.equal(
    driveways.covers,
    '150 to 1,500 sq ft',
    'Half its smallest job to half again its largest',
  );
  assert.deepEqual([house.jobsToGo, house.covers], [2, ''], 'No sizes to stand behind yet');
  assert.equal(
    driveways.reason,
    'It needs to come within 15% of your price on 2 more Driveways jobs.',
  );
  assert.equal(house.reason, 'It needs 2 more House wash jobs with a size to know your prices.');
  assert.equal(patios.sizedPrices, 0);

  [driveways] = check(drafts('driveways', [true, true]));
  assert.equal(driveways.ready, true, 'Two close drafts, any spelling of the service');
  assert.equal(driveways.reason, '');
  assert.equal(driveways.matchesToGo, 0);
  [, house] = check(drafts('House wash', [true, true, true]));
  assert.equal(house.ready, false, 'Close drafts can’t make up for too few sized prices');

  [driveways] = check(drafts('Driveways', [true, true, false]));
  assert.equal(driveways.ready, true, 'One miss among the last three keeps it going');
  [driveways] = check(drafts('Driveways', [true, true, false, false]));
  assert.equal(driveways.ready, false, 'Two misses take it back to the owner');
  assert.equal(driveways.checked, 3);
  assert.equal(driveways.matched, 1);
  assert.equal(
    driveways.reason,
    'Its recent Driveways prices were off from yours. It needs to come within 15% of your price on 2 more Driveways jobs.',
    'One more match would still leave two misses among the last three',
  );
  [driveways] = check(drafts('Driveways', [false, false, true, true]));
  assert.equal(driveways.ready, true, 'Matching again brings it back');
  [driveways, house] = check([
    ...drafts('Driveways', [true, true]),
    ...drafts('House wash', [false, false, false]),
  ]);
  assert.equal(driveways.ready, true, 'Another service’s misses don’t count against it');

  // Readiness as a score: each service half sized jobs, half close guesses, weighted by workload.
  [driveways, house, patios] = check([]);
  assert.deepEqual(
    [driveways.progress, house.progress, patios.progress],
    [50, 17, 0],
    'Three sized jobs and no guesses yet is halfway',
  );
  const busy = { driveways: 10 };
  const practiceDriveways = { service: 'Driveways', action: 'practice', count: 2, gain: 21 };
  assert.deepEqual(agentReadiness([driveways, house, patios], busy), {
    score: 43,
    next: practiceDriveways,
    steps: [
      practiceDriveways,
      { service: 'House wash', action: 'job', count: 2, gain: 1 },
      { service: 'Patios', action: 'job', count: 3, gain: 1 },
    ],
  });
  [driveways, house, patios] = check(drafts('Driveways', [true, true]));
  assert.equal(driveways.progress, 100);
  const houseJobs = { service: 'House wash', action: 'job', count: 2, gain: 1 };
  assert.deepEqual(
    agentReadiness([driveways, house, patios], busy),
    {
      score: 85,
      next: houseJobs,
      steps: [houseJobs, { service: 'Patios', action: 'job', count: 3, gain: 1 }],
    },
    'Services they rarely do barely move it',
  );
  assert.equal(
    agentReadiness([house, patios], {}).score,
    8,
    'With no work yet, each counts the same',
  );
  assert.deepEqual(
    agentReadiness([driveways], busy),
    { score: 100, next: null, steps: [] },
    '100 only once every service is fully trained',
  );
});

test('a service still learning gets the price style the owner chose, then firm prices', () => {
  const settings = { trainedPercent: 60, learningStyle: 'range' as const };
  assert.equal(priceStyle(59, settings), 'range');
  assert.equal(priceStyle(60, settings), 'firm', 'At the mark it quotes firm');
  assert.equal(priceStyle(10, { ...settings, learningStyle: 'estimate' }), 'estimate');
  assert.equal(priceStyle(0, { ...settings, learningStyle: 'firm' }), 'firm');

  assert.equal(rangeSpread(0, 60), 0.25, 'Widest when it knows nothing');
  assert.equal(rangeSpread(60, 60), 0.1);
  assert.ok(rangeSpread(30, 60) < 0.25 && rangeSpread(30, 60) > 0.1);
  assert.deepEqual(rangeAround(42000, 0.1), { lowCents: 37000, highCents: 47000 });
  assert.deepEqual(
    rangeAround(165000, 0.25),
    { lowCents: 122500, highCents: 207500 },
    'Rounded outward to $25 under $2,000',
  );
  assert.deepEqual(rangeAround(900, 0.25), { lowCents: 900, highCents: 2000 }, 'Never below $10');
  assert.deepEqual(pricedAs('range', 0, 0.25), {}, 'No price, no range');

  const card = {
    number: 1,
    customer: 'Sam K.',
    place: '',
    issuedAt: '2026-10-27T00:00:00.000Z',
    lines: [{ id: 'l0', label: 'House wash', amountCents: 40000 }],
    discount: null,
    start: '',
    duration: '',
    included: [],
    excluded: [],
    validDays: 14,
    note: '',
    ...pricedAs('range', 40000, 0.1),
  } satisfies Quote;
  assert.equal(priceText(card, 40000), '$360 to $440');
  const raised = restyle({ ...card, lines: [{ ...card.lines[0], amountCents: 50000 }] }, undefined);
  assert.equal(priceText(raised, 50000), '$450 to $550', 'The range follows the owner’s price');
  const firm = restyle(card, 'firm');
  assert.equal(firm.style, undefined);
  assert.equal(firm.range, undefined);
  assert.equal(priceText(firm, 40000), '$400');
  assert.deepEqual(restyle(card, 'estimate').style, 'estimate');
});

test('a long history keeps the examples most like the request', () => {
  const job = (service: string, size: string) => ({
    service,
    description: service,
    priceCents: 10000,
    size,
    duration: '',
    when: '',
    materialsCents: null,
    discount: null,
    notes: '',
  });
  const history: PricingHistory = {
    business: { name: 'B', trade: 'Pressure washing', services: [], area: '', radiusMiles: null },
    pastJobs: [
      ...Array.from({ length: 40 }, () => job('House wash', '2,000 sq ft')),
      job('Driveways', '5,000 sq ft'),
      job('Driveways', '600 sq ft'),
      ...Array.from({ length: 20 }, () => job('House wash', '1,500 sq ft')),
    ],
    practice: [],
    liveQuotes: [],
    rates: [],
    notes: [],
  };
  const kept = similarHistory(history, 'Driveways', {
    quantity: 650,
    unit: 'sq ft',
    condition: '',
    access: '',
    extras: [],
    timing: '',
  });
  assert.equal(kept.pastJobs.length, 25);
  assert.deepEqual(
    kept.pastJobs.filter((item) => item.service === 'Driveways').map((item) => item.size),
    ['5,000 sq ft', '600 sq ft'],
    'Same service first, in their original order',
  );
  assert.equal(
    similarHistory({ ...history, pastJobs: history.pastJobs.slice(0, 10) }, 'x', null).pastJobs
      .length,
    10,
  );
});
