import { randomUUID } from 'node:crypto';
import { tradeName } from '@pricecharm/trades';
import { afterPreviewsAvailable, drawAfter } from '../ai/after-preview.js';
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

/** The photo it starts from: the customer's latest photo, or the middle still of their video. */
async function sourcePhoto(businessId: string, chatId: string): Promise<string | null> {
  const [photo] = await rows(
    'SELECT storage_key FROM attachments WHERE business_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 1',
    [businessId, chatId],
  );
  if (photo) return String(photo.storage_key);
  const [video] = await rows(
    'SELECT frames_json FROM lead_videos WHERE business_id=? AND chat_id=? ORDER BY created_at DESC LIMIT 1',
    [businessId, chatId],
  );
  const stills = json<StoredStill[]>(video?.frames_json, []);
  return stills[Math.floor(stills.length / 2)]?.key ?? null;
}

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
    "UPDATE live_quotes SET preview_status='drawing',preview_source_key=?,preview_at=UTC_TIMESTAMP(3) WHERE id=? AND (preview_status IS NULL OR (preview_status='drawing' AND preview_at<UTC_TIMESTAMP(3)-INTERVAL 3 MINUTE))",
    [source, quote.id],
  );
  if (!claimed.affectedRows) return;
  try {
    const task = async () =>
      drawAfter({
        businessId,
        trade: tradeName(quote.trade_id, quote.custom_trade),
        serviceName: String(quote.service_name),
        summary: String(quote.summary || ''),
        condition: json<JobSpec | null>(quote.spec_json, null)?.condition ?? '',
        photo: { mimeType: 'image/jpeg', dataBase64: (await getPhoto(source)).toString('base64') },
      });
    const after =
      quote.source === 'test'
        ? await withAiUsage(businessId, chatId, task)
        : await withCustomerAiUsage(
            { businessId, sessionId: chatId, ip: asker.ip || 'unknown' },
            task,
          );
    const key = `${randomUUID()}.jpg`;
    await putPhoto(key, after);
    await mutate("UPDATE live_quotes SET preview_status='ready',preview_key=? WHERE id=?", [
      key,
      quote.id,
    ]);
    await recordEvent(undefined, businessId, 'after_preview_drawn', {}, { ref: String(quote.id) });
  } catch (error) {
    if (!(error instanceof ApiError)) reportError(error, { event: 'after_preview' });
    await mutate("UPDATE live_quotes SET preview_status='failed' WHERE id=?", [quote.id]);
  }
}

/** Where a quote's before and after can be loaded, once the picture is ready. */
export function previewView(quote: Row, base: string) {
  return quote.preview_status === 'ready' && quote.preview_key && quote.preview_source_key
    ? { before: `${base}/before`, after: `${base}/after` }
    : null;
}

export async function previewFile(quote: Row, which: string) {
  const key =
    which === 'before' ? quote.preview_source_key : which === 'after' ? quote.preview_key : null;
  if (quote.preview_status !== 'ready' || !key)
    throw new ApiError(404, 'NOT_FOUND', 'Picture not found.');
  return getPhoto(String(key));
}
