/**
 * The currencies a business can quote and pay in. Each business has one: its quotes, past jobs and
 * PriceCharm's own fees are all in it, and every amount is in hundredths of it ("cents", whether
 * that's cents, paise, kobo or centavos). Each one has a price list in billing.ts, and none of
 * them has its own zero-decimal rules at Stripe.
 */
export const CURRENCIES = [
  'USD',
  'CAD',
  'AUD',
  'NZD',
  'GBP',
  'EUR',
  'INR',
  'NGN',
  'KES',
  'ZAR',
  'BRL',
  'MXN',
  'PHP',
] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (value: unknown): value is Currency =>
  CURRENCIES.includes(value as Currency);
/** A business's currency as stored, with USD for anything unknown. */
export const currencyOf = (value: unknown): Currency => (isCurrency(value) ? value : 'USD');

/** Where each is written the way owners there write it: ₹1,00,000 in India, R$ 1.250 in Brazil. */
const LOCALES: Record<Currency, string> = {
  USD: 'en-US',
  CAD: 'en-CA',
  AUD: 'en-AU',
  NZD: 'en-NZ',
  GBP: 'en-GB',
  EUR: 'en-IE',
  INR: 'en-IN',
  NGN: 'en-NG',
  KES: 'en-KE',
  ZAR: 'en-ZA',
  BRL: 'pt-BR',
  MXN: 'es-MX',
  PHP: 'en-PH',
};

const formats = new Map<string, Intl.NumberFormat>();
function format(currency: Currency, digits: number) {
  const key = `${currency}:${digits}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.NumberFormat(LOCALES[currency], {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formats.set(key, found);
  }
  return found;
}

/** "$350", "$12.50", "₹1,499", "R$ 2,50": whole amounts without the ".00". */
export function money(cents: number, currency: Currency = 'USD'): string {
  const rounded = Math.round(cents);
  return format(currency, rounded % 100 ? 2 : 0).format(rounded / 100);
}
/** Always with its cents, for rates like $0.46 per sq ft. */
export const exactMoney = (cents: number, currency: Currency = 'USD') =>
  format(currency, 2).format(cents / 100);
/** Rounded to the whole unit: "$1,250". */
export const wholeMoney = (cents: number, currency: Currency = 'USD') =>
  format(currency, 0).format(Math.round(cents / 100));
/** Small amounts keep their cents, $0.46 a sq ft; bigger ones are whole, $65 an hour. */
export const roughMoney = (cents: number, currency: Currency = 'USD') =>
  cents < 1000 ? money(cents, currency) : wholeMoney(cents, currency);

/**
 * For the AI: what its amounts are in, when it isn't dollars. Empty for USD, so prompts for
 * businesses there stay as they were measured.
 */
export const amountsIn = (currency: Currency | undefined) =>
  !currency || currency === 'USD'
    ? ''
    : ` Every amount is in ${currency}, and a "cents" amount is hundredths of it (paise, kobo, centavos). Write any price in words the way people there do, with its own symbol.`;
