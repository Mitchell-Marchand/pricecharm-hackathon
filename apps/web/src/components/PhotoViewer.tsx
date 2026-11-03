'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { photoSrc } from '@/lib/photos';

export type ViewerPhoto = { src: string; label: string };

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pinch'; distance: number; mid: Point; view: View }
  | { kind: 'pan' | 'swipe'; start: Point; view: View }
  | null;

const START: View = { scale: 1, x: 0, y: 0 };
const MOST = 5;
const TAP_ZOOM = 2.5;

const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Photos full screen, one at a time. On a phone, pinch or double-tap to zoom, drag to look around
 * and swipe for the next one; on a computer, scroll or double-click to zoom and the arrows or
 * arrow keys to move on. Only the photo moves: the page behind stays put.
 */
export function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: ViewerPhoto[];
  /** The photo showing, or null when the viewer is closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const [view, setView] = useState<View>(START);
  const [slide, setSlide] = useState(0);
  const [moving, setMoving] = useState(false);
  const viewNow = useRef(view);
  viewNow.current = view;
  const photo = index === null ? null : photos[index];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (photo && !element.open) element.showModal();
    if (!photo && element.open) element.close();
  }, [photo]);

  // Each photo starts whole.
  useEffect(() => {
    setView(START);
    setSlide(0);
    pointers.current.clear();
    gesture.current = null;
  }, [index]);

  const go = useCallback(
    (step: number) => {
      if (index === null || photos.length < 2) return;
      onIndex((index + step + photos.length) % photos.length);
    },
    [index, onIndex, photos.length],
  );

  /** The view kept so the photo never leaves a gap at its edges. */
  const bounded = useCallback((next: View): View => {
    const box = stage.current?.getBoundingClientRect();
    const shown = image.current;
    if (!box || !shown) return next;
    const scale = clamp(next.scale, 1, MOST);
    const spareX = Math.max(0, (shown.offsetWidth * scale - box.width) / 2);
    const spareY = Math.max(0, (shown.offsetHeight * scale - box.height) / 2);
    return { scale, x: clamp(next.x, -spareX, spareX), y: clamp(next.y, -spareY, spareY) };
  }, []);

  /** Zooms to `scale`, keeping what's under `from` (on screen) under `to`. */
  const zoomed = useCallback(
    (base: View, scale: number, from: Point, to: Point): View => {
      const box = stage.current?.getBoundingClientRect();
      if (!box) return base;
      const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const next = clamp(scale, 1, MOST);
      const ratio = next / base.scale;
      return bounded({
        scale: next,
        x: to.x - center.x - ratio * (from.x - center.x - base.x),
        y: to.y - center.y - ratio * (from.y - center.y - base.y),
      });
    },
    [bounded],
  );

  function begin() {
    const points = [...pointers.current.values()];
    const now = viewNow.current;
    if (points.length >= 2)
      gesture.current = {
        kind: 'pinch',
        distance: Math.max(1, gap(points[0], points[1])),
        mid: middle(points[0], points[1]),
        view: now,
      };
    else if (points.length === 1)
      gesture.current = { kind: now.scale > 1 ? 'pan' : 'swipe', start: points[0], view: now };
    else gesture.current = null;
    setMoving(points.length > 0);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that's already gone; its moves still come to the stage.
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    begin();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const now = gesture.current;
    const points = [...pointers.current.values()];
    if (now?.kind === 'pinch' && points.length >= 2) {
      const ratio = gap(points[0], points[1]) / now.distance;
      setView(zoomed(now.view, now.view.scale * ratio, now.mid, middle(points[0], points[1])));
    } else if (now?.kind === 'pan')
      setView(
        bounded({
          ...now.view,
          x: now.view.x + point.x - now.start.x,
          y: now.view.y + point.y - now.start.y,
        }),
      );
    else if (now?.kind === 'swipe' && photos.length > 1) setSlide(point.x - now.start.x);
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const now = gesture.current;
    const point = { x: event.clientX, y: event.clientY };
    if (now && now.kind !== 'pinch' && !pointers.current.size) {
      const dx = point.x - now.start.x,
        dy = point.y - now.start.y;
      setSlide(0);
      if (now.kind === 'swipe' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy))
        go(dx < 0 ? 1 : -1);
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        // A second tap close by zooms in there, or back out.
        const tap = lastTap.current;
        if (tap && event.timeStamp - tap.at < 320 && gap(tap.point, point) < 30) {
          lastTap.current = null;
          setView(viewNow.current.scale > 1 ? START : zoomed(START, TAP_ZOOM, point, point));
        } else lastTap.current = { at: event.timeStamp, point };
      }
    }
    begin();
  }

  // Scrolling zooms where the pointer is. Added by hand: React's wheel listener can't stop the page.
  useEffect(() => {
    const element = stage.current;
    if (!element || !photo) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = { x: event.clientX, y: event.clientY };
      const now = viewNow.current;
      setView(zoomed(now, now.scale * Math.exp(-event.deltaY * 0.002), point, point));
    };
    // Safari zooms the page on its own pinch otherwise.
    const stop = (event: Event) => event.preventDefault();
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', stop);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', stop);
    };
  }, [photo, zoomed]);

  return (
    <dialog
      ref={dialog}
      className="viewer"
      aria-label={photo ? photo.label : 'Photo'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') go(1);
        if (event.key === 'ArrowLeft') go(-1);
      }}
    >
      {photo && index !== null && (
        <div className="flex h-full flex-col">
          <div
            className="flex items-center justify-between gap-3 px-4 pb-2"
            style={{ paddingTop: 'max(12px, env(safe-area-inset-top, 0px))' }}
          >
            <p className="min-w-0 truncate text-sm text-white/85">
              {photo.label}
              {photos.length > 1 && (
                <span className="text-white/60">
                  {' '}
                  · {index + 1} of {photos.length}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close photo"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div
            ref={stage}
            className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              ref={image}
              key={photo.src}
              src={photoSrc(photo.src)}
              alt={photo.label}
              draggable={false}
              data-scale={view.scale.toFixed(2)}
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
              style={{
                transform: `translate(${view.x + slide}px, ${view.y}px) scale(${view.scale})`,
                transition: moving ? 'none' : 'transform 0.2s var(--ease-out)',
              }}
            />
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label="Previous photo"
                  className="absolute top-1/2 left-3 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 sm:inline-flex"
                >
                  <ChevronLeft className="size-6" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label="Next photo"
                  className="absolute top-1/2 right-3 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 sm:inline-flex"
                >
                  <ChevronRight className="size-6" aria-hidden />
                </button>
              </>
            )}
          </div>
          <p
            className="px-4 pt-2 text-center text-xs text-white/60"
            style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom, 0px))' }}
          >
            <span className="pointer-fine:hidden">Pinch or double-tap to zoom.</span>
            <span className="hidden pointer-fine:inline">Scroll or double-click to zoom.</span>
          </p>
        </div>
      )}
    </dialog>
  );
}
