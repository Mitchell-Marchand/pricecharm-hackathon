'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { keepCodeFromLink } from '@/lib/code';

/** Keeps a code from an outreach link until the owner gets to the plans. */
export function CodeFromLink() {
  const path = usePathname();
  useEffect(() => keepCodeFromLink(path), [path]);
  return null;
}
