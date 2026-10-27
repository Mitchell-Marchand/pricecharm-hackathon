'use client';

import { useCallback, useEffect, useRef } from 'react';

type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** Matches the API's actions, so a token earned on one form can't be spent on another. */
export type HumanCheckAction = 'signup' | 'quote_chat' | 'onboarding' | 'demo';

/** Public by design. Set at build time; without it there's no check (local runs and tests). */
const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;

let script: Promise<Turnstile> | undefined;
function loadTurnstile() {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    tag.async = true;
    tag.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile is missing.'));
    tag.onerror = () => {
      script = undefined;
      tag.remove();
      reject(new Error('Turnstile could not load.'));
    };
    document.head.append(tag);
  });
  return script;
}

function removeWidget(widget: { turnstile: Turnstile; id: string }) {
  try {
    widget.turnstile.remove(widget.id);
  } catch {
    // Its element is already gone.
  }
}

const unfinished = () =>
  new Error('The quick check didn’t finish. Check your connection and try again.');

/**
 * Cloudflare Turnstile. It's usually invisible and only shows a checkbox in `slot` when Cloudflare
 * isn't sure. `headers()` runs the check and resolves to the header for the protected request, or
 * to nothing when there's no site key.
 */
export function useHumanCheck(action: HumanCheckAction, enabled = true) {
  const slot = useRef<HTMLDivElement>(null);
  const widget = useRef<{ turnstile: Turnstile; id: string; container: HTMLElement } | null>(null);
  const waiting = useRef<{ resolve(token: string): void; reject(error: Error): void } | null>(null);

  // The slot can unmount and come back (a form that closes and reopens), so render into
  // whichever element is there now.
  const ready = useCallback(async () => {
    if (!siteKey) return null;
    const turnstile = await loadTurnstile();
    const container = slot.current;
    if (!container) throw unfinished();
    if (widget.current?.container === container && container.isConnected) return widget.current;
    if (widget.current) removeWidget(widget.current);
    const fail = () => {
      waiting.current?.reject(unfinished());
      waiting.current = null;
    };
    const id = turnstile.render(container, {
      sitekey: siteKey,
      action,
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (token: string) => {
        waiting.current?.resolve(token);
        waiting.current = null;
      },
      'error-callback': fail,
      'timeout-callback': fail,
    });
    widget.current = { turnstile, id, container };
    return widget.current;
  }, [action]);

  useEffect(() => {
    if (enabled) ready().catch(() => undefined);
  }, [enabled, ready]);

  useEffect(
    () => () => {
      if (widget.current) removeWidget(widget.current);
      widget.current = null;
    },
    [],
  );

  const headers = useCallback(async (): Promise<Record<string, string>> => {
    const current = await ready();
    if (!current) return {};
    waiting.current?.reject(unfinished());
    const token = await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(unfinished()), 120_000);
      waiting.current = {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      current.turnstile.reset(current.id);
      current.turnstile.execute(current.id);
    });
    return { 'X-Turnstile-Token': token };
  }, [ready]);

  return { slot, headers };
}
