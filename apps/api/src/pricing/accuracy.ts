import { rows } from '../db.js';
import { json } from '../models.js';
import { gapPercent, quoteTotal, type DraftedQuote, type Quote } from '../practice/types.js';

/** Within this far of what the owner sent counts as agreeing, as in practice. */
export const AGREE_PERCENT = 15;
/** Real quotes the owner reviewed before their record replaces practice's. */
export const LIVE_MINIMUM = 5;
/** The record covers this many of the latest reviewed quotes. */
export const LIVE_WINDOW = 10;
/** Share of them that has to agree for quotes to be ready to go out on their own. */
export const LIVE_READY_SHARE = 0.8;

export type ReviewedQuote = {
  quoteId: string;
  customer: string;
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

/** Whether the AI's real record says quotes can go out on their own; null with too few yet. */
export function liveReady(reviewed: ReviewedQuote[]): boolean | null {
  if (reviewed.length < LIVE_MINIMUM) return null;
  const recent = reviewed.slice(0, LIVE_WINDOW);
  return recent.filter((item) => item.agree).length / recent.length >= LIVE_READY_SHARE;
}

/**
 * The AI's record on real customers: its draft against what the owner sent, for every quote the
 * owner reviewed, newest first. Quotes it sent alone aren't counted, since nobody checked them.
 */
export async function liveRecord(businessId: string): Promise<ReviewedQuote[]> {
  const sent = await rows(
    `SELECT q.id,q.draft_json,q.quote_json,c.customer_name FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id
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
      sentCents,
      ...compareDraft(json<DraftedQuote | null>(row.draft_json, null), sentCents),
    };
  });
}
