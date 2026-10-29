'use client';

import { useEffect } from 'react';

/**
 * Phone browsers don't shrink the page for the keyboard. Safari and the Instagram and Facebook
 * browsers slide the whole page up under it instead, header and all. While the keyboard is up,
 * this puts the part of the page still in view in --vv-top and --vv-height on <html>, so a
 * full-screen chat can fit itself there with the typing box just above the keyboard. It also sets
 * --safe-bottom to 0, since the keyboard covers the strip by the home bar.
 */
export function useVisualViewport() {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement;
    // The keyboard is up when the view is well short of the tallest it's been at this width. A
    // toolbar sliding away changes it by far less.
    let width = 0,
      tallest = 0;
    const clear = () => {
      for (const name of ['--vv-top', '--vv-height', '--safe-bottom'])
        root.style.removeProperty(name);
    };
    const update = () => {
      // Zooming in shrinks the view too, and the page should zoom rather than refit.
      if (Math.abs(view.scale - 1) > 0.01) return;
      if (view.width !== width) {
        width = view.width;
        tallest = 0;
      }
      tallest = Math.max(tallest, view.height);
      if (tallest - view.height < 150) return clear();
      root.style.setProperty('--vv-top', `${view.offsetTop}px`);
      root.style.setProperty('--vv-height', `${view.height}px`);
      root.style.setProperty('--safe-bottom', '0px');
    };
    update();
    view.addEventListener('resize', update);
    view.addEventListener('scroll', update);
    return () => {
      view.removeEventListener('resize', update);
      view.removeEventListener('scroll', update);
      clear();
    };
  }, []);
}
