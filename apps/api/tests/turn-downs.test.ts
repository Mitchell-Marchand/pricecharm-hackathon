import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAddress, looksLikeAddress } from '../src/live/chat.js';
import { withMinimum } from '../src/pricing/draft.js';
import { describeSpec, pooledLocation } from '../src/pricing/spec.js';
import {
  customerLine,
  leadDays,
  leadStart,
  priceTurnDown,
  ruleLine,
  sizeTurnDown,
  travelMiles,
  turnedDownReason,
  type TurnDownRule,
} from '../src/turn-downs.js';
import type { DraftedQuote } from '../src/practice/types.js';

const rule = (values: Partial<TurnDownRule> & Pick<TurnDownRule, 'kind'>): TurnDownRule => ({
  id: 'r1',
  size: null,
  sizeUnit: '',
  priceCents: null,
  distance: null,
  distanceUnit: null,
  days: null,
  text: '',
  fromRunId: null,
  ...values,
});

test('each turn-down reads the same to the owner and to the chat, and tells the customer why', () => {
  const small = rule({ kind: 'too_small', size: 200, sizeUnit: 'sq ft' });
  const cheap = rule({ kind: 'too_small', priceCents: 10000 });
  const big = rule({ kind: 'too_big', size: 5000, sizeUnit: 'sq ft' });
  const gutters = rule({ kind: 'not_offered', text: 'gutter repair' });
  const far = rule({ kind: 'too_far', distance: 25, distanceUnit: 'mi' });
  const busy = rule({ kind: 'lead_time', days: 7 });
  const other = rule({ kind: 'other', text: 'jobs with asbestos' });
  const austin = ['Austin, TX'];
  assert.equal(ruleLine(small, 'USD', austin), 'Jobs of 200 sq ft or less');
  assert.equal(ruleLine(cheap, 'USD', austin), 'Jobs that come to $100 or less');
  assert.equal(ruleLine(big, 'USD', austin), 'Jobs of 5,000 sq ft or more');
  assert.equal(ruleLine(gutters, 'USD', austin), 'Gutter repair');
  assert.equal(ruleLine(far, 'USD', austin), 'More than about 25 mi from Austin, TX');
  assert.equal(
    ruleLine(far, 'USD', ['Austin', 'Round Rock']),
    'More than about 25 mi from the nearest of your locations',
  );
  assert.equal(ruleLine(busy, 'USD', austin), 'Anything sooner than 7 days out');
  assert.equal(ruleLine(other, 'USD', austin), 'Jobs with asbestos');
  assert.equal(
    customerLine(gutters, 'Clear View'),
    'Sorry, Clear View doesn’t do gutter repair. Thanks for asking.',
  );
  assert.equal(
    customerLine(busy, 'Clear View'),
    'Sorry, Clear View can’t fit it in that soon. They book at least 7 days out.',
  );
  assert.equal(
    turnedDownReason(far, 'USD', austin),
    'Turned down: too far away (more than about 25 mi from Austin, TX).',
  );
  for (const line of [small, cheap, big, gutters, far, busy, other].map((item) =>
    customerLine(item, 'Clear View'),
  ))
    assert.doesNotMatch(line, /[—–]|\?$/, 'A plain no, with no dashes and no question');
});

