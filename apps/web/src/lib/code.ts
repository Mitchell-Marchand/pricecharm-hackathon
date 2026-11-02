/**
 * A code from a link, like pricecharm.com/start?code=SPRING, kept in this browser until the owner
 * reaches the plans, where it goes on their account by itself. It's dropped once tried, or after
 * 30 days.
 */
const KEY = 'pricecharm_code';
const KEEP_DAYS = 30;
/** Pages an outreach link might open. Elsewhere a "code" in the address is something else. */
const FROM = ['/', '/pricing', '/demo'];

export function keepCodeFromLink(path: string) {
  if (!FROM.includes(path) && !path.startsWith('/start')) return;
  try {
    const code = (new URLSearchParams(window.location.search).get('code') ?? '')
      .replace(/\s+/g, '')
      .slice(0, 40);
    if (code) localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // No browser storage: they can still type it in.
  }
}

export function keptCode(): string | null {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (typeof kept?.code === 'string' && Date.now() - Number(kept.at) < KEEP_DAYS * 86400000)
      return kept.code;
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, or no browser storage.
  }
  return null;
}

export function forgetCode() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // No browser storage, so nothing to forget.
  }
}
