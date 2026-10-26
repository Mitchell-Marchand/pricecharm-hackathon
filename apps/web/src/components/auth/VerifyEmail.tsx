'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui';
import { resendVerification, tokenFromLink, verifyEmail } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { AuthShell } from './AuthShell';

/** Opened from the link in the "Verify your email" message. */
export function VerifyEmail() {
  const [state, setState] = useState<'checking' | 'done' | 'failed'>('checking');
  const [error, setError] = useState('');
  const [resent, setResent] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = tokenFromLink();
    if (!token) {
      setState('failed');
      setError('This link isn’t complete. Open it from your email again.');
      return;
    }
    verifyEmail(token)
      .then(() => setState('done'))
      .catch((verifyError) => {
        setState('failed');
        setError(errorMessage(verifyError));
      });
  }, []);

  if (state === 'checking') return <AuthShell title="Confirming your email…">{null}</AuthShell>;
  if (state === 'done')
    return (
      <AuthShell
        title="Your email is confirmed"
        intro="Thanks. You’ll get an email when a quote needs you."
      >
        <ButtonLink href="/app" size="lg">
          Go to your quotes
        </ButtonLink>
      </AuthShell>
    );
  return (
    <AuthShell title="We couldn’t confirm your email" intro={error}>
      <div className="flex flex-col items-start gap-3">
        <Button
          size="lg"
          onClick={() =>
            resendVerification()
              .then(() => setResent('We sent a new link. Check your inbox.'))
              .catch((resendError) => setResent(errorMessage(resendError)))
          }
        >
          Send me a new link
        </Button>
        {resent && (
          <p className="text-ink-2" role="status">
            {resent}
          </p>
        )}
      </div>
    </AuthShell>
  );
}
