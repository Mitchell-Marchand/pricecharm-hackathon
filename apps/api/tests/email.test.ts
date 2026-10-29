import test from 'node:test';
import assert from 'node:assert/strict';
import { fromAddress } from '../src/integrations/email.js';

test('emails say who they are from', () => {
  const saved = process.env.SES_EMAIL_FROM;
  process.env.SES_EMAIL_FROM = 'quotes@pricecharm.com';
  try {
    assert.equal(fromAddress(), '"PriceCharm" <quotes@pricecharm.com>');
    assert.equal(fromAddress('Smith Plumbing'), '"Smith Plumbing" <quotes@pricecharm.com>');
    assert.equal(
      fromAddress('Bob "The Pipe" Smith \\ Sons'),
      '"Bob \\"The Pipe\\" Smith \\\\ Sons" <quotes@pricecharm.com>',
    );
    // A name can't break onto a new header line.
    assert.equal(
      fromAddress('Acme\r\nBcc: x@example.test'),
      '"Acme Bcc: x@example.test" <quotes@pricecharm.com>',
    );
    assert.equal(fromAddress('  '), '"PriceCharm" <quotes@pricecharm.com>');
    assert.equal(
      fromAddress('Joe’s Plumbing'),
      `=?UTF-8?B?${Buffer.from('Joe’s Plumbing').toString('base64')}?= <quotes@pricecharm.com>`,
    );
    const long = fromAddress('Ñandú Landscaping & Tree Service of Greater Springfield');
    const words = long.replace(' <quotes@pricecharm.com>', '').split(' ');
    assert.ok(words.length > 1 && words.every((word) => word.length <= 75));
    const decoded = words
      .map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    assert.equal(decoded, 'Ñandú Landscaping & Tree Service of Greater Springfield');
    // An address configured with a name already keeps just the address.
    process.env.SES_EMAIL_FROM = 'Quotes <quotes@pricecharm.com>';
    assert.equal(fromAddress(), '"PriceCharm" <quotes@pricecharm.com>');
  } finally {
    if (saved === undefined) delete process.env.SES_EMAIL_FROM;
    else process.env.SES_EMAIL_FROM = saved;
  }
});
