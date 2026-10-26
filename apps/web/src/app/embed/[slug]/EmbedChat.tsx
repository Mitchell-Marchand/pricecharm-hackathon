'use client';

import { useEffect } from 'react';
import type { BusinessProfile } from '@/lib/chat';
import { LoadedChat } from '@/components/customer/LoadedChat';

/** Asks the business's page to hide the widget's frame. */
const close = () => window.parent.postMessage({ type: 'quotefolk:close' }, '*');

/** Inside the website widget's frame. */
export function EmbedChat({
  slug,
  profile,
}: {
  slug: string;
  profile: BusinessProfile | undefined;
}) {
  useEffect(() => {
    // Tells the widget the chat loaded, so it doesn't offer the quote page instead.
    window.parent.postMessage({ type: 'quotefolk:ready' }, '*');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <LoadedChat slug={slug} profile={profile} source="widget" onClose={close} />;
}
