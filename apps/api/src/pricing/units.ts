/**
 * Sizes as numbers. Owners and customers write "about 900 square feet" or "two dozen windows";
 * pricing needs 900 and "sq ft". Units are kept to one spelling each so jobs can be compared.
 */

const UNITS: { unit: string; pattern: RegExp; count?: boolean }[] = [
  {
    unit: 'sq ft',
    pattern: /^(?:sq\.?\s*f(?:ee|oo)?t\b\.?|square\s+f(?:ee|oo)?t\b|sqft\b|sf\b|ft²|ft2\b)/,
  },
  { unit: 'ft', pattern: /^(?:linear\s+f(?:ee|oo)?t\b|lin\.?\s*ft\b|lf\b|f(?:ee|oo)?t\b)/ },
  { unit: 'yards', pattern: /^(?:cu(?:bic)?\.?\s*(?:yards?|yds?)\b|yards?\b|yds?\b)/ },
  { unit: 'acres', pattern: /^acres?\b/ },
  { unit: 'hours', pattern: /^(?:hours?|hrs?)\b/ },
  { unit: 'gallons', pattern: /^(?:gallons?|gal)\b/ },
  { unit: 'windows', pattern: /^(?:windows?|panes?)\b/, count: true },
  { unit: 'bedrooms', pattern: /^(?:bedrooms?|beds?|br)\b/, count: true },
  { unit: 'rooms', pattern: /^rooms?\b/, count: true },
  { unit: 'bathrooms', pattern: /^(?:bathrooms?|baths?)\b/, count: true },
  { unit: 'cars', pattern: /^(?:cars?|vehicles?)\b/, count: true },
  { unit: 'trees', pattern: /^trees?\b/, count: true },
  { unit: 'stumps', pattern: /^stumps?\b/, count: true },
  { unit: 'shrubs', pattern: /^(?:shrubs?|bushes|plants?)\b/, count: true },
  { unit: 'loads', pattern: /^(?:truck\s*loads?|truckloads?|loads?)\b/, count: true },
  { unit: 'items', pattern: /^(?:items?|pieces?)\b/, count: true },
  { unit: 'units', pattern: /^units?\b/, count: true },
  { unit: 'doors', pattern: /^doors?\b/, count: true },
  { unit: 'fixtures', pattern: /^(?:fixtures?|lights?|outlets?)\b/, count: true },
  { unit: 'boards', pattern: /^boards?\b/, count: true },
  { unit: 'steps', pattern: /^(?:steps?|stairs?)\b/, count: true },
  { unit: 'guests', pattern: /^(?:guests?|people)\b/, count: true },
  { unit: 'photos', pattern: /^(?:photos?|images?)\b/, count: true },
  { unit: 'visits', pattern: /^visits?\b/, count: true },
];

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** The one spelling of a unit, like "sq ft" for "square feet", or null if it isn't one. */
export function canonicalUnit(text: string): string | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  return UNITS.find((item) => item.pattern.test(value))?.unit ?? null;
}

function normalize(text: string) {
  return (
    ` ${text.toLowerCase()} `
      .replace(/(\d),(\d{3})\b/g, '$1$2')
      .replace(/\b(?:an?\s+)?half(?:\s+an?\b|-)\s*/g, ' 0.5 ')
      .replace(/\b(?:an?\s+)?quarter(?:\s+an?\b|-)\s*/g, ' 0.25 ')
      .replace(/\b(?:two|a)\s+dozen\b/g, (match) => (match.startsWith('two') ? '24' : '12'))
      .replace(/\bdozen\b/g, '12')
      // "two-car", "three bedrooms"
      .replace(/\b([a-z]+)(?=[\s-])/g, (word) => (word in WORDS ? String(WORDS[word]) : word))
  );
}

/**
 * The first size in the text: "About 900 sq ft" is 900 sq ft, "a 12 by 16 deck" is 192 sq ft,
 * "20 to 25 windows" is 22.5 windows. Prices are skipped. Null when there's no size.
 */
export function parseQuantity(text: string): { quantity: number; unit: string } | null {
  const source = normalize(text);
  const number = /(?<![$\d.])(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?/g;
  for (const match of source.matchAll(number)) {
    const first = Number(match[1]);
    const quantity = match[2] ? (first + Number(match[2])) / 2 : first;
    let rest = source.slice((match.index ?? 0) + match[0].length).replace(/^[\s-]+/, '');
    // "12 by 16", "12x16": an area, in square feet unless another unit follows.
    const area = /^(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:f(?:ee|oo)?t\b|')?/.exec(rest);
    if (area && !match[2]) return { quantity: first * Number(area[1]), unit: 'sq ft' };
    const direct = UNITS.find((item) => item.pattern.test(rest));
    if (direct && quantity > 0) return { quantity, unit: direct.unit };
    // "2 AC units", "3 large windows": one word in between, for things you count.
    rest = rest.replace(/^[a-z]+[\s-]+/, '');
    const counted = UNITS.find((item) => item.count && item.pattern.test(rest));
    if (counted && quantity > 0) return { quantity, unit: counted.unit };
  }
  return null;
}

/** "1,200", "2.5": a size's number, rounded the way people say it. */
export function formatNumber(quantity: number): string {
  const rounded = quantity >= 100 ? Math.round(quantity) : Math.round(quantity * 100) / 100;
  return rounded.toLocaleString('en-US');
}

/** "900 sq ft", "24 windows", "1 acre". */
export function formatQuantity(quantity: number, unit: string): string {
  const amount = formatNumber(quantity);
  return amount === '1' && unit.endsWith('s') ? `1 ${unit.slice(0, -1)}` : `${amount} ${unit}`;
}

/** 2,350 becomes 2,400; 37 becomes 35. Sizes a customer would say, rounded up or down if asked. */
export function roundSize(value: number, direction: 'nearest' | 'up' | 'down' = 'nearest'): number {
  const step = value >= 1000 ? 100 : value >= 100 ? 50 : value >= 10 ? 5 : 1;
  const round = direction === 'up' ? Math.ceil : direction === 'down' ? Math.floor : Math.round;
  return Math.max(step, round(value / step) * step);
}
