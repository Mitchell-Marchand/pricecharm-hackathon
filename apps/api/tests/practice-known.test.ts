import test from 'node:test';
import assert from 'node:assert/strict';
import { knownSpec, photoLines, saidSpec } from '../src/practice/known.js';
import type { PracticeScenario } from '../src/practice/types.js';

const oak: PracticeScenario = {
  firstName: 'Emma',
  lastInitial: 'R',
  place: 'South Austin',
  serviceName: 'Trimming',
  quantity: 1,
  unit: 'trees',
  opener: 'Can I get a price on this? Photos attached.',
  facts: [
    {
      key: 'count',
      label: 'the number of trees',
      question: 'How many trees?',
      answer: 'Just the one little oak out front.',
      visible: true,
    },
    {
      key: 'cleanup',
      label: 'cleanup and haul-away',
      question: 'Haul away the branches?',
      answer: 'Yes please haul it all away.',
    },
  ],
  photos: [],
  extraPhoto: { scene: 'Back', text: 'Here’s the back.', photoId: null },
  suggestions: [],
  siteVisitLikely: false,
  siteVisitCue: '',
  acceptReply: 'Great.',
  siteVisitReply: 'Sure.',
};

test('the job as the owner knew it: what was asked and what the photos show, nothing else', () => {
  // The photos show one oak, so the owner knew the size without asking.
  assert.equal(knownSpec(oak, []).quantity, 1);
  // A live chat only has the size once the customer says it; the photos come from its reading.
  assert.equal(saidSpec(oak, []).quantity, null);
  assert.equal(saidSpec(oak, ['count']).quantity, 1);
  // What the photos showed goes with the job for the formula to read. What they asked is in the chat.
  assert.deepEqual(photoLines(oak, []), [
    'In the photos, the number of trees: Just the one little oak out front.',
  ]);
  assert.deepEqual(photoLines(oak, ['count']), []);

  // A size the customer never said and the photos don't show isn't something the owner knew.
  const hidden = { ...oak, facts: oak.facts.map((fact) => ({ ...fact, visible: false })) };
  hidden.facts[1].visible = true;
  assert.equal(knownSpec(hidden, []).quantity, null);
  assert.equal(knownSpec(hidden, ['count']).quantity, 1);
});

test('customers with no marked photos, like the benchmark’s, say everything up front', () => {
  const bench: PracticeScenario = { ...oak, facts: [] };
  assert.equal(knownSpec(bench, []).quantity, 1);
  assert.equal(saidSpec(bench, []).quantity, 1);
  assert.deepEqual(photoLines(bench, []), []);
  const unmarked = { ...oak, facts: oak.facts.map(({ visible: _visible, ...fact }) => fact) };
  assert.equal(knownSpec(unmarked, []).quantity, 1, 'Customers from before photos were marked');
});
