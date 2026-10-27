'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoadedChat } from '@/components/customer/LoadedChat';
import type { Size, Variant } from '@/components/button-class';
import { Button } from '@/components/ui';

/**
 * The owner asks their own Charm for a quote, in the same chat customers get. They're signed in,
 * so it's a test: nothing is emailed or billed, and a quote that would wait shows them why.
 */
export function TryCharm({
  slug,
  children = 'Ask for a quote',
  variant = 'primary',
  size = 'lg',
  onClose,
}: {
  slug: string;
  children?: ReactNode;
  variant?: Variant;
  size?: Size;
  /** After the chat closes, as when a test quote may have moved the score. */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <dialog
        ref={dialog}
        className="sheet"
        aria-label="Try your Charm"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        {open && (
          <div className="flex h-[92dvh] w-full flex-col md:h-full">
            <LoadedChat slug={slug} profile={undefined} source="link" onClose={close} owner />
          </div>
        )}
      </dialog>
    </>
  );
}
