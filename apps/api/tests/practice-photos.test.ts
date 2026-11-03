import test from 'node:test';
import assert from 'node:assert/strict';
import { notesFor, type Walkaround } from '../src/ai/walkaround.js';
import { spendRefusal } from '../src/practice-library.js';
import { demoPhotoReading, demoReply, demoScenario } from '../src/practice/demo.js';
import {
  distanceOf,
  drawDistance,
  fixedReading,
  noFixes,
  ownerReading,
  readingNotes,
  reconcileScenario,
  swapNumber,
} from '../src/practice/photo-facts.js';
import type { PracticeScenario } from '../src/practice/types.js';
import { specFromScenario } from '../src/pricing/spec.js';

function reading(parts: Partial<Walkaround>): Walkaround {
  const read = {
    source: 'photos' as const,
    summary: 'The front of a two-story house with screens on.',
    narration: '',
    serviceName: 'Exterior windows',
    counts: [],
    area: null,
    quantity: null,
    unit: '',
    condition: '',
    access: 'second story',
    extras: [],
    findings: [],
    overlays: [],
    ...parts,
  };
  return { ...read, notes: notesFor(read) };
}

const windows: PracticeScenario = {
  firstName: 'Dana',
  lastInitial: 'R',
  place: 'Northside',
  serviceName: 'Exterior windows',
  quantity: 18,
  unit: 'windows',
  opener: 'pics attached, how much?',
  facts: [
    {
      key: 'size',
      label: 'how many windows',
      question: 'How many windows?',
      answer: 'About 18 windows, 6 of them upstairs.',
      visible: true,
    },
    {
      key: 'skylights',
      label: 'skylights',
      question: 'Any skylights?',
      answer: 'Yeah, 3 skylights on the back.',
      visible: true,
    },
    {
      key: 'timing',
      label: 'timing',
      question: 'When do you need it?',
      answer: 'Before the 18th if you can. We have 18 people coming.',
    },
  ],
  photos: [{ scene: 'Front of the house', photoId: 'a' }],
  extraPhoto: { scene: 'Back', text: 'Here’s the back.', photoId: 'b' },
  suggestions: ['Exterior windows, 18 windows', 'Screens'],
  siteVisitLikely: false,
  siteVisitCue: '',
  acceptReply: 'Great.',
  siteVisitReply: 'Sure.',
};

const counted = (label: string, count: number, more: object = {}) => ({
  label,
  phrase: label.replace(/s$/, ''),
  unit: label,
  count,
  sparkCount: count,
  ...more,
});

test('photos that disagree with the customer are reported, and what the customer said stands', () => {
  const { scenario, changes } = reconcileScenario(
    windows,
    reading({ counts: [counted('windows', 15), counted('skylights', 2)] }),
  );
  assert.equal(scenario, windows, 'Nothing about the customer changes');
  assert.deepEqual(changes, ['windows: says 18, photos show 15']);

  const same = reconcileScenario(windows, reading({ counts: [counted('windows', 18)] }));
  assert.deepEqual(same.changes, []);
});

test('the tree test: one oak, a reader that counts two, and the customer still says one', () => {
  const oak: PracticeScenario = {
    ...windows,
    serviceName: 'Trimming',
    quantity: 1,
    unit: 'trees',
    facts: [
      {
        key: 'count',
        label: 'the number of trees',
        question: 'How many trees need trimming?',
        answer: 'Just the one little oak out front.',
        visible: true,
      },
    ],
    suggestions: ['Trim one oak'],
  };
  const { scenario, changes } = reconcileScenario(oak, reading({ counts: [counted('trees', 2)] }));
  assert.equal(scenario.quantity, 1);
  assert.equal(scenario.facts[0].answer, 'Just the one little oak out front.');
  assert.deepEqual(changes, ['trees: says 1, photos show 2']);
});

test('a surface the customer gave is reported only when it’s well outside what the photos show', () => {
  const patio: PracticeScenario = {
    ...windows,
    serviceName: 'Patios & pavers',
    quantity: 700,
    unit: 'sq ft',
    facts: [
      {
        key: 'size',
        label: 'size',
        question: 'How big?',
        answer: 'Around 700 sq ft.',
        visible: true,
      },
    ],
    suggestions: ['Patio wash, about 700 sq ft'],
  };
  const read = reading({
    area: { surface: 'patio', low: 450, high: 550, unit: 'sq ft', basis: 'the table' },
  });
  const far = reconcileScenario(patio, read);
  assert.equal(far.scenario.quantity, 700);
  assert.deepEqual(far.changes, ['sq ft: says 700, photos show 500']);
  assert.deepEqual(
    reconcileScenario({ ...patio, quantity: 650 }, read).changes,
    [],
    'Inside the range, give or take, there’s nothing to report',
  );
});

