'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { PostHog } from 'posthog-js';
import { Button } from '@/components/ui';
import {
  consent,
  declinesTracking,
  flush,
  forwardTo,
  isCustomerPage,
  labelOf,
  needsConsent,
  onSubject,
  screenPath,
  sessionId,
  setConsent,
  track,
  trackingAllowed,
} from '@/lib/track';

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// Customers' pages, and pages opened from a one-time link whose token is in the address.
const NOT_RECORDED = /^\/(q|embed|approve|reset-password|verify-email|start\/resume)(\/|$)/;
// Idle this long and the clock on the screen stops.
const IDLE_MS = 30_000;
const INTERACTIVE =
  'button, a[href], [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="switch"], summary, label';

function device(): string {
  const width = window.innerWidth;
  return width < 640 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';
}

function fieldName(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const label =
    element.labels?.[0]?.innerText ||
    element.getAttribute('aria-label') ||
    element.getAttribute('placeholder') ||
    element.name ||
    element.id;
  return (label || element.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Follows what people do outside the customer pages, and keeps the session recording going
 * where it's allowed. Mounted once, in the root layout.
 */
export function Tracking() {
  const path = usePathname();
  const [allowed, setAllowed] = useState(false);
  const [asking, setAsking] = useState(false);
  const screen = useRef<{ path: string; opened: number; active: number; scroll: number } | null>(
    null,
  );
  const lastInput = useRef(0);
  const posthog = useRef<PostHog | null>(null);

  // Consent first: decided once per browser in Europe, assumed everywhere else.
  useEffect(() => {
    const decide = () => {
      setAllowed(trackingAllowed());
      setAsking(needsConsent() && consent() === null);
    };
    decide();
    window.addEventListener('pc-consent', decide);
    return () => window.removeEventListener('pc-consent', decide);
  }, []);

  // How this visit started.
  useEffect(() => {
    if (!allowed) return;
    const params = new URLSearchParams(location.search);
    let referrer = '';
    try {
      const from = new URL(document.referrer);
      if (from.host !== location.host) referrer = from.hostname.replace(/^www\./, '');
    } catch {
      // A direct visit.
    }
    track('session_started', {
      landing: screenPath(location.pathname),
      referrer,
      utm_source: params.get('utm_source') ?? '',
      utm_medium: params.get('utm_medium') ?? '',
      utm_campaign: params.get('utm_campaign') ?? '',
      device: device(),
      width: window.innerWidth,
      height: window.innerHeight,
      language: navigator.language,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      touch: navigator.maxTouchPoints > 0,
    });
  }, [allowed]);

  // Screens: when each opened, how long someone actually worked on it, and how far they scrolled.
  useEffect(() => {
    if (!allowed) return;
    const from = screen.current?.path ?? '';
    const close = (reason: string) => {
      const open = screen.current;
      if (!open) return;
      track('screen_left', {
        screen: open.path,
        to: reason === 'navigate' ? screenPath(path) : reason,
        active_ms: open.active,
        total_ms: Date.now() - open.opened,
        scroll_pct: open.scroll,
      });
      screen.current = null;
    };
    close('navigate');
    if (isCustomerPage(path)) return;
    screen.current = { path: screenPath(path), opened: Date.now(), active: 0, scroll: 0 };
    lastInput.current = Date.now();
    track('screen_viewed', { from, title: document.title });
    posthog.current?.capture('$pageview');
    const leave = () => {
      close('left_site');
      flush(true);
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [allowed, path]);

  // Everything people do on a screen.
  useEffect(() => {
    if (!allowed) return;
    const busy = () => {
      lastInput.current = Date.now();
    };
    const tick = window.setInterval(() => {
      const open = screen.current;
      if (
        open &&
        document.visibilityState === 'visible' &&
        Date.now() - lastInput.current < IDLE_MS
      )
        open.active += 1000;
    }, 1000);
    const scrolled = () => {
      busy();
      const open = screen.current;
      if (!open) return;
      const page = document.documentElement;
      const reach = Math.round(
        ((window.scrollY + window.innerHeight) / Math.max(page.scrollHeight, 1)) * 100,
      );
      open.scroll = Math.max(open.scroll, Math.min(reach, 100));
    };

    // Clicks: what was clicked, and clicks on things that look clickable but do nothing.
    const clicked = (event: MouseEvent) => {
      busy();
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest(INTERACTIVE) ?? null;
      if (!control) {
        // Clicks on things that look like they should do something but don't.
        if (target && getComputedStyle(target).cursor === 'pointer')
          track('clicked_nothing', {
            label: labelOf(target),
            element: target.tagName.toLowerCase(),
          });
        return;
      }
      // Counted when pressed, below.
      if (control.matches('button:disabled, [aria-disabled="true"]')) return;
      const link = control instanceof HTMLAnchorElement ? control : null;
      let href = '';
      if (link) {
        const to = new URL(link.href, location.href);
        href = to.host === location.host ? screenPath(to.pathname) : to.host;
      }
      track('clicked', {
        label: labelOf(control),
        element: control.getAttribute('role') || control.tagName.toLowerCase(),
        href,
        disabled: false,
        x_pct: Math.round((event.clientX / window.innerWidth) * 100),
        y_pct: Math.round((event.clientY / window.innerHeight) * 100),
      });
    };

    // Every press, including on disabled buttons, which never get a click. The same spot pressed
    // over and over means something isn't responding, unless it's someone selecting text.
    let burst: { x: number; y: number; at: number; count: number } | null = null;
    const pressed = (event: PointerEvent) => {
      busy();
      const target = event.target instanceof Element ? event.target : null;
      const now = Date.now();
      const selecting = Boolean(target?.closest('input, textarea, [contenteditable="true"]'));
      if (
        burst &&
        now - burst.at < 800 &&
        Math.hypot(event.clientX - burst.x, event.clientY - burst.y) < 24
      ) {
        burst.count++;
        burst.at = now;
        const pressedOn = target?.closest(INTERACTIVE) ?? target;
        if (burst.count === 3 && !selecting)
          track('rage_click', {
            label: labelOf(pressedOn),
            element: pressedOn?.tagName.toLowerCase() ?? '',
            disabled: Boolean(pressedOn?.matches('button:disabled, [aria-disabled="true"]')),
          });
      } else burst = { x: event.clientX, y: event.clientY, at: now, count: 1 };
      const control = target?.closest('button:disabled, [aria-disabled="true"]');
      if (!control) return;
      track('clicked', {
        label: labelOf(control),
        element: control.getAttribute('role') || control.tagName.toLowerCase(),
        href: '',
        disabled: true,
        x_pct: Math.round((event.clientX / window.innerWidth) * 100),
        y_pct: Math.round((event.clientY / window.innerHeight) * 100),
      });
    };

    // Fields: how long someone spent in each and whether they changed it, never what's in it.
    const focused = new Map<Element, { at: number; length: number }>();
    const focusIn = (event: FocusEvent) => {
      busy();
      const field = event.target;
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      )
        focused.set(field, { at: Date.now(), length: field.value.length });
    };
    const focusOut = (event: FocusEvent) => {
      const field = event.target;
      if (!(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ))
        return;
      const start = focused.get(field);
      focused.delete(field);
      if (!start || ['checkbox', 'radio', 'file', 'hidden'].includes(field.type)) return;
      const secret = field.type === 'password';
      track('field_used', {
        field: fieldName(field),
        kind: field instanceof HTMLSelectElement ? 'select' : field.type || 'text',
        focused_ms: Date.now() - start.at,
        chars: secret ? null : field.value.length,
        filled: field.value.length > 0,
        changed: secret ? null : field.value.length !== start.length,
        // A list's options are the app's own words.
        choice:
          field instanceof HTMLSelectElement && !field.closest('[data-private]') ? field.value : '',
        invalid: field.getAttribute('aria-invalid') === 'true',
      });
    };
    const changed = (event: Event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      if (field.type === 'checkbox' || field.type === 'radio')
        track('toggled', { field: fieldName(field), checked: field.checked, kind: field.type });
      if (field.type === 'file')
        track('files_picked', {
          field: fieldName(field),
          count: field.files?.length ?? 0,
          kb: Math.round(
            Array.from(field.files ?? []).reduce((sum, file) => sum + file.size, 0) / 1024,
          ),
          types: Array.from(field.files ?? [])
            .map((file) => file.type)
            .join(','),
        });
    };

    // Error messages as they appear on the page.
    const seen = new Map<string, number>();
    const reportErrors = (root: Element) => {
      const found = root.matches('[role="alert"], [data-field-error]')
        ? [root]
        : Array.from(root.querySelectorAll('[role="alert"], [data-field-error]'));
      for (const element of found) {
        const text = labelOf(element);
        if (!text || Date.now() - (seen.get(text) ?? 0) < 3000) continue;
        seen.set(text, Date.now());
        track('error_shown', { text, field: element.getAttribute('data-field-error') ?? '' });
      }
    };
    const observer = new MutationObserver((changes) => {
      for (const change of changes) {
        const holder =
          change.type === 'characterData'
            ? change.target.parentElement?.closest('[role="alert"], [data-field-error]')
            : null;
        if (holder) reportErrors(holder);
        for (const node of change.addedNodes) if (node instanceof Element) reportErrors(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // The tab going to the background, and how long it stayed there.
    let hiddenAt = 0;
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        track('tab_hidden');
        flush(true);
      } else if (hiddenAt) {
        track('tab_back', { away_ms: Date.now() - hiddenAt });
        lastInput.current = Date.now();
      }
    };
    const crashed = (event: ErrorEvent) =>
      track('js_error', { message: String(event.message).slice(0, 160) });
    const rejected = (event: PromiseRejectionEvent) =>
      track('js_error', {
        message: String(event.reason instanceof Error ? event.reason.message : event.reason).slice(
          0,
          160,
        ),
        unhandled: true,
      });
    const copied = () => track('copied', { chars: String(window.getSelection() ?? '').length });

    document.addEventListener('click', clicked, true);
    document.addEventListener('pointerdown', pressed, true);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('change', changed, true);
    document.addEventListener('keydown', busy, { passive: true });
    document.addEventListener('pointermove', busy, { passive: true });
    document.addEventListener('copy', copied);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('scroll', scrolled, { passive: true, capture: true });
    window.addEventListener('error', crashed);
    window.addEventListener('unhandledrejection', rejected);
    return () => {
      window.clearInterval(tick);
      observer.disconnect();
      document.removeEventListener('click', clicked, true);
      document.removeEventListener('pointerdown', pressed, true);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('change', changed, true);
      document.removeEventListener('keydown', busy);
      document.removeEventListener('pointermove', busy);
      document.removeEventListener('copy', copied);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('scroll', scrolled, { capture: true });
      window.removeEventListener('error', crashed);
      window.removeEventListener('unhandledrejection', rejected);
    };
  }, [allowed]);

  // Session recordings, on the owner side only, with typing and customers' details masked.
  const recordable = !NOT_RECORDED.test(path);
  useEffect(() => {
    if (!allowed || !recordable || !POSTHOG_KEY || declinesTracking()) return;
    let stopListening: (() => void) | undefined;
    let cancelled = false;
    void import('posthog-js').then(({ default: client }) => {
      if (cancelled) return;
      if (!posthog.current) {
        client.init(POSTHOG_KEY, {
          api_host: '/ingest',
          ui_host: 'https://us.posthog.com',
          // Nothing kept in the browser: the tab's session id ties the visit together.
          persistence: 'memory',
          person_profiles: 'identified_only',
          capture_pageview: false,
          capture_pageleave: true,
          autocapture: true,
          rageclick: true,
          capture_dead_clicks: true,
          // Clicks are recorded by where they land, not what the element says.
          mask_all_text: true,
          mask_all_element_attributes: true,
          disable_surveys: true,
          session_recording: {
            maskAllInputs: true,
            maskTextSelector: '[data-private], [data-private] *',
            // Masking only covers text, so photos and videos have to be left out altogether.
            blockSelector: '[data-private] img, [data-private] video',
          },
          // Addresses lose anything after a #, where one-time links keep their tokens.
          before_send: (event) => {
            for (const key of ['$current_url', '$referrer', '$initial_current_url'])
              if (typeof event?.properties?.[key] === 'string')
                event.properties[key] = event.properties[key].split('#')[0];
            return event;
          },
        });
        client.register({ pc_session: sessionId() });
        client.capture('$pageview');
        posthog.current = client;
      }
      forwardTo((name, props) => posthog.current?.capture(name, props));
      stopListening = onSubject((subject) => posthog.current?.identify(subject));
    });
    return () => {
      cancelled = true;
      stopListening?.();
      forwardTo(undefined);
    };
    // Set up on the first page that can be recorded, and reconnected after one that can't.
  }, [allowed, recordable]);

  // Customers' pages are never recorded, even when the owner opens their own link in this tab.
  useEffect(() => {
    const client = posthog.current;
    if (!client) return;
    if (!recordable) {
      client.stopSessionRecording();
      client.opt_out_capturing();
    } else if (client.has_opted_out_capturing()) {
      client.opt_in_capturing();
      client.startSessionRecording();
    }
  }, [recordable]);

  if (!asking || isCustomerPage(path)) return null;
  return (
    <div
      role="dialog"
      aria-label="Recording how PriceCharm is used"
      className="fixed inset-x-4 bottom-4 z-[90] max-w-sm rounded-md border border-line bg-surface p-4 shadow-2 sm:right-auto"
    >
      <p className="text-sm text-ink">
        Can we record how you use PriceCharm? It shows us what&apos;s confusing so we can fix it.
        What you type stays hidden.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => setConsent('yes')}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setConsent('no')}>
          No thanks
        </Button>
      </div>
    </div>
  );
}
