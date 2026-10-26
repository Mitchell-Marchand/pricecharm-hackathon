import { randomUUID } from 'node:crypto';
import { hashToken, newToken } from './auth.js';
import { rows, mutate, type Sql } from './db.js';
import { queueEmail } from './integrations/email.js';

/** Persist notification and quote changes in the same transaction. No provider call here. */
export async function queueQuoteNotification(
  businessId: string,
  quoteId: string,
  event: 'review_requested' | 'issued' | 'owner_message' | 'customer_message',
  connection: Sql,
) {
  const [item] = await rows(
    'SELECT q.*,b.name AS business_name,b.slug,b.deletion_requested_at,s.status AS session_status,s.verified_email,s.contact_verified_at,s.contact_consent_at FROM quotes q JOIN businesses b ON b.id=q.business_id LEFT JOIN public_sessions s ON s.id=q.public_session_id AND s.business_id=q.business_id WHERE q.business_id=? AND q.id=?',
    [businessId, quoteId],
    connection,
  );
  if (!item || item.source !== 'live' || item.deletion_requested_at) return;
  const origin = (process.env.APP_ORIGIN || 'http://localhost:3100').split(',')[0].trim();
  if (event === 'review_requested' || event === 'customer_message') {
    const [user] = await rows(
      'SELECT email FROM users WHERE business_id=? AND email_verified_at IS NOT NULL ORDER BY created_at LIMIT 1',
      [businessId],
      connection,
    );
    if (user)
      await queueEmail(
        {
          businessId,
          dedupeKey:
            event === 'review_requested'
              ? `quote:${quoteId}:review`
              : `quote:${quoteId}:customer-message:${Math.floor(Date.now() / 300000)}`,
          to: user.email,
          subject:
            event === 'review_requested'
              ? `New quote request for ${item.business_name}`
              : `A customer replied to their quote request`,
          text:
            event === 'review_requested'
              ? `A customer requested a quote and needs your review.\n\nSign in to view their project details and photos, ask questions, and approve a price:\n${origin}/dashboard/quotes?quote=${encodeURIComponent(quoteId)}\n\nNo quote price has been sent to the customer.`
              : `A customer replied to the quote conversation for ${item.business_name}.\n\nSign in to read the reply, review photos and respond:\n${origin}/dashboard/quotes?quote=${encodeURIComponent(quoteId)}`,
        },
        connection,
      );
    return;
  }
  // The owner hears about every quote that went out without them, so a burst of fake requests
  // (each one a fee) can't run up their bill unnoticed.
  if (event === 'issued' && item.issued_by === 'automatic') {
    const [user] = await rows(
      'SELECT email FROM users WHERE business_id=? AND email_verified_at IS NOT NULL ORDER BY created_at LIMIT 1',
      [businessId],
      connection,
    );
    const total = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: item.currency,
    }).format(Number(item.total_cents) / 100);
    const customer = String(item.customer_name || '').trim() || 'a customer';
    const support = process.env.SUPPORT_EMAIL?.trim();
    if (user)
      await queueEmail(
        {
          businessId,
          dedupeKey: `quote:${quoteId}:owner-issued`,
          to: user.email,
          subject: `Quote sent: ${total} to ${customer}`,
          text: `Your assistant sent ${customer} (${item.customer_email}) a quote for ${total}.\n\nSee the quote and the conversation:\n${origin}/dashboard/quotes?quote=${encodeURIComponent(quoteId)}${support ? `\n\nDoesn’t look like a real customer? Email ${support} and we’ll look into it.` : ''}`,
        },
        connection,
      );
  }
  // Send private quote content only to the contact verified for this exact inquiry.
  if (
    !item.contact_verified_at ||
    !item.contact_consent_at ||
    String(item.verified_email).toLowerCase() !== String(item.customer_email).toLowerCase() ||
    !item.public_session_id ||
    !['review', 'issued'].includes(item.status) ||
    !['submitted', 'issued'].includes(item.session_status)
  )
    return;
  if (
    event === 'issued' &&
    (
      await rows(
        'SELECT id FROM email_outbox WHERE dedupe_key=?',
        [`quote:${quoteId}:issued`],
        connection,
      )
    ).length
  )
    return;
  const token = newToken(),
    tokenHash = hashToken(token),
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await mutate(
    'UPDATE public_sessions SET email_token_hash=?,email_token_expires_at=? WHERE business_id=? AND id=?',
    [tokenHash, expiresAt, businessId, item.public_session_id],
    connection,
  );
  const link = `${origin}/q/${encodeURIComponent(item.slug)}#session=${encodeURIComponent(item.public_session_id)}&token=${encodeURIComponent(token)}`;
  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: item.currency,
  }).format(Number(item.total_cents) / 100);
  await queueEmail(
    {
      businessId,
      dedupeKey:
        event === 'issued'
          ? `quote:${quoteId}:issued`
          : `quote:${quoteId}:owner-message:${randomUUID()}`,
      to: item.customer_email,
      requestAccess: {
        quoteId,
        sessionId: item.public_session_id,
        tokenHash,
        expiresAt: expiresAt.toISOString(),
        event,
      },
      subject:
        event === 'issued'
          ? `Your quote from ${item.business_name}`
          : `${item.business_name} replied to your quote request`,
      text:
        event === 'issued'
          ? `${item.business_name} has issued your quote for ${total}.\n\nReview the full scope, assumptions, and line items, then accept or decline:\n${link}\n\nThis private link expires on ${expiresAt.toISOString()}. Keep it private. Acceptance records your interest; payment and scheduling are arranged with the business.`
          : `${item.business_name} has replied to your quote request. Read the message and respond using your private inquiry link:\n${link}\n\nThis private link expires on ${expiresAt.toISOString()}. Keep it private.`,
    },
    connection,
  );
}
