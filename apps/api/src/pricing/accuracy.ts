import { rows } from '../db.js';
import { iso, json } from '../models.js';
import { gapPercent, quoteTotal, type DraftedQuote, type Quote } from '../practice/types.js';

/** Within this far of what the owner sent counts as agreeing, as in practice. */
export const AGREE_PERCENT = 15;
/** The record covers this many of the latest reviewed quotes. */
export const LIVE_WINDOW = 10;

export type ReviewedQuote = {
  quoteId: string;
  customer: string;
  service: string;
  sentAt: string;
  draftCents: number | null;
  sentCents: number;
  gap: number | null;
  agree: boolean;
};

/** How one AI draft compared with what the owner sent. No price from the AI never agrees. */
export function compareDraft(draft: DraftedQuote | null, sentCents: number) {
  const priced = draft && draft.decision === 'quote' && draft.lines.length;
  const draftCents = priced ? quoteTotal(draft) : null;
  const gap = draftCents ? gapPercent(draftCents, sentCents) : null;
  return { draftCents, gap, agree: gap !== null && gap <= AGREE_PERCENT };
}

/**
 * The AI's record on real customers: its draft against what the owner sent, for every quote the
 * owner reviewed, newest first. Quotes it sent alone aren't counted, since nobody checked them.
 */
export async function liveRecord(businessId: string): Promise<ReviewedQuote[]> {
  const sent = await rows(
    `SELECT q.id,q.draft_json,q.quote_json,q.sent_at,c.customer_name,c.service_name
     FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
     WHERE q.business_id=? AND q.sent_by='owner' AND c.source<>'test'
       AND q.status IN ('sent','accepted','visit_requested','lost','expired')
     ORDER BY q.sent_at DESC LIMIT 50`,
    [businessId],
  );
  return sent.map((row) => {
    const sentCents = quoteTotal(
      json<Quote>(row.quote_json, { lines: [], discount: null } as unknown as Quote),
    );
    return {
      quoteId: String(row.id),
      customer: String(row.customer_name || 'A customer'),
      service: String(row.service_name || ''),
      sentAt: iso(row.sent_at),
      sentCents,
      ...compareDraft(json<DraftedQuote | null>(row.draft_json, null), sentCents),
    };
  });
}
