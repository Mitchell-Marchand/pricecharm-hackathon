'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { loadProfile, type BusinessProfile } from '@/lib/chat';
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
  useEffect(() => {
    if (initial) return;
    loadProfile(slug)
      .then(setProfile)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [initial, slug]);
  if (profile) return <QuoteChat slug={slug} profile={profile} source={source} onClose={onClose} />;
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
