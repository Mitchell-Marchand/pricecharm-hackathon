'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/** Shown when a page crashes outright. It replaces the root layout, so it brings its own styles. */
export default function GlobalError({ error }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <title>Something went wrong · PriceCharm</title>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 16,
          fontFamily: 'system-ui, sans-serif',
          color: '#1f2328',
          background: '#fff',
        }}
      >
        <main style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Something went wrong on our side.</h1>
          <p style={{ margin: '0 0 20px', lineHeight: 1.5 }}>Reload the page to try again.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              font: 'inherit',
              padding: '10px 18px',
              minHeight: 44,
              borderRadius: 8,
              border: 0,
              background: '#1f2328',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
