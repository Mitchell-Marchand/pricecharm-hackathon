import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedCents, changedDraft, unchangedCents } from '../src/price-change.js';
import { chatLanguage, LANGUAGES, offeredLanguages } from '../src/languages.js';
import { say } from '../src/words.js';
import { TRANSLATED } from '../src/words-translated.js';
import { fixedLines } from '../src/words-script.js';

test('every fixed line a customer reads is translated into every language, blanks and all', () => {
  const lines = fixedLines();
  assert.ok(lines.length > 100);
  for (const { code } of LANGUAGES.filter((language) => language.code !== 'en'))
    for (const line of lines) {
      const translated = TRANSLATED[code]?.[line];
      assert.ok(translated, `${code} is missing: ${line}. Run npm run words.`);
      const blanks = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
      assert.deepEqual(blanks(translated), blanks(line), `${code}: ${line}`);
    }
});

test('a fixed line fills in its blanks, and stays English where there’s nothing else', () => {
  assert.equal(
    say('en', 'Thanks, {owner} has it now.', { owner: 'Dana' }),
    'Thanks, Dana has it now.',
  );
  assert.match(say('es', 'Thanks, {owner} has it now.', { owner: 'Dana' }), /Dana/);
  assert.equal(say('es', 'Not a line anyone wrote.'), 'Not a line anyone wrote.');
});

test('a chat is in what the customer picked or writes, or the business’s default', () => {
  assert.equal(chatLanguage({ language: 'es' }, { language: null }), 'es');
  assert.equal(chatLanguage({ language: 'es' }, { language: 'hi' }), 'hi');
  assert.equal(chatLanguage({ language: 'nope' }, { language: 'nope' }), 'en');
  assert.deepEqual(offeredLanguages({ language: 'es', languages_json: '["hi","es","nope"]' }), [
    'es',
    'hi',
  ]);
  assert.deepEqual(offeredLanguages({}), ['en']);
});

test('a price change is exact, and what the Charm learns is the owner’s own price', () => {
  assert.equal(changedCents(19500, 20), 23400);
  assert.equal(changedCents(10000, -10), 9000);
  assert.equal(unchangedCents(23400, 20), 19500);
  assert.equal(unchangedCents(23400, 0), 23400);
  const drafted = changedDraft(
    {
      decision: 'quote',
      reason: '',
      lines: [
        { label: 'Patio', amountCents: 15000 },
        { label: 'Sealing', amountCents: 4500 },
      ],
      discount: { kind: 'amount', value: 1000, reason: 'Repeat customer' },
      start: '',
      duration: '',
      confidence: 'high',
      reasoning: '',
    },
    20,
  );
  assert.deepEqual(
    drafted.lines.map((line) => line.amountCents),
    [18000, 5400],
  );
  assert.equal(drafted.discount?.value, 1200);
});
