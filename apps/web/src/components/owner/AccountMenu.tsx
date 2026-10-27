'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LogOut, Settings } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { logout } from '@/lib/account';
import { cx } from '@/lib/util';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /^[a-z0-9]/i.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('') || '·';

/** The signed-in owner in the top corner, opening onto Settings and Sign out. */
export function AccountMenu({
  business,
  name,
  email,
}: {
  business: string;
  name?: string;
  email?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const signOut = () => {
    setLeaving(true);
    logout()
      .catch(() => {})
      .finally(() => router.replace('/login'));
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-10 max-w-64 items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Avatar initials={initials(name || business)} size="sm" />
        <span className="sr-only">Account: </span>
        <span className="hidden truncate md:inline">{business}</span>
        <ChevronDown
          className={cx('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      <div
        id={panel}
        hidden={!open}
        className="absolute top-full right-0 z-50 mt-2 w-64 rounded-md border border-line bg-surface p-1.5 shadow-2"
      >
        <div className="border-b border-line px-2.5 pt-1.5 pb-2.5">
          <p className="truncate font-semibold text-ink">{name || business}</p>
          {(email || name) && <p className="truncate text-sm text-muted">{email || business}</p>}
        </div>
        <Link
          href="/app/settings"
          onClick={() => setOpen(false)}
          className="mt-1 flex h-10 items-center gap-2.5 rounded-sm px-2.5 text-[15px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <Settings className="size-4" aria-hidden /> Settings
        </Link>
        <button
          type="button"
          onClick={signOut}
          disabled={leaving}
          className="flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-[15px] text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
        >
          <LogOut className="size-4" aria-hidden /> {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}
