/**
 * Meta's pixel, so our ads on Facebook and Instagram can be measured and aimed at people who sign
 * up. It runs on the public pages and setup only: never on customers' pages, in the owner's app
 * or on a page opened from a one-time link. It doesn't run at all in Europe and the UK, or when
 * the browser asks not to be tracked. It sends page views and three events, never what anyone typed.
 */
import { declinesTracking, needsConsent } from './track';

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim() || '';
const PUBLIC_PAGES = new Set(['/', '/go', '/pricing', '/demo', '/privacy', '/terms']);
const SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';

/**
 * The events the campaign can optimize for: a business described in setup, an account made, and a
 * card added. Setup's account comes after practice, so the business is the earliest sign.
 */
export type PixelEvent = 'Lead' | 'CompleteRegistration' | 'AddPaymentInfo';

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Fbq;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
};

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

export const pixelPage = (path: string) =>
  PUBLIC_PAGES.has(path) || (/^\/start(\/|$)/.test(path) && !path.startsWith('/start/resume'));

function pixelAllowed(): boolean {
  if (!PIXEL_ID || typeof window === 'undefined') return false;
  return pixelPage(location.pathname) && !needsConsent() && !declinesTracking();
}

/** Meta's loader: calls wait in a queue until the script arrives. */
function load(): Fbq {
  if (window.fbq) return window.fbq;
  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  } as Fbq;
  fbq.queue = [];
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  // Page views are sent here, only on the pages above. Left on, the pixel would count every
  // change of address in the app as one, and read buttons and page details on its own.
  fbq.disablePushState = true;
  window.fbq = fbq;
  window._fbq ??= fbq;
  fbq('set', 'autoConfig', false, PIXEL_ID);
  fbq('init', PIXEL_ID);
  const script = document.createElement('script');
  script.async = true;
  script.src = SCRIPT;
  document.head.appendChild(script);
  return fbq;
}

/** Counts a page view, where the pixel runs. Called on every change of screen. */
export function pixelPageView() {
  if (pixelAllowed()) load()('track', 'PageView');
}

export function pixelEvent(name: PixelEvent) {
  if (pixelAllowed()) load()('track', name);
}
