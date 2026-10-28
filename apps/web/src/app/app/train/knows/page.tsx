'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { KnowsEditor } from '@/components/knows/CharmKnows';
import { errorMessage } from '@/lib/api';
import { loadKnows, type Knows } from '@/lib/knows';

export default function KnowsPage() {
  const [knows, setKnows] = useState<Knows | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadKnows()
      .then(setKnows)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);

  return (
    <>
      <Link
        href="/app/train"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Train
      </Link>
      <h1 className="t-h1 mt-4">What your Charm knows</h1>
      <p className="mt-3 max-w-2xl text-lg text-ink-2">
        What it asks customers and how it prices. Change anything here and it uses it from the next
        customer on.
      </p>
      {error && (
        <p className="mt-4 text-stop" role="alert">
          {error}
        </p>
      )}
      <div className="mt-12">
        {knows ? (
          <KnowsEditor knows={knows} onChange={setKnows} />
        ) : (
          !error && <div className="shimmer h-64 max-w-[680px] rounded-md" aria-busy="true" />
        )}
      </div>
    </>
  );
}
