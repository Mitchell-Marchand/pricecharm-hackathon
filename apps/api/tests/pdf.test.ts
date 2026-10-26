import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inspectPdf } from '../src/pdf.js';
test('PDF preflight parses compressed page trees in an isolated bounded process', async () => {
  const small = await PDFDocument.create();
  small.addPage();
  assert.deepEqual(await inspectPdf(Buffer.from(await small.save({ useObjectStreams: true }))), {
    pages: 1,
  });
  const large = await PDFDocument.create();
  for (let i = 0; i < 31; i++) large.addPage();
  const compressed = Buffer.from(await large.save({ useObjectStreams: true }));
  assert.equal(
    (compressed.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length,
    0,
    'fixture hides the page tree in compressed objects',
  );
  await assert.rejects(() => inspectPdf(compressed), { code: 'INVALID_PDF' });
  await assert.rejects(() => inspectPdf(Buffer.from('%PDF-1.7\nnot a PDF document')), {
    code: 'INVALID_PDF',
  });
  await assert.rejects(() => inspectPdf(Buffer.alloc(4 * 1024 * 1024 + 1)), {
    code: 'INVALID_PDF',
  });
});
