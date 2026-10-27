import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDraft, liveReady, type ReviewedQuote } from '../src/pricing/accuracy.js';
import { ownerChange, similarHistory } from '../src/pricing/history.js';
import { combineRates, MARKET_MIN_BUSINESSES } from '../src/pricing/market.js';
import {
  describeRate,
  estimateFor,
  fitRates,
  withinEstimate,
  type PricePoint,
} from '../src/pricing/rates.js';
import { cleanSpec, describeSpec, specFromScenario } from '../src/pricing/spec.js';
import { canonicalUnit, formatQuantity, parseQuantity } from '../src/pricing/units.js';
import { planSituation, SITUATIONS, type PlanInput } from '../src/practice/plan.js';
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
    'Driveways: about $0.42 per sq ft, lowest $150 (3 jobs, 300 to 1,000 sq ft)',
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
  assert.equal(estimateFor(rates, 'Windows', 22, 'windows')!.solid, false, 'One job isn’t enough');
  assert.equal(estimateFor(rates, 'Driveways', 800, 'windows'), null);
  assert.equal(estimateFor(rates, 'Driveways', null, 'sq ft'), null);
  assert.ok(withinEstimate(40000, usual), 'Add-ons can take it up');
  assert.ok(!withinEstimate(20000, usual), 'Far under the usual rate');
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

test('practice aims where the AI knows least', () => {
  const base: PlanInput = {
    position: 3,
    setupCount: 3,
    services: ['Driveways', 'House wash'],
    points: points('Driveways', 'sq ft', [
      [500, 20000],
      [900, 32000],
    ]),
    examples: { driveways: 2, 'house wash': 0 },
    finished: [],
  };
  assert.equal(planSituation({ ...base, position: 1 }), SITUATIONS[1], 'Setup keeps its mix');
  assert.match(planSituation(base), /"House wash" service.*haven't priced/);
  const covered = { ...base, examples: { driveways: 2, 'house wash': 1 } };
  const miss = {
    service: 'Driveways',
    situation: SITUATIONS[0],
    siteVisit: false,
    gap: 30,
    confidence: 'medium',
  };
  assert.match(planSituation({ ...covered, finished: [miss] }), /^Another "Driveways" job/);
  assert.match(
    planSituation({ ...covered, finished: [{ ...miss, gap: 5 }] }),
    /bigger "Driveways" job .* around 1,800 sq ft/,
  );
  const afterBigger = [
    { ...miss, gap: 5 },
    { ...miss, gap: 5, situation: 'A bigger "Driveways" job than they\'ve priced so far.' },
  ];
  assert.match(
    planSituation({ ...covered, finished: afterBigger }),
    /small "Driveways" job, around 250 sq ft/,
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
  const record = (agreeing: number, total: number): ReviewedQuote[] =>
    Array.from({ length: total }, (_, index) => ({
      quoteId: String(index),
      customer: 'A',
      draftCents: 100,
      sentCents: 100,
      gap: 0,
      agree: index < agreeing,
    }));
  assert.equal(liveReady(record(4, 4)), null, 'Too few to decide');
  assert.equal(liveReady(record(8, 10)), true);
  assert.equal(liveReady(record(7, 10)), false);
  assert.equal(liveReady([...record(10, 10), ...record(0, 10)]), true, 'Only the latest ten');

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
