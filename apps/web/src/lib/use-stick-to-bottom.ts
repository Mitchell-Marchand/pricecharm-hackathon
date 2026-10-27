'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a chat on its newest message. The view is pinned before the browser paints, so new
 * messages appear in place instead of the chat sliding after them, and nothing animates the
 * scroll. Someone who scrolls up to read back is left where they are until they send something.
 *
 * The scroller's first child must hold all the messages, so its growth can be watched.
 */
export function useStickToBottom(scroller: RefObject<HTMLElement | null>) {
  const pinned = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const stick = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    // Fires when a message arrives, and when the area around the chat changes size.
    const observer = new ResizeObserver(stick);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    stick();
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [scroller]);

  /** Back to the newest message, as when the reader sends something. */
  return useCallback(() => {
    pinned.current = true;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scroller]);
}