test('sizes and prices are held to the owner’s lines by the server, in the rule’s own unit', () => {
  const rules = [
    rule({ id: 'small', kind: 'too_small', size: 200, sizeUnit: 'sq ft' }),
    rule({ id: 'big', kind: 'too_big', size: 5000, sizeUnit: 'sq ft' }),
    rule({ id: 'cheap', kind: 'too_small', priceCents: 10000 }),
  ];
  const spec = (quantity: number | null, unit: string) => ({
    quantity,
    unit,
    condition: '',
    access: '',
    extras: [],
    timing: '',
  });
  assert.equal(sizeTurnDown(rules, spec(150, 'sq ft'))?.id, 'small');
  assert.equal(sizeTurnDown(rules, spec(200, 'sq ft'))?.id, 'small', 'The size it was set at');
  assert.equal(sizeTurnDown(rules, spec(600, 'sq ft')), null);
  assert.equal(sizeTurnDown(rules, spec(6000, 'sq ft'))?.id, 'big');
  assert.equal(sizeTurnDown(rules, spec(150, 'windows')), null, 'Another unit says nothing');
  assert.equal(sizeTurnDown(rules, spec(null, '')), null, 'Nor does an unknown size');
  assert.equal(priceTurnDown(rules, 9000)?.id, 'cheap');
  assert.equal(priceTurnDown(rules, 25000), null);
  assert.equal(priceTurnDown(rules, 0), null, 'No price is not a small price');
  assert.equal(
    leadDays([rule({ kind: 'lead_time', days: 3 }), rule({ kind: 'lead_time', days: 10 })]),
    10,
  );
  assert.equal(leadDays(rules), null);
  assert.equal(leadStart(10), 'In 10 days or later');
  assert.equal(leadStart(1), 'Tomorrow or later');
  assert.equal(travelMiles([rule({ kind: 'too_far', distance: 40, distanceUnit: 'km' })]), 25);
  assert.equal(travelMiles(rules), null, 'No rule is no limit');
});

test('the owner’s minimum is a floor on the total, and a discount never goes under it', () => {
  const drafted = (amounts: number[], discount: DraftedQuote['discount'] = null): DraftedQuote => ({
    decision: 'quote',
    reason: '',
    lines: amounts.map((amountCents, index) => ({ label: `Line ${index}`, amountCents })),
    discount,
    start: '',
    duration: '',
    confidence: 'high',
    reasoning: 'From your rate.',
  });
  const raised = withMinimum(drafted([8000, 2000]), 15000);
  assert.deepEqual(
    raised.lines.map((line) => line.amountCents),
    [13000, 2000],
  );
  assert.match(raised.reasoning, /Raised to your \$150 minimum\./);
  const discounted = withMinimum(
    drafted([16000], { kind: 'percent', value: 20, reason: 'Neighbor' }),
    15000,
  );
  assert.deepEqual(discounted.discount, { kind: 'amount', value: 1000, reason: 'Neighbor' });
  assert.equal(withMinimum(drafted([20000]), 15000).lines[0].amountCents, 20000);
  const visit = { ...drafted([]), decision: 'site_visit' as const };
  assert.deepEqual(withMinimum(visit, 15000), visit, 'No price to raise');
  assert.equal(withMinimum(drafted([5000]), null).lines[0].amountCents, 5000);
});

test('where the job is: the area goes with the job, the street address stays with the owner', () => {
  assert.equal(pooledLocation('97214'), '972xx');
  assert.equal(pooledLocation('Portland, OR 97214-1234'), '972xx');
  assert.equal(pooledLocation('SW1A 1AA'), 'SW1A');
  assert.equal(pooledLocation('Eastgate'), 'Eastgate');
  assert.equal(pooledLocation('12 Elm Street'), '', 'A street number keeps nothing');
  assert.equal(pooledLocation(undefined), '');
  assert.match(
    describeSpec({
      quantity: 600,
      unit: 'sq ft',
      condition: '',
      access: '',
      extras: [],
      timing: '',
      location: 'Eastgate',
    }),
    /in Eastgate$/,
  );
  assert.equal(cleanAddress('  12 Elm\nStreet,\tPortland  '), '12 Elm Street, Portland');
  assert.equal(cleanAddress('   '), null);
  assert.throws(() => cleanAddress('x'.repeat(201)), /200 characters/);
  assert.equal(looksLikeAddress('41 Linden Avenue, Portland'), true);
  assert.equal(looksLikeAddress('Can you come at 9?'), false);
  assert.equal(looksLikeAddress('Thanks!'), false);
});
