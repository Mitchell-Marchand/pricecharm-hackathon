import { PDFDocument } from 'pdf-lib';
// Untrusted PDF parsing runs in a short-lived, memory-limited child process.
try {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > 4 * 1024 * 1024) throw new Error('too_large');
    parts.push(Buffer.from(part));
  }
  const document = await PDFDocument.load(Buffer.concat(parts), {
    ignoreEncryption: false,
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  const pages = document.getPageCount();
  if (document.isEncrypted || pages < 1 || pages > 30) throw new Error('unsupported');
  process.stdout.write(JSON.stringify({ pages }));
} catch {
  process.stdout.write(JSON.stringify({ error: 'invalid_pdf' }));
  process.exitCode = 1;
}
