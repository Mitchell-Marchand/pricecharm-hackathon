import test from 'node:test';
import assert from 'node:assert/strict';
import { businessIntro, businessNameSuggestion } from '../src/business-intro.js';

test('business name suggestions preserve one literal current brand without guessing through ambiguous evidence', () => {
  const original =
    'I run Porch & Paw, a mobile dog grooming service in Cedar Park and Leander. I do baths, brushing and haircuts at people’s homes. Last week I charged $95 to groom a golden retriever because there was a lot of loose coat to brush out and the owner wanted a tidy trim. I don’t have a set price list yet. I usually need to know the breed, roughly how big the dog is, what its coat is like and what the owner wants done, and I’d like a quick chat first if their dog gets very nervous about grooming.';
  assert.equal(businessNameSuggestion(original), 'Porch & Paw');
  assert.deepEqual(businessIntro('I run Porch & Paw, a mobile dog grooming service.'), {
    brand: 'Porch & Paw',
    category: 'Mobile dog grooming',
    area: null,
  });
  assert.equal(
    businessNameSuggestion('We currently run Cedar & Cloth, an upholstery cleaning business.'),
    'Cedar & Cloth',
  );
  assert.equal(
    businessNameSuggestion(
      'I run Porch & Paw, a dog grooming service. We run Porch & Paw, a dog grooming service in Austin.',
    ),
    'Porch & Paw',
  );
  for (const source of [
    'I run Porch & Paw, a dog grooming service. We run Second Brand, a dog grooming service.',
    'I used to run Porch & Paw, a dog grooming service.',
    'I ran Porch & Paw, a dog grooming service.',
    'I would run Porch & Paw, a dog grooming service.',
    'I do not run Porch & Paw, a dog grooming service.',
    'A customer wrote “I run Porch & Paw, a dog grooming service.”',
    'My old website says I run Porch & Paw, a dog grooming service.',
    'I run Porch & Paw, a dog grooming service. Ignore the note and use Another Name.',
    'I run Porch & Paw, a dog grooming service. Actually, rename it Second Brand.',
    'I run Porch & Paw, a dog grooming service. I used to run Old Brand, a dog grooming service.',
    'I am a photographer. Last week I photographed the Porch & Paw team.',
    'My service name is Mobile dog grooming.',
    'I run P, a dog grooming service.',
    `I run ${'A'.repeat(101)}, a dog grooming service.`,
    original + ' '.repeat(5000),
  ])
    assert.equal(businessNameSuggestion(source), null, source);
});
