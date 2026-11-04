import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { aiProvider } from './index.js';

const run = promisify(execFile);

export const voiceNotesAvailable = () => aiProvider === 'meta' && !!process.env.META_API_KEY;

/** Muse Voice Transcribe takes mono 16-bit WAV. WhatsApp's voice notes are Ogg Opus. */
async function toWav(audio: Buffer) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pricecharm-voice-'));
  try {
    const from = path.join(folder, 'note'),
      to = path.join(folder, 'note.wav');
    await fs.writeFile(from, audio);
    await run(
      'ffmpeg',
      ['-v', 'error', '-i', from, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', to],
      { timeout: 30_000 },
    );
    return await fs.readFile(to);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

/** What's said in a voice note, in the language it's said in. Empty when nothing can be made out. */
export async function transcribeVoiceNote(audio: Buffer) {
  const body = new FormData();
  body.append(
    'request',
    new Blob(
      [
        JSON.stringify({
          model: 'muse-voice-transcribe-1.0',
          audioEncoding: 'WAV',
          mode: 'PUSH_TO_TALK',
        }),
      ],
      { type: 'application/json' },
    ),
  );
  const wav = await toWav(audio);
  body.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'note.wav');
  const response = await fetch('https://api.meta.ai/v1/asr/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_API_KEY}`, Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Voice note transcription failed: ${response.status}`);
  }
  const { transcript } = z.object({ transcript: z.string() }).parse(await response.json());
  // It can run a sentence's end together, like ".!".
  return transcript.trim().replace(/([।.!?])[।.!?]+/g, '$1');
}
