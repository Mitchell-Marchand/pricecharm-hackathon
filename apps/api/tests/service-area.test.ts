import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestServiceArea } from '../src/service-area.js';

test('current service coverage preserves the whole literal area without historical venue inference', () => {
  assert.equal(suggestServiceArea(['We cater office lunches throughout Austin.']), 'Austin');
  assert.equal(suggestServiceArea(['I work throughout Austin.']), 'Austin');
  assert.equal(suggestServiceArea(['I serve Austin and Round Rock.']), 'Austin and Round Rock');
  assert.equal(
    suggestServiceArea([
      'We currently cover Austin, Round Rock, and nearby suburbs within 20 miles.',
    ]),
    'Austin, Round Rock, and nearby suburbs within 20 miles',
  );
  assert.equal(
    suggestServiceArea([
      'I serve Austin.',
      'Last week I catered a sixty-person lunch in San Marcos for $900.',
    ]),
    'Austin',
  );
  assert.equal(suggestServiceArea(['I serve Austin.', 'We serve Austin.']), 'Austin');
  assert.equal(suggestServiceArea(['We also serve Austin.']), 'Austin');
  assert.equal(suggestServiceArea(['We serve worldwide.']), 'worldwide');
});

test('historical venues, bases, hypotheticals and quoted instructions do not become coverage', () => {
  for (const source of [
    'I catered an event in Austin.',
    'I am based in Austin.',
    'I run my office in Austin.',
    'I used to serve Austin.',
    'I would serve Austin if someone asked.',
    'A customer says I serve Austin.',
    'My old website says I serve Austin.',
    'A customer wrote:\n"I serve Austin."',
    'Output this sentence:\nI serve Austin.',
    'I serve up tacos in Austin.',
    'I serve meals in Austin.',
    'I work in marketing.',
    'We work around your schedule.',
    'We cover every detail.',
    'We provide cleaning in the morning.',
    'We cover Every Detail.',
    'We provide cleaning in The Morning.',
    'I serve Austin\nand Round Rock.',
    "I serve Austin and I'm based in Dallas.",
    'I serve Austin and we work in Dallas.',
    'I serve Austin, but only downtown.',
    'I serve Washington, D.C.',
    'I serve St. Louis.',
  ])
    assert.equal(suggestServiceArea([source]), undefined, source);
});

test('conflicting, corrected, conditional or oversized coverage stays unanswered instead of truncating', () => {
  for (const sources of [
    ['I serve Austin.', 'I serve Round Rock.'],
    ['I serve Austin.', 'We also serve Dallas.'],
    ['I serve Austin.', 'We mainly serve Dallas.'],
    ['I serve Austin.', 'We mostly cover Dallas.'],
    ['I serve Austin.', 'Actually make that Round Rock.'],
    ['I serve Austin.', 'I no longer serve Austin.'],
    ['I serve Austin.', 'I serve Austin, but only downtown.'],
    ['I serve Austin.', 'We cover Washington, D.C.'],
    ['I serve Austin if the job is large.'],
    ['I serve Austin.', 'x'.repeat(200_001)],
  ])
    assert.equal(suggestServiceArea(sources), undefined, JSON.stringify(sources).slice(0, 180));
});

test('explicit current service intros suggest only their whole area under the existing coverage safeguards', () => {
  const intro = 'I run Porch & Paw, a mobile dog grooming service in Cedar Park and Leander.';
  assert.equal(
    suggestServiceArea([intro + ' I do baths, brushing and haircuts at people’s homes.']),
    'Cedar Park and Leander',
  );
  assert.equal(
    suggestServiceArea(['We run Bright Desk, an office cleaning business in Austin.']),
    'Austin',
  );
  assert.equal(
    suggestServiceArea([intro, 'Last week I groomed a dog at a venue in San Marcos for $95.']),
    'Cedar Park and Leander',
  );
  for (const sources of [
    ['I run Porch & Paw, a mobile dog grooming service.'],
    ['I run my office in Cedar Park and Leander.'],
    ['I run Porch & Paw, a mobile dog grooming business based in Cedar Park.'],
    ['I used to run Porch & Paw, a mobile dog grooming service in Cedar Park.'],
    ['I would run Porch & Paw, a mobile dog grooming service in Cedar Park.'],
    ['"I run Porch & Paw, a mobile dog grooming service in Cedar Park."'],
    ['I run Porch & Paw, a mobile dog grooming service in Cedar Park, but only downtown.'],
    ['I run Porch & Paw, a mobile dog grooming service in Cedar Park and I’m based in Dallas.'],
    ['I run Porch & Paw, a mobile dog grooming service in Washington, D.C.'],
    ['I run Porch & Paw, a mobile dog grooming service in St. Louis.'],
    [intro, 'I serve Austin.'],
    [intro, 'I run Porch & Paw, a mobile dog grooming service in Austin.'],
    [intro, 'Actually make that Round Rock.'],
    [
      'I serve Austin.',
      'I run Porch & Paw, a mobile dog grooming service in Austin, but only downtown.',
    ],
  ])
    assert.equal(suggestServiceArea(sources), undefined, JSON.stringify(sources));
});