test('the owner’s fix is taken exactly, and only what they fixed moves', () => {
  const read = reading({
    counts: [counted('windows', 15), counted('skylights', 2)],
    quantity: 15,
    unit: 'windows',
  });
  const fixes = { counts: { windows: 20 }, area: null, note: 'Screens are off.' };
  const next = reconcileScenario(
    { ...windows, quantity: 15, facts: [{ ...windows.facts[0], answer: 'About 15 windows.' }] },
    ownerReading(read, fixes),
    { exact: true },
  ).scenario;
  assert.equal(next.quantity, 20);
  assert.equal(next.facts[0].answer, 'About 20 windows.');

  const fixed = fixedReading(read, fixes);
  assert.equal(fixed.counts[0].count, 20);
  assert.equal(fixed.quantity, 20);
  assert.deepEqual(
    readingNotes(read, fixes),
    [
      "The owner counted 20 windows in the customer's photos.",
      "The customer's photos show 2 skylights, each one found and checked in the photos.",
      'Getting to it, from the photos: second story.',
      'The photos show: The front of a two-story house with screens on.',
      "The owner says about the customer's photos: Screens are off.",
    ],
    'Their count is said as theirs, and their note goes in as written',
  );
  assert.deepEqual(readingNotes(read, noFixes()), read.notes, 'With nothing fixed, as read');
  assert.deepEqual(readingNotes(read, null), read.notes);
});

test('numbers are swapped whole, never inside a price or a longer number', () => {
  assert.equal(
    swapNumber('About 18 windows, $18 each, 180 total', 18, 15),
    'About 15 windows, $18 each, 180 total',
  );
  assert.equal(swapNumber('1,200 sq ft', 1200, 900), '900 sq ft');
  assert.equal(swapNumber('no size here', 18, 15), null);
});

test('practice customers are a believable distance away, in miles or km by currency', () => {
  const draws = [0.1, 0.8, 0.95].map((band) => {
    let call = 0;
    return drawDistance('USD', 'Boise, ID', () => (call++ ? 0.5 : band));
  });
  assert.deepEqual(
    draws.map((distance) => distance.value),
    [7, 19, 35],
    'Most nearby, now and then far enough to turn down',
  );
  assert.deepEqual(draws[0], { value: 7, unit: 'mi', from: 'Boise, ID' });
  assert.deepEqual(distanceOf(10, 'EUR'), { value: 16, unit: 'km' });
  assert.deepEqual(distanceOf(0.2, 'USD'), { value: 1, unit: 'mi' }, 'Never 0 away');
  for (let index = 0; index < 200; index++) {
    const distance = drawDistance('CAD');
    assert.equal(distance.unit, 'km');
    assert.ok(distance.value >= 3 && distance.value <= 73, String(distance.value));
  }
});

test('demo customers send the prepared photo first, then take one, then have no more', () => {
  const scenario = demoScenario(0, ['Patios & pavers']);
  const first = demoReply(scenario, 'Can you send a closer photo?', {
    photoAvailable: true,
    preparedPhoto: true,
    turn: 1,
  });
  assert.equal(first.sendPhoto, true);
  assert.equal(first.photoScene, '', 'The prepared one goes straight away');
  assert.equal(first.reply, scenario.extraPhoto.text);
  const second = demoReply(scenario, 'Any more pictures?', {
    photoAvailable: true,
    preparedPhoto: false,
    turn: 2,
  });
  assert.equal(second.sendPhoto, true);
  assert.equal(second.photoScene, 'patio-overview');
  assert.equal(second.reply, 'Sure, give me a minute.');
  const third = demoReply(scenario, 'Another photo?', {
    photoAvailable: false,
    preparedPhoto: false,
    turn: 3,
  });
  assert.equal(third.sendPhoto, false);
  assert.match(third.reply, /all the photos/);

  // Demo mode's reading of the bundled photos, labelled as such.
  const read = demoPhotoReading(scenario);
  assert.match(read.summary, /^\[Demo\] /);
  assert.equal(read.quantity, 550);
  assert.ok(read.notes.some((note) => note.includes('500 to 600 sq ft')));
});

test('the library script won’t spend on paid models unless told to', () => {
  assert.match(spendRefusal('live', false, 3) ?? '', /--spend/);
  assert.equal(spendRefusal('live', true, 3), null);
  assert.equal(spendRefusal('demo', false, 3), null, 'Demo mode spends nothing');
});
