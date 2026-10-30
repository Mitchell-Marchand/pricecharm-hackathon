'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  connectWhatsApp,
  disconnectWhatsApp,
  loadFacebook,
  whatsAppSignup,
  type WhatsApp,
} from '@/lib/whatsapp';

/** Connecting the business's own WhatsApp number, so the Charm answers customers there too. */
export function WhatsAppSettings({ initial }: { initial: WhatsApp }) {
  const notify = useToast();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const signup = state.signup;

  // Ready before the click, so Meta's popup isn't blocked.
  useEffect(() => {
    if (signup && !state.connected) loadFacebook(signup).catch(() => {});
  }, [signup, state.connected]);

  async function connect() {
    if (!signup) return;
    setBusy(true);
    try {
      const picked = await whatsAppSignup(signup);
      if (!picked) return;
      const saved = await connectWhatsApp(picked);
      setState(saved);
      notify(`Connected. Your Charm answers ${saved.connected?.number ?? 'your number'} now.`);
    } catch (connectError) {
      notify(errorMessage(connectError));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      setState(await disconnectWhatsApp());
      notify('Disconnected. Your Charm no longer answers on WhatsApp.');
    } catch (disconnectError) {
      notify(errorMessage(disconnectError));
    } finally {
      setBusy(false);
    }
  }

  if (state.connected)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-4">
        <p className="text-[15px]">
          Your Charm answers customers who message{' '}
          <span className="font-semibold">{state.connected.number}</span> on WhatsApp.
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-[15px] text-ink-2">
        Customers who message your business on WhatsApp get the same questions and quote as on your
        quote link. You&apos;ll log in to Facebook and pick your business&apos;s WhatsApp number.
      </p>
      <Button disabled={busy || !signup} onClick={() => void connect()}>
        {busy ? 'Connecting…' : 'Connect WhatsApp'}
      </Button>
    </div>
  );
}
