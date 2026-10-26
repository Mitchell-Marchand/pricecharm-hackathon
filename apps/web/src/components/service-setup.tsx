'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, LoaderCircle } from 'lucide-react';
import { ApiError, api, errorMessage, json, money } from '@/lib/api';
import type { Business, Example, JobNote, Message, Service, TrainingSession } from '@/lib/types';
import { Button, Notice } from './ui';

export type SetupSession = {
  id: string;
  status: 'active' | 'confirmed';
  version: number;
  messages: Message[];
  draft: {
    name: string | null;
    description: string;
    unitLabel: string | null;
    example: {
      title: string;
      description: string;
      quantity: number | null;
      finalPriceCents: number | null;
      rationale: string;
    } | null;
  };
  readyToConfirm: boolean;
  serviceId: string | null;
};

export type ServiceSetupProps = {
  business: Business;
  onStarted: (result: { service: Service; sessionId: string }) => void | Promise<void>;
  onCancel?: () => void;
  onAdvanced?: () => void;
  preferSavedJob?: boolean;
};

function rememberedSession(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberSession(key: string, id: string | null) {
  try {
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
  } catch {
    // The server also reuses the owner's active session when browser storage is unavailable.
  }
}

async function loadSetup(storageKey: string): Promise<SetupSession> {
  const remembered = rememberedSession(storageKey);
  if (remembered) {
    try {
      return await api<SetupSession>(`/service-setup/${encodeURIComponent(remembered)}`);
    } catch (error) {
      if (!(error instanceof ApiError) || ![400, 404, 410].includes(error.status)) throw error;
      rememberSession(storageKey, null);
    }
  }
  return api<SetupSession>('/service-setup', { method: 'POST', ...json({}) });
}

export function ServiceSetup({
  business,
  onStarted,
  onCancel,
  onAdvanced,
  preferSavedJob = false,
}: ServiceSetupProps) {
  const storageKey = `quotient:service-setup:${business.id}`;
  const [session, setSession] = useState<SetupSession>();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState<'loading' | 'sending' | 'starting' | ''>('loading');
  const [error, setError] = useState('');
  const [savedService, setSavedService] = useState<Service>();
  const [practiceId, setPracticeId] = useState('');
  const startup = useRef<{ key: string; promise: Promise<SetupSession> } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const mutation = useRef(false);
  const seedHandled = useRef(false);
  const savedExample = useRef(false);
  const savedNote = useRef(false);

  useEffect(() => {
    let active = true;
    if (!startup.current || startup.current.key !== storageKey) {
      const promise = loadSetup(storageKey);
      startup.current = { key: storageKey, promise };
    }
    startup.current.promise
      .then((result) => {
        if (!active) return;
        setSession(result);
        rememberSession(storageKey, result.id);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setBusy('');
      });
    return () => {
      active = false;
    };
  }, [storageKey]);

  useEffect(() => {
    const node = conversation.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [session?.messages.length, busy]);

  useEffect(() => {
    if (busy === '' && session?.status === 'active')
      composer.current?.focus({ preventScroll: true });
  }, [busy, session?.status]);

  async function refreshAfterConflict(cause: unknown) {
    if (
      !(cause instanceof ApiError) ||
      cause.status !== 409 ||
      !['SETUP_VERSION_CONFLICT', 'SETUP_PROCESSING'].includes(cause.code) ||
      !session
    )
      return false;
    try {
      const latest = await api<SetupSession>(`/service-setup/${session.id}`);
      setSession(latest);
      setError(
        cause.code === 'SETUP_PROCESSING'
          ? 'Your last reply is still being processed. Please try again in a moment.'
          : 'This conversation was updated elsewhere. Review the latest notes, then try again.',
      );
      return true;
    } catch {
      return false;
    }
  }

  async function send(message: string, consumeSeed = false) {
    if (!session || session.status !== 'active' || !message.trim() || mutation.current) return;
    mutation.current = true;
    setBusy('sending');
    setError('');
    try {
      const result = await api<SetupSession>(`/service-setup/${session.id}/messages`, {
        method: 'POST',
        ...json({ content: message.trim(), expectedVersion: session.version }),
      });
      setSession(result);
      setContent('');
      try {
        if (consumeSeed || sessionStorage.getItem('quotient:first-job')?.trim() === message.trim())
          sessionStorage.removeItem('quotient:first-job');
      } catch {
        /* Storage is optional. */
      }
    } catch (error) {
      if (!(await refreshAfterConflict(error))) setError(errorMessage(error));
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(content);
  }

  function enterToSend(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (busy === '') void send(content);
    }
  }

  async function startPractice() {
    if (!session || mutation.current || (!session.readyToConfirm && session.status !== 'confirmed'))
      return;
    mutation.current = true;
    setBusy('starting');
    setError('');
    try {
      let service = savedService;
      if (session.status === 'active') {
        const result = await api<{
          session: SetupSession;
          service: Service;
          example?: Example;
          jobNote?: JobNote;
          evidenceSaved?: 'price_example' | 'job_note' | 'service_only';
        }>(`/service-setup/${session.id}/confirm`, {
          method: 'POST',
          ...json({ expectedVersion: session.version }),
        });
        setSession(result.session);
        service = result.service;
        savedExample.current = Boolean(result.example);
        savedNote.current = result.evidenceSaved === 'job_note' || Boolean(result.jobNote);
        setSavedService(service);
      } else if (!service) {
        service = (await api<Service[]>('/services')).find((item) => item.id === session.serviceId);
        if (!service)
          throw new Error('Your saved service could not be found. Please refresh and try again.');
        setSavedService(service);
      }
      let sessionId = practiceId;
      if (!sessionId && !preferSavedJob) {
        const practice = await api<TrainingSession>('/training', {
          method: 'POST',
          ...json({ serviceId: service.id }),
        });
        sessionId = practice.id;
        setPracticeId(sessionId);
      }
      await onStarted({ service, sessionId });
      rememberSession(storageKey, null);
      try {
        sessionStorage.removeItem('quotient:first-job');
      } catch {
        /* Storage is optional. */
      }
    } catch (error) {
      if (!(await refreshAfterConflict(error))) setError(errorMessage(error));
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  async function retryLoading() {
    if (mutation.current) return;
    mutation.current = true;
    setError('');
    setBusy('loading');
    try {
      const result = await loadSetup(storageKey);
      setSession(result);
      rememberSession(storageKey, result.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  useEffect(() => {
    if (!session || busy || seedHandled.current || session.status !== 'active') return;
    seedHandled.current = true;
    try {
      const seed = sessionStorage.getItem('quotient:first-job');
      if (!seed?.trim()) return;
      setContent(seed);
      if (!session.messages.some((message) => message.role === 'user')) void send(seed, true);
    } catch {
      /* You can always paste the job directly when storage is unavailable. */
    }
  }, [session?.id, busy]);

  const confirmed = session?.status === 'confirmed';
  const draft = session?.draft;
  const canStart = !!session && (session.readyToConfirm || confirmed);
  const example = draft?.example;
  const hasShared = session?.messages.some((message) => message.role === 'user');

  return (
    <section className="introduction-canvas" aria-labelledby="service-setup-title">
      {onCancel && (
        <button className="text-button" onClick={onCancel} disabled={!!busy}>
          <ArrowLeft size={14} /> Back to your assistant
        </button>
      )}
      {!draft?.name && !draft?.description && (
        <div className="canvas-intro">
          <h2 id="service-setup-title">Add a past job</h2>
          <p>Describe the work, what you charged and why.</p>
        </div>
      )}
      {busy === 'loading' && !session && (
        <p className="quiet-loading">
          <LoaderCircle size={15} className="spin" /> Opening your conversation…
        </p>
      )}
      {busy === 'sending' && (
        <p className="quiet-loading" role="status">
          Reading what you shared…
        </p>
      )}
      {error && (
        <Notice kind="error">
          {error}
          {!session && !busy && (
            <button className="text-button" onClick={() => void retryLoading()}>
              Try again
            </button>
          )}
        </Notice>
      )}
      {(draft?.name || draft?.description) && (
        <section className="captured-job" aria-label="What your assistant understood">
          <h2 id="service-setup-title">{example?.title || draft.name || 'Your service'}</h2>
          {example?.finalPriceCents !== null && example?.finalPriceCents !== undefined && (
            <strong className="captured-price">
              {money(example.finalPriceCents, business.currency)}
            </strong>
          )}
          <p className="captured-description">{example?.description || draft.description}</p>
          {example?.rationale && (
            <div className="captured-reason">
              <span>Why you charged that</span>
              <p>{example.rationale}</p>
            </div>
          )}
          {example?.quantity !== null && example?.quantity !== undefined && (
            <p className="captured-measurement">
              {example.quantity.toLocaleString()} {draft.unitLabel || 'units'}
            </p>
          )}
          {example && draft.name && example.title !== draft.name && (
            <p className="captured-service-context">Saved under {draft.name}</p>
          )}
          <div className="captured-next">
            <Button
              onClick={() => void startPractice()}
              loading={busy === 'starting'}
              disabled={!canStart || !!busy}
            >
              {preferSavedJob
                ? example
                  ? 'Save this job'
                  : 'Save these notes'
                : 'Try a practice customer'}{' '}
              <ArrowRight size={15} />
            </Button>
            {example && <p>One job doesn’t set a standard rate.</p>}
          </div>
        </section>
      )}
      {hasShared && (
        <details className="introduction-history" open={!canStart}>
          <summary>
            Your note and replies <ChevronDown size={14} />
          </summary>
          <div
            className="introduction-messages qf-thread"
            ref={conversation}
            role="log"
            aria-live="polite"
            aria-label="Service conversation"
          >
            {session?.messages
              .filter((_, index) => index > 0)
              .map((message) => (
                <article
                  key={message.id}
                  className={
                    message.role === 'user' ? 'qf-message qf-message--outgoing' : 'qf-message'
                  }
                >
                  <div className="qf-message-body">
                    <span className="qf-message-author">
                      {message.role === 'user' ? 'You' : 'Quotefolk'}
                    </span>
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}
          </div>
        </details>
      )}
      {!confirmed && (
        <form className="qf-composer qf-composer--introduction" onSubmit={submit}>
          <label className="sr-only" htmlFor="service-setup-message">
            Tell us about a job you quoted
          </label>
          <textarea
            ref={composer}
            id="service-setup-message"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={enterToSend}
            placeholder={
              hasShared
                ? 'Add a detail or correct anything above…'
                : 'For example: I painted two rooms for $650. It included patching the walls, which added half a day…'
            }
            rows={hasShared ? 2 : 3}
            maxLength={5000}
            disabled={busy === 'sending' || busy === 'starting'}
          />
          <div className="qf-composer-actions">
            <Button
              type="submit"
              loading={busy === 'sending'}
              disabled={!session || !content.trim() || !!busy}
              aria-label="Send job details"
            >
              {hasShared ? 'Send' : 'Continue'}
            </Button>
          </div>
        </form>
      )}
      {!hasShared && !confirmed && (
        <div className="introduction-alternatives">
          <button
            className="text-button"
            onClick={() =>
              void send(
                'I don’t have a past quote handy. Please help me start by describing the service I offer; prices can wait.',
              )
            }
            disabled={!!busy}
          >
            I don’t have past quotes
          </button>
          {onAdvanced && (
            <button className="text-button" onClick={onAdvanced} disabled={!!busy}>
              I already have a price list
            </button>
          )}
        </div>
      )}
      {confirmed && (
        <p className="quiet-loading">
          {preferSavedJob
            ? savedNote.current
              ? 'Your note is saved. Opening your assistant…'
              : savedExample.current
                ? 'Job saved. Opening your assistant…'
                : 'Notes saved. Opening your assistant…'
            : 'Opening your practice customer…'}
        </p>
      )}
    </section>
  );
}

export default ServiceSetup;
