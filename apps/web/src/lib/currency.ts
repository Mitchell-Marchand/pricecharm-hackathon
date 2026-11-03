/**
 * The currencies a business can quote and pay in, as the API has them (apps/api/src/money.ts).
 * Every amount is in hundredths of the business's currency.
 */
export const CURRENCIES = [
  { code: 'USD', name: 'US dollar', locale: 'en-US' },
  { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
  { code: 'AUD', name: 'Australian dollar', locale: 'en-AU' },
  { code: 'NZD', name: 'New Zealand dollar', locale: 'en-NZ' },
  { code: 'GBP', name: 'British pound', locale: 'en-GB' },
  { code: 'EUR', name: 'Euro', locale: 'en-IE' },
  { code: 'INR', name: 'Indian rupee', locale: 'en-IN' },
  { code: 'NGN', name: 'Nigerian naira', locale: 'en-NG' },
  { code: 'KES', name: 'Kenyan shilling', locale: 'en-KE' },
  { code: 'ZAR', name: 'South African rand', locale: 'en-ZA' },
  { code: 'BRL', name: 'Brazilian real', locale: 'pt-BR' },
  { code: 'MXN', name: 'Mexican peso', locale: 'es-MX' },
  { code: 'PHP', name: 'Philippine peso', locale: 'en-PH' },
] as const;
export type Currency = (typeof CURRENCIES)[number]['code'];

export const isCurrency = (value: unknown): value is Currency =>
  CURRENCIES.some((item) => item.code === value);
export const localeOf = (currency: Currency) =>
  CURRENCIES.find((item) => item.code === currency)?.locale ?? 'en-US';

// The time zones that mean somewhere other than the US.
const BY_ZONE: [RegExp, Currency][] = [
  [/^Asia\/(Kolkata|Calcutta)$/, 'INR'],
  [/^Africa\/Lagos$/, 'NGN'],
  [/^Africa\/Nairobi$/, 'KES'],
  [/^Africa\/Johannesburg$/, 'ZAR'],
  [
    /^America\/(Sao_Paulo|Fortaleza|Recife|Bahia|Belem|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Araguaina|Maceio|Santarem|Noronha)$/,
    'BRL',
  ],
  [
    /^America\/(Mexico_City|Monterrey|Merida|Cancun|Tijuana|Chihuahua|Ciudad_Juarez|Hermosillo|Mazatlan|Matamoros|Bahia_Banderas|Ojinaga)$/,
    'MXN',
  ],
  [/^Asia\/Manila$/, 'PHP'],
  [/^Europe\/London$/, 'GBP'],
  [
    /^Europe\/(Dublin|Paris|Berlin|Madrid|Rome|Amsterdam|Brussels|Vienna|Lisbon|Helsinki|Athens|Luxembourg|Bratislava|Ljubljana|Tallinn|Riga|Vilnius|Malta|Zagreb|Monaco)$/,
    'EUR',
  ],
  [/^Atlantic\/(Canary|Madeira|Azores)$/, 'EUR'],
  [/^Australia\//, 'AUD'],
  [/^Pacific\/(Auckland|Chatham)$/, 'NZD'],
  [
    /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal|Moncton|Whitehorse|Yellowknife|Iqaluit|Swift_Current|Glace_Bay|Goose_Bay|Dawson_Creek|Fort_Nelson)$/,
    'CAD',
  ],
];

/** Where this browser seems to be, from its time zone: dollars unless it's clearly elsewhere. */
export function guessCurrency(): Currency {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    return BY_ZONE.find(([pattern]) => pattern.test(zone))?.[1] ?? 'USD';
  } catch {
    return 'USD';
  }
}

// A page shows one business's amounts at a time, so the currency is set once when its business
// loads: the owner's, the one being quoted, or the visitor's guess. Only in the browser: on the
// server it would carry over from one request to the next, so pages render there in dollars.
let current: Currency = 'USD';
export const currentCurrency = () => current;
export function setCurrency(currency: unknown) {
  if (typeof window !== 'undefined') current = isCurrency(currency) ? currency : 'USD';
}

/** "₹", "R$", "Ksh": what goes before an amount typed in. */
export function currencySymbol(currency: Currency = current): string {
  const part = new Intl.NumberFormat(localeOf(currency), { style: 'currency', currency })
    .formatToParts(0)
    .find((item) => item.type === 'currency');
  return part?.value ?? currency;
}
