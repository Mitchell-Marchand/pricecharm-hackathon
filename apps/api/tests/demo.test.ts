import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DEMOS } from '@quotefolk/trades/demos';
import { hasContactDetails } from '../src/demo.js';

test('demo replies and quote lines can’t carry links, emails or phone numbers', () => {
  for (const text of [
    'Book at https://example.com/pay',
    'Visit www.cheap-quotes.net today',
    'Pay at quotesnow.io',
    'Email me at someone@example.org',
    'Call (555) 123-4567 to confirm',
    'Text +1 555 123 4567',
  ])
    assert.equal(hasContactDetails(text), true, text);
  for (const text of [
    'About 600 sq ft, two cars',
    'Driveway wash, about 1,500 to 2,500 sq ft',
    'Pick 10 - 15 - 20 windows',
    'Pool, 15,000 to 25,000 gal',
    'Starts next week and takes 3 hours',
  ])
    assert.equal(hasContactDetails(text), false, text);
});

test('every demo sample photo is there, fits a real service and answers a real question', () => {
  const keys = new Set<string>();
  for (const demo of DEMOS) {
    if (!demo.photos) continue;
    for (const service of demo.photos.services)
      assert.ok(service in demo.prices, `${demo.tradeId}: ${service}`);
    for (const photo of demo.photos.items) {
      assert.ok(!keys.has(photo.key), `${photo.key} is used once`);
      keys.add(photo.key);
      assert.ok(
        existsSync(new URL(`../../web/public/demo-photos/${photo.key}.jpg`, import.meta.url)),
        `${photo.key}.jpg`,
      );
      assert.equal(hasContactDetails(photo.caption), false, photo.key);
    }
    if (demo.photos.shows)
      assert.ok(
        demo.extra?.options.some((option) => option.label === demo.photos?.shows?.answer),
        `${demo.tradeId}: ${demo.photos.shows.answer}`,
      );
  }
});
