'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const COUNTED = new Set(['/', '/pricing', '/demo', '/start', '/privacy', '/terms']);

/**
 * Counts a visit to a public page on PriceCharm's own server, with the site that sent the visitor.
 * No cookies and nothing kept in the browser, and nothing at all when the browser asks not to be
 * tracked.
 */
export function VisitCounter() {
  const path = usePathname();
  useEffect(() => {
    if (!COUNTED.has(path)) return;
    const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (browser.globalPrivacyControl || browser.doNotTrack === '1') return;
    let referrer = '';
    try {
      const from = new URL(document.referrer);
      if (from.host !== window.location.host)
        referrer = from.hostname
          .toLowerCase()
          .replace(/^www\./, '')
          .replace(/[^a-z0-9.-]/g, '')
          .slice(0, 100);
    } catch {
      // No referrer, or not a URL: a direct visit.
    }
    const campaign = (new URLSearchParams(window.location.search).get('utm_source') ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 60);
    void fetch('/api/v1/visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, referrer, campaign }),
      keepalive: true,
    }).catch(() => {});
  }, [path]);
  return null;
}
