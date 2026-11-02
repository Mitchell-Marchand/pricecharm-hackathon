'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { pixelPageView } from '@/lib/meta-pixel';

/** Tells Meta's pixel about each screen on the pages it runs on. Mounted once, in the root layout. */
export function MetaPixel() {
  const path = usePathname();
  useEffect(() => pixelPageView(), [path]);
  return null;
}
