/**
 * The web app's record of what people do: screens and the time spent on them, clicks, fields,
 * errors they saw and requests that failed. It sends labels, counts and timings, never what
 * anyone typed. Quote links and the website widget belong to businesses' customers and aren't
 * tracked. Visitors in Europe are only tracked once they agree.
 */

export type TrackProps = Record<string, string | number | boolean | null | undefined>;
type Queued = { name: string; path: string; at: number; props: TrackProps };

const CUSTOMER_PAGES = /^\/(q|embed)(\/|$)/;
const SESSION_KEY = 'pc_session';
const CONSENT_KEY = 'pc_consent';
const EUROPEAN_ATLANTIC = [
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Atlantic/Faroe',
  'Atlantic/Madeira',
];

let queue: Queued[] = [];
let timer: number | undefined;
let memorySession = '';
let subject: string | null = null;
const subjectListeners = new Set<(subject: string) => void>();
let forward: ((name: string, props: TrackProps) => void) | undefined;

export const isCustomerPage = (path: string) => CUSTOMER_PAGES.test(path);

/** Visitors in Europe and the UK, going by their clock, are asked first. */
export function needsConsent(): boolean {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    return zone.startsWith('Europe/') || EUROPEAN_ATLANTIC.includes(zone);
  } catch {
    return false;
  }
}

export function consent(): 'yes' | 'no' | null {
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === 'yes' || value === 'no' ? value : null;
  } catch {
    return null;
  }
}

export function setConsent(value: 'yes' | 'no') {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Private windows can refuse storage. The choice holds until the page reloads.
  }
  window.dispatchEvent(new Event('pc-consent'));
}

/**
 * The browser asks not to be tracked: no screen recordings and no Meta pixel, though our own
 * counts still go on.
 */
export function declinesTracking(): boolean {
  const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
  return Boolean(browser.globalPrivacyControl) || browser.doNotTrack === '1';
}

export function trackingAllowed(path = typeof window === 'undefined' ? '' : location.pathname) {
  if (typeof window === 'undefined' || isCustomerPage(path)) return false;
  return !needsConsent() || consent() === 'yes';
}

/** One id per browser tab, so the trail before a setup exists joins the one after. */
export function sessionId(): string {
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    memorySession ||= crypto.randomUUID();
    return memorySession;
  }
}

/** Ids in addresses become :id, so every quote's page counts as the same screen. */
export function screenPath(path: string): string {
  return (
    path
      .split('/')
      .map((part) => (/^[0-9a-f-]{16,}$/i.test(part) || /^\d{3,}$/.test(part) ? ':id' : part))
      .join('/')
      .replace(/[^A-Za-z0-9/_:.-]/g, '')
      .slice(0, 120) || '/'
  );
}

/** What a button, link or field says, unless it sits in something marked private. */
export function labelOf(element: Element | null): string {
  if (!element || element.closest('[data-private]')) return '';
  const text =
    element.getAttribute('aria-label') ||
    (element as HTMLElement).innerText ||
    element.getAttribute('title') ||
    '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function track(name: string, props: TrackProps = {}) {
  if (!trackingAllowed()) return;
  const clean: TrackProps = {};
  for (const [key, value] of Object.entries(props))
    if (value !== undefined) clean[key] = typeof value === 'string' ? value.slice(0, 300) : value;
  queue.push({ name, path: screenPath(location.pathname), at: Date.now(), props: clean });
  forward?.(name, clean);
  if (queue.length >= 20) flush();
  else if (timer === undefined) timer = window.setTimeout(() => flush(), 3000);
}

/** Sends what's waiting. On the way out of the page, the browser finishes the request itself. */
export function flush(leaving = false) {
  window.clearTimeout(timer);
  timer = undefined;
  while (queue.length) {
    const batch = queue.splice(0, 25);
    const now = Date.now();
    void fetch('/api/v1/events', {
      method: 'POST',
      credentials: 'include',
      keepalive: leaving,
      headers: { 'Content-Type': 'application/json', 'X-PC-Session': sessionId() },
      body: JSON.stringify({
        session: sessionId(),
        events: batch.map((event) => ({
          name: event.name,
          path: event.path,
          ago: Math.min(now - event.at, 600_000),
          props: Object.fromEntries(Object.entries(event.props).slice(0, 30)),
        })),
      }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: { subject?: string | null } } | null) => {
        const found = body?.data?.subject;
        if (found && found !== subject) {
          subject = found;
          for (const listener of subjectListeners) listener(found);
        }
      })
      .catch(() => {});
    if (!leaving) break;
  }
  if (queue.length) timer = window.setTimeout(() => flush(), 1000);
}

/** Called with the setup's tag once the server says which setup this browser belongs to. */
export function onSubject(listener: (subject: string) => void) {
  subjectListeners.add(listener);
  if (subject) listener(subject);
  return () => subjectListeners.delete(listener);
}

/** Session recordings get every event too, so they can be searched by them. */
export function forwardTo(target: typeof forward) {
  forward = target;
}
