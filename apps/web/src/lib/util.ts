import { currentCurrency, localeOf, type Currency } from './currency';

const formats = new Map<string, Intl.NumberFormat>();
function format(currency: Currency, digits: number) {
  const key = `${currency}:${digits}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.NumberFormat(localeOf(currency), {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formats.set(key, found);
  }
  return found;
}

/** An amount in the page's currency, or the one given: "$350", "$12.50", "₹1,499". */
export function money(cents: number, currency: Currency = currentCurrency()): string {
  const rounded = Math.round(cents);
  return format(currency, rounded % 100 ? 2 : 0).format(rounded / 100);
}

/** Rates per square foot keep their cents, e.g. $0.46. */
export function rate(centsPerUnit: number, currency: Currency = currentCurrency()): string {
  return format(currency, 2).format(centsPerUnit / 100);
}

/**
 * Parses typed money into integer cents; null when empty or invalid. A point or comma before the
 * last one or two digits is the decimal point, and any other is a thousands mark, so "1,250.50",
 * "1.250,50" (as in Brazil) and "1,00,000" (as in India) all read right.
 */
export function parseMoney(input: string): number | null {
  const typed = input.replace(/[^\d.,]/g, '');
  const decimal = typed.match(/[.,](\d{1,2})$/);
  const cleaned = decimal
    ? `${typed.slice(0, decimal.index).replace(/[.,]/g, '')}.${decimal[1]}`
    : typed.replace(/[.,]/g, '');
  if (!cleaned || !/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

export function moneyInput(cents: number | null): string {
  if (cents == null) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function round5(cents: number): number {
  return Math.max(0, Math.round(cents / 500) * 500);
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'your-business'
  );
}

/** "a" or "an" before a word: "an Exterior windows job", "a Deck job". */
export function article(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word.trim()) && !/^(u[nr]i|use|usu|one)/i.test(word.trim()) ? 'an' : 'a';
}

export function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Empty for no date yet. */
export function addDays(iso: string, days: number): string {
  if (!iso) return '';
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Empty for no date yet. */
export function shortDate(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function scrollToBottom(): void {
  window.requestAnimationFrame(() =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    }),
  );
}

/** Downscales a picked image so it stays small enough to keep in the browser. */
export function readPhoto(file: File, maxSide = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as a photo.'));
    };
    image.src = url;
  });
}
