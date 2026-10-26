'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button, Logo, Notice } from './ui';

export default function Onboarding() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError('');
    api('/auth/me')
      .then(() => {
        if (active) router.replace('/dashboard');
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) router.replace('/login');
        else setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [router, attempt]);

  return (
    <main className="legacy-onboarding">
      <Logo />
      {error ? (
        <div>
          <Notice kind="error">{error}</Notice>
          <Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
        </div>
      ) : (
        <p role="status">Opening your assistant…</p>
      )}
    </main>
  );
}
