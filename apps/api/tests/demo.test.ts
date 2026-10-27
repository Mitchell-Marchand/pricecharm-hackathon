import test from 'node:test';
import assert from 'node:assert/strict';
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
