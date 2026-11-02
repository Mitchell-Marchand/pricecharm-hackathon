'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from '@/lib/util';

/** Bottom sheet on phones, side panel on larger screens. Only the sheet body scrolls. */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  flush = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <>
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 pt-5 pb-4 sm:px-6">
            <div className="min-w-0">
              <h2 id={titleId} className="t-h2">
                {title}
              </h2>
              {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-1 -mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-5" />
            </button>
          </header>
          <div
            className={cx(
              // Sized by its content, not from zero: a phone sheet has no set height, and Safari
              // shrinks a zero-based body in it down to its padding.
              'min-h-0 flex-auto overflow-y-auto overscroll-contain',
              !flush && 'px-5 py-5 sm:px-6',
            )}
          >
            {children}
          </div>
          {footer && (
            <footer
              className={cx('border-t border-line bg-surface px-5 pt-4 sm:px-6')}
              style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}
            >
              {footer}
            </footer>
          )}
        </>
      )}
    </dialog>
  );
}
