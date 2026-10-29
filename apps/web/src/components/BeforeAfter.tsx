'use client';

import { useState, type ReactNode } from 'react';

/**
 * The customer's photo and a picture of the same spot with the job done, one over the other.
 * Dragging, tapping or the arrow keys move the line between them.
 */
export function BeforeAfter({
  before,
  after,
  caption,
}: {
  before: string;
  after: string;
  caption: ReactNode;
}) {
  const [split, setSplit] = useState(50);
  return (
    <figure className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-[12px] border border-line bg-surface-2 select-none">
        <img src={before} alt="The photo as it is now" draggable={false} className="block w-full" />
        <img
          src={after}
          alt="The same spot with the job done"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          style={{ clipPath: `inset(0 0 0 ${split}%)` }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-1"
          style={{ left: `${split}%` }}
        >
          <span className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[13px] font-semibold text-ink shadow-1">
            ⇆
          </span>
        </div>
        <span className="pointer-events-none absolute top-2 left-2 rounded-xs bg-black/55 px-2 py-0.5 text-xs font-semibold text-white">
          Now
        </span>
        <span className="pointer-events-none absolute top-2 right-2 rounded-xs bg-black/55 px-2 py-0.5 text-xs font-semibold text-white">
          After
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={split}
          onChange={(event) => setSplit(Number(event.target.value))}
          aria-label="Move between now and after"
          className="absolute inset-0 size-full cursor-ew-resize opacity-0"
        />
      </div>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}
