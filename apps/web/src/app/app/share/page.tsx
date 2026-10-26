'use client';

import { useEffect, useState } from 'react';
import { useOwner } from '@/components/owner/OwnerShell';
import { ShareSections } from '@/components/share/ShareSections';
import { loadShare, type Share } from '@/lib/account';
import { errorMessage } from '@/lib/api';

export default function SharePage() {
  const { me } = useOwner();
  const [share, setShare] = useState<Share | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadShare()
      .then(setShare)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);
  return (
    <>
      <h1 className="t-h1">Share your quote link</h1>
      <p className="mt-3 max-w-xl text-lg text-ink-2">
        Customers get a quote anywhere they find you: your link, a QR code, or your website.
      </p>
      <div className="mt-10">
        {error ? (
          <p className="text-stop" role="alert">
            {error}
          </p>
        ) : share ? (
          <ShareSections business={me.business.name} share={share} onChange={setShare} />
        ) : (
          <div className="shimmer h-64 rounded-md" aria-busy="true" />
        )}
      </div>
    </>
  );
}
