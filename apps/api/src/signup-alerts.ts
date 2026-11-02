import { z } from 'zod';
import { rows, type Sql } from './db.js';
import { reportError } from './error-reporting.js';
import { queueEmail } from './integrations/email.js';

/**
 * Each new business emails us three times: when someone starts training a Charm, when they make an
 * account, and when they add a card. They go to SIGNUPS_EMAIL, or SUPPORT_EMAIL without one.
 */
export type SignupStep = 'setup_started' | 'account_created' | 'billing_active';
export const SIGNUP_STEPS: ReadonlySet<string> = new Set<SignupStep>([
  'setup_started',
  'account_created',
  'billing_active',
]);

const PLAN_NAMES: Record<string, string> = {
  per_quote: 'pay per quote',
  per_accepted: 'pay when customers say yes',
  monthly: 'monthly subscription',
  yearly: 'yearly subscription',
};

async function draft(businessId: string, step: SignupStep, connection?: Sql) {
  if (step === 'setup_started')
    return {
      subject: 'Someone started training a Charm',
      text: 'Someone just started setting up PriceCharm. There’s no name or email yet. You’ll get another email if they make an account.',
    };
  const [business] = await rows(
    `SELECT b.name,b.industry,b.service_area,u.name AS owner,u.email,a.plan,a.subscription_status,a.promo_code,a.promo_days
     FROM businesses b
     LEFT JOIN users u ON u.id=(SELECT id FROM users WHERE business_id=b.id ORDER BY created_at LIMIT 1)
     LEFT JOIN billing_accounts a ON a.business_id=b.id
     WHERE b.id=?`,
    [businessId],
    connection,
  );
  if (!business) return null;
  const name = String(business.name || 'A business');
  const owner = business.email ? `${business.owner} (${business.email})` : 'No owner yet';
  const replyTo = business.email ? String(business.email) : undefined;
  if (step === 'account_created')
    return {
      replyTo,
      subject: `New account: ${name}`,
      text: [
        `${owner} just made an account for ${name}.`,
        '',
        `Trade: ${business.industry || 'not given'}`,
        `Area: ${business.service_area || 'not given'}`,
        '',
        'Reply to this email to write to them.',
      ].join('\n'),
    };
  const plan = PLAN_NAMES[String(business.plan)] ?? 'no plan';
  return {
    replyTo,
    subject: `Card added: ${name}`,
    text: [
      `${name} picked a plan and added a card.`,
      '',
      `Plan: ${plan}${business.subscription_status === 'trialing' ? ', on its free week' : ''}`,
      ...(business.promo_code
        ? [`Code: ${business.promo_code} (${business.promo_days} free days)`]
        : []),
      `Owner: ${owner}`,
      '',
      'Reply to this email to write to them.',
    ].join('\n'),
  };
}

/** Queued with the step's own write, so a signup that fails sends nothing. Never stops the step. */
export async function queueSignupAlert(
  connection: Sql | undefined,
  businessId: string,
  step: SignupStep,
): Promise<void> {
  const to = z.email().safeParse((process.env.SIGNUPS_EMAIL || process.env.SUPPORT_EMAIL)?.trim());
  if (!to.success) return;
  try {
    const email = await draft(businessId, step, connection);
    if (!email) return;
    await queueEmail(
      { ...email, to: to.data, businessId, dedupeKey: `signup-alert:${step}:${businessId}` },
      connection,
    );
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', code: 'SIGNUP_ALERT_FAILED', step }));
    reportError(error, { step });
  }
}
