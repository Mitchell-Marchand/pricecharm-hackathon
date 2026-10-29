import 'dotenv/config';
import Stripe from 'stripe';
import { centsPerQuote, dollars, publicPricing } from './billing.js';

/**
 * Creates PriceCharm's products, prices and quote meter in the Stripe account the key belongs to,
 * then prints the settings for the API's env. Run it once in test mode and once in live mode:
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup --workspace @pricecharm/api
 *
 * Running it again changes nothing, unless a price on the pricing page has changed. Then it makes
 * a new Stripe price and moves the lookup key to it; subscriptions already on the old one keep it.
 */
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY to the account’s secret key (sk_test_ or sk_live_).');
  process.exit(1);
}
const stripe = new Stripe(key);
const pricing = publicPricing();
const eventName = 'pricecharm_quotes';

async function meter(): Promise<string> {
  const meters = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  const existing = meters.data.find((item) => item.event_name === eventName);
  if (existing) return existing.id;
  const created = await stripe.billing.meters.create({
    display_name: 'Billed quotes',
    event_name: eventName,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
  return created.id;
}

/** Product names and descriptions are what owners read in Checkout and on invoices. */
async function product(
  id: string,
  fields: { name: string; description: string; unit_label?: string },
): Promise<string> {
  try {
    await stripe.products.retrieve(id);
    await stripe.products.update(id, fields);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    await stripe.products.create({ id, ...fields });
  }
  return id;
}

async function price(
  lookupKey: string,
  productId: string,
  unitAmount: number,
  recurring: Stripe.PriceCreateParams.Recurring,
): Promise<string> {
  const [existing] = (
    await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, expand: ['data.tiers'] })
  ).data;
  // A $0 quote price is two $0 tiers, which Checkout shows as "Price varies", not "$0.00 per unit",
  // under the accepted-quote plan's 1% terms. One tier would list its $0 lines in plain view.
  const tiered = unitAmount === 0 && recurring.usage_type === 'metered';
  if (
    existing?.active &&
    existing.product === productId &&
    existing.billing_scheme === (tiered ? 'tiered' : 'per_unit') &&
    (!tiered || existing.tiers?.length === 2) &&
    centsPerQuote(existing) === unitAmount &&
    existing.recurring?.interval === recurring.interval &&
    existing.recurring.usage_type === (recurring.usage_type ?? 'licensed') &&
    (existing.recurring.meter ?? undefined) === recurring.meter
  )
    return existing.id;
  const created = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    ...(tiered
      ? {
          billing_scheme: 'tiered' as const,
          tiers_mode: 'graduated' as const,
          tiers: [
            { up_to: 1, unit_amount: 0 },
            { up_to: 'inf' as const, unit_amount: 0 },
          ],
        }
      : { unit_amount: unitAmount }),
    recurring,
    lookup_key: lookupKey,
    transfer_lookup_key: Boolean(existing),
  });
  return created.id;
}

async function main() {
  const meterId = await meter();
  const metered = { interval: 'month', usage_type: 'metered', meter: meterId } as const;
  const { accepted, subscription } = pricing;
  const perQuote = await product('pricecharm-per-quote', {
    name: 'Pay per quote',
    description: 'Each quote a customer gets from you.',
    unit_label: 'quote',
  });
  const perAccepted = await product('pricecharm-per-accepted', {
    name: 'Pay when you win',
    description: `You pay only when a customer accepts a quote: ${accepted.basisPoints / 100}% of the job, at least ${dollars(accepted.minimumFeeCents)} and at most ${dollars(accepted.maximumFeeCents)}. Nothing when they say no.`,
  });
  const extraQuotes = await product('pricecharm-extra-quotes', {
    name: 'Extra quotes',
    description: `Each quote past ${subscription.includedQuotes} in a month.`,
    unit_label: 'quote',
  });
  const plan = await product('pricecharm-subscription', {
    name: 'PriceCharm subscription',
    description: `${subscription.includedQuotes} quotes a month included.`,
  });
  const settings = {
    STRIPE_METER_EVENT_NAME: eventName,
    STRIPE_PRICE_PER_QUOTE: await price(
      'pricecharm_per_quote',
      perQuote,
      pricing.perQuoteCents,
      metered,
    ),
    STRIPE_PRICE_PER_ACCEPTED: await price('pricecharm_per_accepted', perAccepted, 0, metered),
    STRIPE_PRICE_EXTRA_QUOTES: await price(
      'pricecharm_extra_quotes',
      extraQuotes,
      subscription.overageCents,
      metered,
    ),
    STRIPE_PRICE_MONTHLY: await price('pricecharm_monthly', plan, subscription.monthlyCents, {
      interval: 'month',
    }),
    STRIPE_PRICE_YEARLY: await price('pricecharm_yearly', plan, subscription.yearlyCents, {
      interval: 'year',
    }),
  };
  const mode = key!.includes('_live_') ? 'live' : 'test';
  console.info(`# Stripe ${mode} mode. Put these in the API's env:`);
  for (const [name, value] of Object.entries(settings)) console.info(`${name}=${value}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
