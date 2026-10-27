'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { loadProfile, loadViewer, savedAccess, type BusinessProfile } from '@/lib/chat';
import { QuoteChat } from './QuoteChat';

/** The chat, loading the business in the browser when the server couldn't. */
export function LoadedChat({
  slug,
  profile: initial,
  source,
  onClose,
}: {
  slug: string;
  profile: BusinessProfile | undefined;
  source: 'link' | 'widget';
  onClose?: () => void;
}) {
  const [profile, setProfile] = useState(initial);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (initial) return;
    loadProfile(slug)
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [initial, slug]);
  // Not taking requests: its owner can still test, and anyone already in a chat can finish it.
  useEffect(() => {
    if (!profile) return;
    if (profile.taking !== false || savedAccess(slug) || /[#&]chat=/.test(window.location.hash)) {
      setOpen(true);
      return;
    }
    // The page's copy can be a minute old, so a link deployed just now opens straight away.
    Promise.all([loadProfile(slug), loadViewer(slug)])
      .then(([fresh, viewer]) => setOpen(fresh.taking || viewer.owner))
      .catch(() => setOpen(false));
  }, [profile, slug]);
  if (profile && open)
    return <QuoteChat slug={slug} profile={profile} source={source} onClose={onClose} />;
  if (profile && open === false)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface p-6 text-center">
        <p className="font-semibold">{profile.name} isn’t taking quote requests here right now.</p>
        <p className="text-ink-2">Check back soon, or get in touch with them directly.</p>
      </div>
    );
  return (
    <div className="flex h-full items-center justify-center bg-surface p-6 text-center">
      {error ? (
        <p className="text-ink-2" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-muted" role="status">
          Loading…
        </p>
      )}
    </div>
  );
}
