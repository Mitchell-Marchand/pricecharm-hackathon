import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { tradeName } from '@pricecharm/trades';
import { afterPreviewsAvailable, afterShowsChange, drawAfter } from '../ai/after-preview.js';
import type { Walkaround } from '../ai/walkaround.js';
import { mutate, rows } from '../db.js';
import { reportError } from '../error-reporting.js';
import { ApiError } from '../http.js';
import { recordEvent } from '../metrics.js';
import { json, type Row } from '../models.js';
import type { JobSpec } from '../pricing/spec.js';
import { getPhoto, putPhoto } from '../storage.js';
import { withAiUsage, withCustomerAiUsage } from '../usage.js';
import type { StoredStill } from './videos.js';

/**
 * A before-and-after with the quote: the customer's own photo, and Muse Image's picture of the same
 * spot with the job done. It's drawn after the quote is saved, so the quote never waits for it,
 * and shows up once it's ready. Owners can turn it off.
 */

type Source = { key: string; from: 'photo' | 'video' };

/** The picture a reading drew what it counted on: where the most of the first thing it counted shows. */
const busiest = (reading: Walkaround | null) =>
  reading?.overlays.find((overlay) => overlay.label === reading.counts[0]?.label)?.frameId ??
  reading?.overlays[0]?.frameId;

/**
 * The picture it starts from: the customer's photo or video still where the reading found the most
 * of what's being priced, so the change has something to show on. Otherwise their latest photo, or
 * the middle still of their video.
 */
async function sourcePhoto(businessId: string, chatId: string): Promise<Source | null> {
  const [chat] = await rows(
    'SELECT photo_reading_json FROM lead_chats WHERE id=? AND business_id=?',
    [chatId, businessId],
  );
  const read = json<{ result: Walkaround | null } | null>(chat?.photo_reading_json, null)?.result;
  const [photo] = await rows(
    `SELECT storage_key FROM attachments WHERE business_id=? AND conversation_id=?
     ORDER BY id=? DESC,created_at DESC LIMIT 1`,
    [businessId, chatId, busiest(read ?? null) ?? ''],
  );
  if (photo) return { key: String(photo.storage_key), from: 'photo' };
  const [video] = await rows(
    'SELECT frames_json,result_json FROM lead_videos WHERE business_id=? AND chat_id=? ORDER BY created_at DESC LIMIT 1',
    [businessId, chatId],
  );
  const stills = json<StoredStill[]>(video?.frames_json, []);
  const best = busiest(json<Walkaround | null>(video?.result_json, null));
  const still = stills.find((item) => item.key === best) ?? stills[Math.floor(stills.length / 2)];
  return still ? { key: still.key, from: 'video' } : null;
}

/** A picture small enough to show Muse Spark next to another. */
const forChecking = async (bytes: Buffer) => ({
  mimeType: 'image/jpeg',
  dataBase64: (
    await sharp(bytes)
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer()
  ).toString('base64'),
});

/** Draws the after picture for a chat's quote. Safe to call twice: the first call claims it. */
export async function startAfterPreview(asker: { ip?: string }, chatId: string) {
  if (!afterPreviewsAvailable()) return;
  const [quote] = await rows(
    `SELECT q.id,q.business_id,c.source,c.service_name,c.summary,c.spec_json,b.after_preview,b.trade_id,b.custom_trade
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id JOIN businesses b ON b.id=q.business_id
     WHERE q.chat_id=?`,
    [chatId],
  );
  if (!quote?.after_preview) return;
  const businessId = String(quote.business_id);
  const source = await sourcePhoto(businessId, chatId);
  if (!source) return;
  // A claim older than three minutes belongs to a run that stopped, so it's taken again.
  const claimed = await mutate(
    "UPDATE live_quotes SET preview_status='drawing',preview_source_key=?,preview_from=?,preview_at=UTC_TIMESTAMP(3) WHERE id=? AND (preview_status IS NULL OR (preview_status='drawing' AND preview_at<UTC_TIMESTAMP(3)-INTERVAL 3 MINUTE))",
    [source.key, source.from, quote.id],
  );
  if (!claimed.affectedRows) return;
  try {
    const trade = tradeName(quote.trade_id, quote.custom_trade);
    const task = async () => {
      const before = await getPhoto(source.key);
      const after = await drawAfter({
        businessId,
        trade,
        serviceName: String(quote.service_name),
        summary: String(quote.summary || ''),
        condition: json<JobSpec | null>(quote.spec_json, null)?.condition ?? '',
        photo: { mimeType: 'image/jpeg', dataBase64: before.toString('base64') },
      });
      // Only one a customer would see the job done in is worth showing.
      const shows = await afterShowsChange({
        trade,
        serviceName: String(quote.service_name),
        before: await forChecking(before),
        after: await forChecking(after),
      });
      return { after, shows };
    };
    const { after, shows } =
      quote.source === 'test'
        ? await withAiUsage(businessId, chatId, task)
        : await withCustomerAiUsage(
            { businessId, sessionId: chatId, ip: asker.ip || 'unknown' },
            task,
          );
    const key = `${randomUUID()}.jpg`;
    await putPhoto(key, after);
    await mutate('UPDATE live_quotes SET preview_status=?,preview_key=? WHERE id=?', [
      shows ? 'ready' : 'unclear',
      key,
      quote.id,
    ]);
    await recordEvent(
      undefined,
      businessId,
      shows ? 'after_preview_drawn' : 'after_preview_unclear',
      { from: source.from },
      { ref: String(quote.id) },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'after_preview' });
    await mutate("UPDATE live_quotes SET preview_status='failed' WHERE id=?", [quote.id]);
  }
}

/** Where a quote's before and after can be loaded, once the picture is ready, and what it's from. */
export function previewView(quote: Row, base: string) {
  return quote.preview_status === 'ready' && quote.preview_key && quote.preview_source_key
    ? {
        before: `${base}/before`,
        after: `${base}/after`,
        from: quote.preview_from === 'video' ? ('video' as const) : ('photo' as const),
      }
    : null;
}

const LABEL_HEIGHT = 56;

/**
 * The before and after side by side in one picture, labelled, for where there's no slider to drag
 * across, like WhatsApp.
 */
export async function previewPair(quote: Row): Promise<Buffer> {
  const height = 900;
  const halves = await Promise.all(
    ['before', 'after'].map(async (which) =>
      sharp(await previewFile(quote, which))
        .rotate()
        .resize({ height, width: 800, fit: 'cover' })
        .jpeg()
        .toBuffer(),
    ),
  );
  const gap = 12,
    width = 800 * 2 + gap;
  const label = (text: string, x: number) =>
    `<rect x="${x + 20}" y="20" width="${text.length * 17 + 36}" height="${LABEL_HEIGHT - 12}" rx="22" fill="#111827" fill-opacity="0.78"/><text x="${x + 38}" y="${LABEL_HEIGHT - 2}" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#ffffff">${text}</text>`;
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: halves[0], left: 0, top: 0 },
      { input: halves[1], left: 800 + gap, top: 0 },
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${label('Now', 0)}${label('After', 800 + gap)}</svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

export async function previewFile(quote: Row, which: string) {
  const key =
    which === 'before' ? quote.preview_source_key : which === 'after' ? quote.preview_key : null;
  if (quote.preview_status !== 'ready' || !key)
    throw new ApiError(404, 'NOT_FOUND', 'Picture not found.');
  return getPhoto(String(key));
}
