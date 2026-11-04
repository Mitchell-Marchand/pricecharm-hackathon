import { mutate, rows, transaction } from '../db.js';
import { ownerReplyTo, queueEmail } from '../integrations/email.js';
import { chatLanguage } from '../languages.js';
import { json } from '../models.js';
import { currencyOf, money } from '../money.js';
import type { Quote } from '../practice/types.js';
import { say } from '../words.js';
import { chatEmailLink } from './chat.js';

/** Days after a quote goes out before a customer who hasn't answered gets one reminder. */
export const FOLLOW_UP_DAYS = 3;
const DAY = 86_400_000;

/**
 * One reminder to customers who haven't answered, asking them to accept, ask, or say they're not
 * going ahead. Then, once a quote is past its valid days, it's marked as having had no answer.
 * Both feed what the AI knows about how each price went. Runs with the worker's maintenance.
 */
export async function followUpQuotes(now = new Date()) {
  let reminded = 0,
    expired = 0;
  const due = await rows(
    `SELECT q.id FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id JOIN businesses b ON b.id=q.business_id
     WHERE q.status='sent' AND q.followup_sent_at IS NULL AND q.sent_at<? AND c.source<>'test'
       AND c.customer_email IS NOT NULL AND b.status='active' AND b.deletion_requested_at IS NULL
     ORDER BY q.sent_at LIMIT 100`,
    [new Date(now.getTime() - FOLLOW_UP_DAYS * DAY)],
  );
  for (const { id } of due)
    await transaction(async (connection) => {
      const [quote] = await rows(
        `SELECT q.id,q.business_id,q.chat_id,q.total_cents,c.customer_name,c.customer_email,c.language AS chat_language,b.name,b.slug,b.currency,b.language
         FROM live_quotes q JOIN lead_chats c ON c.id=q.chat_id JOIN businesses b ON b.id=q.business_id
         WHERE q.id=? AND q.status='sent' AND q.followup_sent_at IS NULL FOR UPDATE`,
        [id],
        connection,
      );
      if (!quote) return;
      await mutate(
        'UPDATE live_quotes SET followup_sent_at=UTC_TIMESTAMP(3) WHERE id=?',
        [id],
        connection,
      );
      const { link, days } = await chatEmailLink(
        connection,
        String(quote.slug),
        String(quote.chat_id),
      );
      const first = String(quote.customer_name).trim().split(/\s+/)[0];
      const language = chatLanguage(quote, { language: quote.chat_language });
      const business = String(quote.name);
      await queueEmail(
        {
          businessId: String(quote.business_id),
          dedupeKey: `live-quote:${quote.chat_id}:followup`,
          to: String(quote.customer_email),
          replyTo: await ownerReplyTo(String(quote.business_id), connection),
          fromName: String(quote.name),
          subject: say(language, 'Your quote from {business}', { business }),
          text: `${first ? say(language, 'Hi {first},', { first }) : say(language, 'Hi,')}\n\n${say(
            language,
            'Your {price} quote from {business} is still here:',
            { business, price: money(Number(quote.total_cents), currencyOf(quote.currency)) },
          )}\n${link}\n\n${say(
            language,
            'You can accept it or ask a question there. If you’ve decided not to go ahead, you can tell them in one tap, which helps them either way.',
          )}\n\n${say(
            language,
            'The link works for {days} days. Keep it to yourself, since anyone with it can see your quote.',
            { days },
          )}`,
        },
        connection,
      );
      reminded++;
    });

  // Quotes are valid for 7, 14 or 30 days, so nothing newer than 7 days can have run out.
  const open = await rows(
    "SELECT id,quote_json,sent_at FROM live_quotes WHERE status='sent' AND sent_at<? ORDER BY sent_at LIMIT 500",
    [new Date(now.getTime() - 7 * DAY)],
  );
  for (const quote of open) {
    const validDays = json<Partial<Quote>>(quote.quote_json, {}).validDays ?? 14;
    if (new Date(quote.sent_at).getTime() + validDays * DAY > now.getTime()) continue;
    const updated = await mutate(
      "UPDATE live_quotes SET status='expired',decided_at=UTC_TIMESTAMP(3) WHERE id=? AND status='sent'",
      [quote.id],
    );
    expired += updated.affectedRows;
  }
  return { reminded, expired };
}
