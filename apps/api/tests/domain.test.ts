import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePrice,
  quantitySchema,
  serviceCreateSchema,
  evaluateService,
  isBillableQuote,
  proposeUnitPrice,
  publicService,
  samePricingUnit,
  type Service,
  type Business,
  type Example,
} from '../src/domain.js';

const service: Service = {
  id: 'service',
  businessId: 'tenant',
  name: 'Cleaning',
  description: 'Standard cleaning only',
  unitLabel: 'square feet',
  unitPriceCents: 25,
  minimumChargeCents: 10000,
  basePriceCents: 2000,
  maxAutoQuoteCents: 100000,
  requiredInputs: ['area'],
  exclusions: ['Restoration'],
  mode: 'review',
  version: 1,
  publishedAt: null,
};
const business: Business = {
  id: 'tenant',
  name: 'Test',
  slug: 'test',
  industry: 'Cleaning',
  description: 'Exterior cleaning',
  serviceArea: 'Austin',
  currency: 'USD',
  onboardingComplete: true,
  autoQuoteEnabled: false,
  createdAt: new Date().toISOString(),
};
test('integer pricing applies base, unit charge and minimum without floating point drift', () => {
  const result = calculatePrice(service, 500);
  assert.equal(result.totalCents, 14500);
  assert.equal(
    result.lineItems.reduce((sum, line) => sum + line.totalCents, 0),
    14500,
  );
  assert.equal(calculatePrice(service, 2).totalCents, 10000);
  assert.equal(
    calculatePrice(
      { ...service, basePriceCents: 0, minimumChargeCents: 0, unitPriceCents: 1005 },
      0.1,
    ).totalCents,
    101,
  );
  assert.equal(
    calculatePrice(
      { ...service, basePriceCents: 0, minimumChargeCents: 0, unitPriceCents: 15 },
      0.1,
    ).totalCents,
    2,
  );
});
test('quantity, money, total ceiling and precision cannot bypass pricing constraints', () => {
  for (const value of [-1, 0, NaN, Infinity, 0.0001, 10_000_001])
    assert.equal(quantitySchema.safeParse(value).success, false);
  assert.throws(() => calculatePrice({ ...service, unitPriceCents: 100_000_000 }, 100));
  assert.equal(
    serviceCreateSchema.safeParse({ name: 'Price', unitPriceCents: 1.2 }).success,
    false,
  );
  assert.equal(
    serviceCreateSchema.safeParse({ name: 'Price', minimumChargeCents: -1 }).success,
    false,
  );
  assert.equal(
    serviceCreateSchema.safeParse({ name: 'Price', businessId: 'different tenant' }).success,
    false,
  );
});
test('publication checks require representative evidence and fail material underquotes', () => {
  const examples = [400, 500, 600].map((quantity, index): Example => ({
    id: String(index),
    businessId: 'tenant',
    serviceId: 'service',
    title: `Job${index}`,
    description: 'Normal job',
    quantity,
    finalPriceCents: calculatePrice(service, quantity).totalCents,
    rationale: 'Standard scope',
    source: 'historical',
    createdAt: new Date().toISOString(),
  }));
  assert.equal(evaluateService(service, examples, business).passed, true);
  assert.equal(samePricingUnit('square feet', 'sqft'), true);
  const wrongUnits = evaluateService(
    service,
    examples.map((example) => ({ ...example, unitLabel: 'project' })),
    business,
  );
  assert.equal(wrongUnits.passed, false);
  assert.equal(wrongUnits.cases.length, 0, 'Old project counts must not become square feet');
  assert.equal(
    wrongUnits.checks.find((check) => check.name === 'Representative examples')?.passed,
    false,
  );
  assert.equal(evaluateService(service, examples.slice(0, 2), business).passed, false);
  assert.equal(
    evaluateService(
      service,
      [{ ...examples[0], finalPriceCents: 40000 }, ...examples.slice(1)],
      business,
    ).passed,
    false,
  );
  assert.equal(evaluateService(service, examples, { ...business, serviceArea: '' }).passed, false);
});
test('customer metadata omits private prices, tenant IDs and thresholds', () => {
  const safe = publicService(service);
  assert.equal('businessId' in safe, false);
  assert.equal('unitPriceCents' in safe, false);
  assert.equal('minimumChargeCents' in safe, false);
  assert.equal('maxAutoQuoteCents' in safe, false);
  assert.equal('pricingRules' in safe, false);
  assert.equal(safe.pricingQuantityRequired, true);
  const intake: Service = {
    ...service,
    unitPriceCents: 0,
    basePriceCents: 0,
    minimumChargeCents: 0,
    pricingRules: [],
  };
  assert.equal(publicService(intake).pricingQuantityRequired, false);
  const inspection = {
    id: 'inspection',
    name: 'Inspect visible damage',
    field: 'Visible damage',
    operator: 'equals' as const,
    value: 'yes',
    kind: 'review' as const,
    amount: 0,
  };
  assert.equal(
    publicService({ ...intake, pricingRules: [inspection] }).pricingQuantityRequired,
    false,
  );
  assert.equal(
    publicService({ ...intake, pricingRules: [{ ...inspection, kind: 'fixed', amount: 100 }] })
      .pricingQuantityRequired,
    true,
  );
  assert.equal(publicService({ ...intake, mode: 'automatic' }).pricingQuantityRequired, true);
});
test('teaching produces a proposal for explicit approval without mutating policy', () => {
  const proposal = proposeUnitPrice(service, 500, 17000);
  assert.equal(proposal?.unitPriceCents, 30);
  assert.equal(service.unitPriceCents, 25);
  assert.equal(
    proposeUnitPrice(service, 20, 10000),
    undefined,
    'a minimum charge cannot establish the per-unit rate',
  );
});
test('only a verified autonomous production issuance is billable', () => {
  const eligible = { source: 'live', verifiedContact: true, automatic: true, status: 'issued' };
  assert.equal(isBillableQuote(eligible), true);
  for (const source of ['playground', 'training', 'historical'])
    assert.equal(isBillableQuote({ ...eligible, source }), false);
  assert.equal(isBillableQuote({ ...eligible, verifiedContact: false }), false);
  assert.equal(isBillableQuote({ ...eligible, automatic: false }), false);
  assert.equal(isBillableQuote({ ...eligible, status: 'review' }), false);
});
