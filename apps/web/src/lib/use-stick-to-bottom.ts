'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Scrolls so the target's top sits just under the top of the scroller. */
function alignTop(element: HTMLElement, target: HTMLElement) {
  const off = target.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
  // Under a pixel is already in place, and leaving it alone keeps scroll events from echoing.
  if (Math.abs(off) >= 1) element.scrollTop += off;
}

/**
 * Keeps a chat on its newest message. The view is pinned before the browser paints, so new
 * messages appear in place instead of the chat sliding after them, and nothing animates the
 * scroll. Someone who scrolls up to read back is left where they are until they send something.
 *
 * The scroller's first child must hold all the messages, so its growth can be watched.
 */
export function useStickToBottom(scroller: RefObject<HTMLElement | null>) {
  const pinned = useRef(true);
  /** Something shown from its top, kept there while photos above it load, until the reader scrolls. */
  const held = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const stick = () => {
      if (held.current?.isConnected) alignTop(element, held.current);
      else if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    const onScroll = () => {
      // The browser moves the chat on its own sometimes, like keeping its place as a photo above
      // finishes loading. While something is held, any scroll the reader didn't make goes back.
      if (held.current) {
        if (held.current.isConnected) alignTop(element, held.current);
        return;
      }
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    // Only the reader's own scrolling, tapping or moving focus lets go of something held in view.
    const letGo = () => {
      held.current = null;
    };
    const reader = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin'] as const;
    element.addEventListener('scroll', onScroll, { passive: true });
    for (const name of reader) element.addEventListener(name, letGo, { passive: true });
    // Fires when a message arrives, and when the area around the chat changes size.
    const observer = new ResizeObserver(stick);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    stick();
    return () => {
      element.removeEventListener('scroll', onScroll);
      for (const name of reader) element.removeEventListener(name, letGo);
      observer.disconnect();
    };
  }, [scroller]);

  /** Back to the newest message, as when the reader sends something. */
  const toBottom = useCallback(() => {
    held.current = null;
    pinned.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scroller]);

  /**
   * Opens on something from its top instead, like a quote taller than the chat: the reader sees
   * who it's from and the price first, then scrolls down to the buttons. Call it before paint,
   * from a layout effect, so the chat never shows the bottom first. It stays there, even as
   * photos above it finish loading, until the reader scrolls or sends something.
   */
  const showTop = useCallback(
    (target: HTMLElement) => {
      const element = scroller.current;
      if (!element) return;
      held.current = target;
      pinned.current = false;
      alignTop(element, target);
    },
    [scroller],
  );

  return { toBottom, showTop };
}
