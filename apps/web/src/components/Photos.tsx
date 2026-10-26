'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { photoSrc } from '@/lib/photos';
import { cx } from '@/lib/util';

export function PhotoGrid({
  photos,
  label,
  className,
}: {
  photos: string[];
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!photos.length) return null;
  return (
    <>
      <div
        className={cx(
          'grid gap-1.5',
          photos.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
          className,
        )}
      >
        {photos.map((photo, index) => (
          <button
            key={`${photo.slice(0, 40)}-${index}`}
            type="button"
            onClick={() => setOpen(photo)}
            className="group relative overflow-hidden rounded-sm bg-surface-2"
            aria-label={`Open photo ${index + 1} of ${photos.length} from ${label}`}
          >
            <img
              src={photoSrc(photo)}
              alt=""
              className="aspect-[4/3] w-full max-w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </button>
        ))}
      </div>
      <Lightbox photo={open} onClose={() => setOpen(null)} label={label} />
    </>
  );
}

export function Lightbox({
  photo,
  onClose,
  label,
}: {
  photo: string | null;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (photo && !dialog.open) dialog.showModal();
    if (!photo && dialog.open) dialog.close();
  }, [photo]);
  return (
    <dialog
      ref={ref}
      className="panel"
      aria-label={`Photo from ${label}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={onClose}
    >
      {photo && (
        <div className="relative">
          <img
            src={photoSrc(photo)}
            alt={`Photo from ${label}`}
            className="max-h-[86dvh] w-auto max-w-[min(92vw,1000px)] rounded-sm object-contain shadow-2"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close photo"
            className="absolute top-3 right-3 inline-flex size-10 items-center justify-center rounded-full bg-ink/80 text-on-ink"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
    </dialog>
  );
}
