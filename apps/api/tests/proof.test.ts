import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accuracy, bestPrice, closer, countAccuracy, MIN_SAMPLE, share } from '../src/proof.js';

test('a replayed draft is held to its best price, even when it wanted a site visit', () => {
  const base = { businessId: 'b', kind: 'practice' as const, number: 1, ownerCents: 45000 };
  assert.deepEqual(
    bestPrice({
      ...base,
      draftCents: null,
      gap: null,
      agree: false,
      decision: 'site_visit',
      linesCents: 31300,
    }),
    { gap: 30 },
  );
  assert.deepEqual(
    bestPrice({ ...base, draftCents: null, gap: null, agree: false, linesCents: null }),
    { gap: null },
  );
});

test('accuracy counts a job with no AI price as a miss', () => {
  assert.deepEqual(accuracy([{ gap: 4 }, { gap: 12 }, { gap: 30 }, { gap: null }]), {
    jobs: 4,
    priced: 3,
    within10: 1,
    within15: 2,
    medianGap: 12,
  });
  assert.deepEqual(accuracy([]), {
    jobs: 0,
    priced: 0,
    within10: 0,
    within15: 0,
    medianGap: null,
  });
});

test('no percentage from too few jobs', () => {
  assert.equal(share(3, 4), '3 of 4');
  assert.equal(share(17, MIN_SAMPLE), `17 of ${MIN_SAMPLE} (85%)`);
});

test('who came closer to the owner, with no price losing to any price', () => {
  assert.deepEqual(
    closer([
      { charm: { gap: 3 }, generic: { gap: 40 } },
      { charm: { gap: 25 }, generic: { gap: 10 } },
      { charm: { gap: null }, generic: { gap: 60 } },
      { charm: { gap: 5 }, generic: { gap: 5 } },
      { charm: { gap: null }, generic: { gap: null } },
    ]),
    { charm: 1, generic: 2, tied: 2 },
  );
});

test('counts against hand counts, with not counted at all as zero', () => {
  assert.deepEqual(
    countAccuracy([
      { truth: 19, counted: 19 },
      { truth: 10, counted: 11 },
      { truth: 8, counted: 4 },
      { truth: 5, counted: null },
    ]),
    // Misses of 0, 1, 4 and 5: 0%, 10%, 50% and 100%, averaging 40%.
    { videos: 4, exact: 1, withinOne: 2, averageMissPercent: 40 },
  );
});
