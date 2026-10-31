import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DEMOS } from '@pricecharm/trades/demos';
import { fitsReady, plainDashes, readyLine } from '../src/ai/intake.js';
import { hasContactDetails } from '../src/demo.js';

test('the last word before a quote says it’s coming now, not that someone will be in touch', () => {
  for (const text of [readyLine(), readyLine(true), 'Thanks! Putting your quote together now.'])
    assert.equal(fitsReady(text), true, text);
  for (const text of [
    'Thanks! I’ll put your quote together and be in touch shortly.',
    'Great, we’ll get back to you with a price soon.',
    'Perfect. Someone will reach out to confirm.',
    'Thanks! Anything else I should know?',
  ])
    assert.equal(fitsReady(text), false, text);
});

test('chat replies use commas where the model writes dashes, and keep number ranges', () => {
  assert.equal(plainDashes('Thanks — how many windows?'), 'Thanks, how many windows?');
  assert.equal(plainDashes('Great—one story or two?'), 'Great, one story or two?');
  assert.equal(plainDashes('About $150 — does that work?'), 'About $150, does that work?');
  assert.equal(plainDashes('It takes 2–3 days.'), 'It takes 2–3 days.');
});

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
