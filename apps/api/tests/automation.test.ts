import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessEligibility,
  evaluateService,
  calculatePrice,
  servicePatchSchema,
  type Business,
  type Service,
  type Example,
  type TestCase,
} from '../src/domain.js';

const business: Business = {
  id: 'tenant',
  name: 'Exterior services',
  slug: 'exterior',
  industry: 'Cleaning',
  description: 'Concrete washing',
  serviceArea: 'Austin',
  currency: 'USD',
  autoQuoteEnabled: true,
  onboardingComplete: true,
  createdAt: new Date().toISOString(),
};
const service: Service = {
  id: 'service',
  businessId: business.id,
  name: 'Concrete washing',
  description: 'Standard concrete driveway cleaning',
  unitLabel: 'square feet',
  unitPriceCents: 25,
  basePriceCents: 2000,
  minimumChargeCents: 10000,
  maxAutoQuoteCents: 20000,
  requiredInputs: ['area', 'surface'],
  exclusions: ['Roof cleaning'],
  mode: 'automatic',
  publishedAt: new Date().toISOString(),
  approvedVersion: 1,
  version: 1,
};
const good = {
  quantity: 500,
  description: 'A standard concrete driveway',
  inputs: { area: '500', surface: 'concrete', location: 'Austin' },
};
test('partial pricing changes never reset omitted rates, scope or conditions to create defaults', () => {
  assert.deepEqual(servicePatchSchema.parse({ unitPriceCents: 30 }), { unitPriceCents: 30 });
  assert.deepEqual(servicePatchSchema.parse({ name: 'Updated name', expectedVersion: 5 }), {
    name: 'Updated name',
    expectedVersion: 5,
  });
  assert.equal(servicePatchSchema.safeParse({}).success, false);
});
test('automatic eligibility requires facts, coherent measurement, area, scope and amount even if AI says safe', () => {
  assert.equal(assessEligibility(service, business, good).eligible, true);
  for (const input of [
    { ...good, inputs: { area: '500', location: 'Austin' } },
    { ...good, inputs: { ...good.inputs, surface: 'unknown' } },
    { ...good, inputs: { ...good.inputs, location: 'Dallas' } },
    { ...good, description: 'Please clean my roof' },
    { ...good, inputs: { ...good.inputs, scope: 'Roof cleaning' } },
    { ...good, quantity: 900, inputs: { ...good.inputs, area: '900' } },
    { ...good, quantity: 1 },
    { ...good, inputs: { ...good.inputs, area: 'N/A' } },
    { ...good, inputs: { ...good.inputs, area: '500-600' } },
    {
      ...good,
      quantity: 1,
      inputs: { surface: 'concrete', location: 'Austin', 'square footage': '500' },
    },
  ])
    assert.equal(
      assessEligibility(service, business, {
        ...input,
        analysis: { needsReview: false, missingInputs: [], reviewReason: '' },
      }).eligible,
      false,
    );
  assert.equal(
    assessEligibility(service, business, {
      ...good,
      analysis: { needsReview: true, missingInputs: [], reviewReason: 'An exception needs review' },
    }).eligible,
    false,
  );
});
test('unit-related descriptive fields are not mistaken for quantity while count conflicts require review', () => {
  const windows: Service = {
    ...service,
    name: 'Window cleaning',
    description: 'Standard residential window cleaning',
    unitLabel: 'window',
    unitPriceCents: 900,
    basePriceCents: 0,
    minimumChargeCents: 12000,
    maxAutoQuoteCents: 50000,
    requiredInputs: ['number of windows', 'window tracks condition'],
    exclusions: [],
    pricingRules: [
      {
        id: 'tracks',
        name: 'Inspect restoration work',
        field: 'window tracks condition',
        operator: 'not_equals',
        value: 'normal',
        kind: 'review',
        amount: 0,
      },
    ],
  };
  const input = {
    quantity: 18,
    description: 'Clean 18 residential windows with normal tracks.',
    inputs: {
      'number of windows': '18',
      'window tracks condition': 'normal',
      location: 'Austin',
    },
    analysis: { needsReview: false, missingInputs: [], reviewReason: '' },
  };
  const eligible = assessEligibility(windows, business, input);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.calculated.totalCents, 16200);
  for (const count of ['17', 'unknown']) {
    const review = assessEligibility(windows, business, {
      ...input,
      inputs: { ...input.inputs, 'number of windows': count },
    });
    assert.equal(review.eligible, false);
    assert.ok(
      review.reasons.includes(
        'The pricing quantity and supplied measurement need owner confirmation.',
      ),
    );
  }
});
test('conditional adjustments preserve cents arithmetic and review rules cannot be bypassed by missing inputs', () => {
  const scoped = {
    ...service,
    pricingRules: [
      {
        id: 'staining',
        name: 'Heavy staining',
        field: 'staining',
        operator: 'equals' as const,
        value: 'heavy',
        kind: 'fixed' as const,
        amount: 3000,
      },
      {
        id: 'surface',
        name: 'Inspect unusual surfaces',
        field: 'surface',
        operator: 'not_equals' as const,
        value: 'concrete',
        kind: 'review' as const,
        amount: 0,
      },
    ],
  };
  assert.equal(
    calculatePrice(scoped, 500, { ...good.inputs, staining: 'heavy' }).totalCents,
    17500,
  );
  assert.equal(
    assessEligibility(scoped, business, { ...good, inputs: { ...good.inputs, staining: 'heavy' } })
      .eligible,
    true,
  );
  assert.equal(assessEligibility(scoped, business, good).eligible, false);
  assert.equal(
    assessEligibility(scoped, business, {
      ...good,
      inputs: { ...good.inputs, staining: 'light', surface: 'wood' },
    }).eligible,
    false,
  );
});
test('teaching agreement alone cannot authorize automatic publishing; independent prices and handoffs must pass', () => {
  const examples: Example[] = [400, 500, 600].map((quantity, index) => ({
    id: `example${index}`,
    businessId: business.id,
    serviceId: service.id,
    title: `Teaching ${index}`,
    description: `Historical driveway ${index}`,
    quantity,
    finalPriceCents: 2000 + quantity * 25,
    rationale: 'Area rate',
    source: 'historical',
    createdAt: new Date().toISOString(),
  }));
  const independent: TestCase[] = [400, 500, 600].map((quantity, index) => ({
    id: `case${index}`,
    serviceId: service.id,
    title: `Independent ${index}`,
    description: `Different concrete patio ${index}`,
    quantity,
    expectedCents: 2000 + quantity * 25,
    inputs: { area: String(quantity), surface: 'concrete', location: 'Austin' },
    toleranceCents: 100,
    tolerancePercent: 5,
    expectedOutcome: 'quote',
    createdAt: new Date().toISOString(),
  }));
  const boundary: TestCase = {
    ...independent[0],
    id: 'boundary',
    title: 'Excluded roof',
    description: 'Roof cleaning',
    expectedCents: 0,
    expectedOutcome: 'review',
  };
  assert.equal(evaluateService(service, examples, business).configurationPassed, true);
  assert.equal(evaluateService(service, examples, business).automaticReady, false);
  assert.equal(evaluateService(service, examples, business, independent).automaticReady, false);
  const passing = evaluateService(service, examples, business, [...independent, boundary]);
  assert.equal(passing.deterministicReady, true);
  assert.equal(
    passing.automaticReady,
    false,
    'The calculator alone cannot approve the inquiry model',
  );
  assert.equal(passing.independentCaseCount, 4);
  assert.equal(passing.serviceVersion, service.version);
  assert.equal(
    evaluateService(service, examples, business, [
      { ...independent[0], expectedCents: 30000 },
      ...independent.slice(1),
      boundary,
    ]).deterministicReady,
    false,
  );
  assert.equal(
    evaluateService(service, examples, business, [
      ...independent,
      { ...boundary, expectedOutcome: 'quote' },
    ]).deterministicReady,
    false,
  );
});
