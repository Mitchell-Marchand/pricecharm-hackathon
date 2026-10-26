import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApiError } from './http.js';
export async function inspectPdf(bytes: Buffer): Promise<{ pages: number }> {
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString('ascii', 0, 5) !== '%PDF-')
    throw new ApiError(422, 'INVALID_PDF', 'Upload a PDF smaller than 4 MB.');
  const development = import.meta.url.endsWith('.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=96',
        ...(development ? ['--import', 'tsx'] : []),
        fileURLToPath(
          new URL(development ? './pdf-inspect.ts' : './pdf-inspect.js', import.meta.url),
        ),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '',
      finished = false;
    const invalid = () =>
      new ApiError(
        422,
        'INVALID_PDF',
        'Upload a readable PDF of 1–30 pages without password protection.',
      );
    const finish = (error?: Error, result?: { pages: number }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(invalid());
    }, 8000);
    child.on('error', () => finish(invalid()));
    child.stdout.on('data', (part) => {
      output += part.toString();
      if (output.length > 1024) {
        child.kill('SIGKILL');
        finish(invalid());
      }
    });
    child.on('close', (code) => {
      try {
        const value = JSON.parse(output);
        if (code !== 0 || !Number.isInteger(value.pages) || value.pages < 1 || value.pages > 30)
          throw invalid();
        finish(undefined, { pages: value.pages });
      } catch {
        finish(invalid());
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}
