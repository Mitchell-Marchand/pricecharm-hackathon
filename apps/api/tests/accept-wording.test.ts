import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_WORDINGS, chanceBest, pickWording } from '../src/live/accept-wording.js';

/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shares(stats: Parameters<typeof pickWording>[0], picks = 4000) {
  const random = seeded(7);
  const counts = new Map<string, number>();
  for (let i = 0; i < picks; i++) {
    const { id } = pickWording(stats, random);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Map(ACCEPT_WORDINGS.map(({ id }) => [id, (counts.get(id) ?? 0) / picks]));
}

test('every accept-button wording is a plain yes that fits on a phone button', () => {
  for (const { label } of ACCEPT_WORDINGS) {
    assert.ok(label.length <= 24, label);
    assert.doesNotMatch(label, /\?/, 'A question would catch people who meant to ask something');
  }
});

test('with nothing to go on, each wording gets about the same share of quotes', () => {
  for (const [id, share] of shares([])) assert.ok(share > 0.18 && share < 0.32, `${id}: ${share}`);
});

test('a wording that gets more yeses gets most quotes, and the others keep being tried', () => {
  const stats = [
    { id: 'accept', seen: 400, accepted: 60 },
    { id: 'book', seen: 400, accepted: 160 },
    { id: 'works', seen: 400, accepted: 64 },
    { id: 'do_it', seen: 400, accepted: 56 },
  ];
  const picked = shares(stats);
  assert.ok(picked.get('book')! > 0.6, `book: ${picked.get('book')}`);
  for (const id of ['accept', 'works', 'do_it'])
    assert.ok(picked.get(id)! >= 0.08, `${id} still gets tried: ${picked.get(id)}`);
  const best = chanceBest(stats, 2000, seeded(3));
  assert.ok(best.get('book')! > 0.99);
  const total = [...best.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('a handful of answers is not enough to settle it', () => {
  const picked = shares([
    { id: 'book', seen: 3, accepted: 2 },
    { id: 'works', seen: 3, accepted: 1 },
  ]);
  for (const [id, share] of picked) assert.ok(share > 0.1, `${id}: ${share}`);
});
