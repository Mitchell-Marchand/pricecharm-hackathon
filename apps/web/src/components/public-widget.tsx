'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  PublicQuoteForm,
  PublicQuoteResult,
  privateReviewSubmission,
  type PublicQuoteSubmission,
} from './public-request';
import { api, ApiError, errorMessage, json } from '@/lib/api';
import type {
  PrivatePreviewProfile,
  PublicProfile,
  PublicService,
  PublicSession,
  Quote,
} from '@/lib/types';
import { Button, Modal, Notice } from './ui';
import styles from './public-widget.module.css';

type Upload = { id: string; filename: string; previewDataUrl: string };
type StartedInquiry = { token: string; session: PublicSession };
type ReturnAccess = { id: string; token: string; revision: number };
type RestartConfirmation = ReturnAccess & { url: string; submitted: boolean };

function privateRequestUrl(origin: string, slug: string, id: string, token: string) {
  const link = new URL(`/q/${encodeURIComponent(slug)}`, origin);
  link.hash = new URLSearchParams({ session: id, token }).toString();
  return link.href;
}

export default function PublicWidget({
  slug,
  embedded = false,
  previewProfile,
  initialProject,
  onQuoteReady,
}: {
  slug: string;
  embedded?: boolean;
  previewProfile?: PrivatePreviewProfile;
  initialProject?: string;
  onQuoteReady?: (quote: Quote) => void;
}) {
  const [profile, setProfile] = useState<PublicProfile>();
  const [session, setSession] = useState<PublicSession>();
  const [token, setToken] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const [copiedRequest, setCopiedRequest] = useState(false);
  const [requestLink, setRequestLink] = useState('');
  const [restartConfirmation, setRestartConfirmation] = useState<RestartConfirmation>();
  const [quoteAttemptSession, setQuoteAttemptSession] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [starting, setStarting] = useState('');
  const [sending, setSending] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [preparingQuote, setPreparingQuote] = useState(false);
  const [hasDetailsDraft, setHasDetailsDraft] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [failedPhoto, setFailedPhoto] = useState<File>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [latestMessageHint, setLatestMessageHint] = useState('');
  const linkAccess = useRef<{ id: string; token: string; serviceId: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const quoteRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestFormRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const latestCueComposerFocus = useRef(false);
  const latestHintRef = useRef('');
  const receiptPosition = useRef<{
    sessionId: string;
    quoteId: string;
    status: Quote['status'];
    marker: string | null;
    tailId?: string;
  } | null>(null);
  const returnToComposer = useRef<{ id: string; revision: number } | null>(null);
  const sessionRevision = useRef(0);
  const quoteAttemptRef = useRef('');
  const decisionFlight = useRef<object | null>(null);
  const startFlight = useRef<Promise<StartedInquiry | undefined> | null>(null);
  const interacting = useRef<object | null>(null);
  const sessionAccess = useRef<(StartedInquiry & { serviceId: string }) | undefined>(undefined);
  const contentRef = useRef(content);
  contentRef.current = content;
  if (session && token) sessionAccess.current = { session, token, serviceId };
  const followingConversation = useRef(true);
  const pendingUploadFocus = useRef<{ id: string; sessionId: string } | null>(null);
  const requestingRef = useRef(requesting);
  requestingRef.current = requesting;
  const hydratedDraft = useRef('');
  const currentSessionId = useRef(session?.id);
  currentSessionId.current = session?.id;
  const previewRef = useRef(previewProfile);
  previewRef.current = previewProfile;
  const initialProjectRef = useRef(initialProject);
  initialProjectRef.current = initialProject;
  const onQuoteReadyRef = useRef(onQuoteReady);
  onQuoteReadyRef.current = onQuoteReady;
  const headers = useCallback((value = token) => ({ Authorization: `Bearer ${value}` }), [token]);
  const base = `/public/${encodeURIComponent(slug)}`;
  const privatePreview = !!previewProfile;
  const previewScope = previewProfile?.services
    .map((item) => `${item.id}@${item.version}`)
    .sort()
    .join(',');
  const storageKey = privatePreview
    ? `quotient:playground:${slug}:${previewScope}`
    : `quotient:${slug}`;
  const onlyService = profile?.services.length === 1 ? profile.services[0] : undefined;
  const lazyPublicEntry = !privatePreview && !!onlyService;
  const idleHostedEntry = !embedded && lazyPublicEntry && !session && !restoring;
  const idleEmbeddedEntry = embedded && lazyPublicEntry && !session && !restoring;
  const idleDraftKey = privatePreview
    ? `${storageKey}:draft:new`
    : onlyService
      ? `${storageKey}:service:${onlyService.id}@${onlyService.version}:draft:new`
      : '';
  const draftKey = session ? `${storageKey}:draft:${session.id}` : idleDraftKey;
  const liveReceipt = !privatePreview && !!quote && !!session;
  const activeLiveFollowup =
    liveReceipt && (quote?.status === 'review' || quote?.status === 'issued');
  const markerId = quote?.receiptAfterMessageId;
  const receiptMarkerIndex =
    liveReceipt &&
    typeof markerId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(markerId)
      ? session!.messages.findIndex((message) => message.id === markerId)
      : -1;
  const receiptMarker = receiptMarkerIndex >= 0 ? markerId! : null;
  const laterMessages = liveReceipt ? session!.messages.slice(receiptMarkerIndex + 1) : [];
  const latestMessageId = laterMessages.at(-1)?.id;
  const latestContext =
    liveReceipt && latestMessageId && !restoring
      ? `${session!.id}:${quote!.id}:${latestMessageId}`
      : '';
  const latestContextRef = useRef(latestContext);
  latestContextRef.current = latestContext;
  const updateLatestMessageHint = useCallback(() => {
    const body = chatBodyRef.current;
    const message = latestMessageRef.current;
    let next = '';
    if (latestContextRef.current && body?.isConnected && message?.isConnected) {
      const viewport = body.getBoundingClientRect();
      const start = message.getBoundingClientRect();
      const paragraph = message.querySelector('p');
      const firstLineBottom = paragraph
        ? paragraph.getBoundingClientRect().top +
          Math.min(
            paragraph.getBoundingClientRect().height,
            Number.parseFloat(window.getComputedStyle(paragraph).lineHeight),
          )
        : start.bottom;
      // Reading the body of a long final message is already being at that message.
      if (
        start.top >= Math.max(viewport.top, 0) - 1 &&
        firstLineBottom > Math.min(viewport.bottom, window.innerHeight) + 1
      )
        next = latestContextRef.current;
    }
    if (latestHintRef.current !== next) {
      latestHintRef.current = next;
      setLatestMessageHint(next);
    }
  }, []);
  const revealLatestMessage = useCallback(() => {
    const body = chatBodyRef.current;
    const message = latestMessageRef.current;
    if (!latestContextRef.current || !body || !message?.isConnected) return;
    body.scrollTo({
      top: body.scrollTop + message.getBoundingClientRect().top - body.getBoundingClientRect().top,
      behavior: 'instant',
    });
    updateLatestMessageHint();
  }, [updateLatestMessageHint]);
  useEffect(() => {
    if (!privatePreview || !session || restoring || requesting) {
      setHasDetailsDraft(true);
      return;
    }
    try {
      setHasDetailsDraft(window.sessionStorage.getItem(`${draftKey}:details`) !== null);
    } catch {
      // Review the form when existing edits cannot be checked safely.
      setHasDetailsDraft(true);
    }
  }, [privatePreview, session?.id, draftKey, restoring, requesting]);
  useEffect(() => {
    if (quote) onQuoteReadyRef.current?.(quote);
  }, [quote?.id, quote?.status]);
  useEffect(() => {
    if (previewProfile) setProfile(previewProfile);
  }, [previewProfile]);
  useEffect(() => {
    if (privatePreview) return;
    const openFragment = () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      if (fragment.get('session')?.trim() && fragment.get('token')?.trim())
        setLoadAttempt((value) => value + 1);
    };
    window.addEventListener('hashchange', openFragment);
    return () => window.removeEventListener('hashchange', openFragment);
  }, [privatePreview]);
  useEffect(() => {
    let cancelled = false;
    sessionRevision.current += 1;
    const revision = sessionRevision.current;
    const desiredProfile = previewRef.current;
    startFlight.current = null;
    interacting.current = null;
    sessionAccess.current = undefined;
    pendingUploadFocus.current = null;
    returnToComposer.current = null;
    receiptPosition.current = null;
    quoteAttemptRef.current = '';
    decisionFlight.current = null;
    setQuoteAttemptSession('');
    setRestartConfirmation(undefined);
    setDeciding(false);
    setRestoring(true);
    setLoadError('');
    setSession(undefined);
    setToken('');
    setQuote(undefined);
    setServiceId('');
    setUploads([]);
    setFailedPhoto(undefined);
    setSending(false);
    setPreparingQuote(false);
    setUploading(false);
    setStarting('');
    let initialDraft = desiredProfile ? initialProjectRef.current?.trim().slice(0, 5000) || '' : '';
    if (desiredProfile) {
      try {
        const raw = window.sessionStorage.getItem(`${storageKey}:draft:new`);
        const draft = raw ? JSON.parse(raw) : undefined;
        if (typeof draft?.content === 'string') initialDraft = draft.content.slice(0, 5000);
      } catch {
        /* Private tests still work without draft storage. */
      }
    }
    setContent(initialDraft);
    setRequesting(false);
    setCopiedRequest(false);
    setRequestLink('');
    followingConversation.current = true;
    hydratedDraft.current = desiredProfile ? `${storageKey}:draft:new` : '';
    linkAccess.current = null;
    const parameters = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentAccess = fragment.has('session') && fragment.has('token');
    const linkId = fragmentAccess ? fragment.get('session') : parameters.get('session');
    const linkToken = fragmentAccess ? fragment.get('token') : parameters.get('token');
    if (linkId && linkToken && !privatePreview) {
      linkAccess.current = { id: linkId, token: linkToken, serviceId: '' };
    }
    if (parameters.has('session') || parameters.has('token') || fragmentAccess) {
      parameters.delete('session');
      parameters.delete('token');
      fragment.delete('session');
      fragment.delete('token');
      window.history.replaceState(
        {},
        '',
        window.location.pathname +
          (parameters.size ? '?' + parameters.toString() : '') +
          (fragmentAccess
            ? fragment.size
              ? '#' + fragment.toString()
              : ''
            : window.location.hash),
      );
    }
    if (linkAccess.current) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(linkAccess.current));
      } catch {
        /* Opening a private link does not require browser storage. */
      }
    }
    async function openRequest() {
      const result = desiredProfile || (await api<PublicProfile>(base));
      if (cancelled || revision !== sessionRevision.current) return;
      setProfile(result);
      if (!desiredProfile && result.services.length === 1) {
        const only = result.services[0];
        const idleKey = `${storageKey}:service:${only.id}@${only.version}:draft:new`;
        try {
          const draft = JSON.parse(window.sessionStorage.getItem(idleKey) || 'null');
          if (typeof draft?.content === 'string') setContent(draft.content.slice(0, 5000));
        } catch {
          /* Optional draft storage. */
        }
        hydratedDraft.current = idleKey;
      }
      let saved = linkAccess.current;
      if (!saved) {
        try {
          const raw = window.localStorage.getItem(storageKey);
          if (raw) saved = JSON.parse(raw);
        } catch {
          /* An unavailable browser store does not prevent a new request. */
        }
      }
      if (!saved) return;
      if (
        typeof saved.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(saved.id) ||
        typeof saved.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(saved.token)
      ) {
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
        return;
      }
      let restored: PublicSession;
      try {
        restored = await api<PublicSession>(`${base}/sessions/${encodeURIComponent(saved.id)}`, {
          headers: { Authorization: `Bearer ${saved.token}` },
        });
      } catch (cause) {
        if (!(cause instanceof ApiError) || ![400, 401, 404, 410].includes(cause.status))
          throw cause;
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
        if (!cancelled)
          setError('This saved request is unavailable. You can start a new request below.');
        return;
      }
      if (
        (desiredProfile &&
          !desiredProfile.services.some(
            (item) => item.id === restored.serviceId && item.version === restored.serviceVersion,
          )) ||
        (desiredProfile && restored.source !== 'playground')
      ) {
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
        return;
      }
      if (cancelled || revision !== sessionRevision.current) return;
      sessionAccess.current = {
        session: restored,
        token: saved.token,
        serviceId:
          restored.serviceId ||
          saved.serviceId ||
          restored.quote?.serviceId ||
          result.services[0]?.id ||
          '',
      };
      setSession(restored);
      setToken(saved.token);
      setContent('');
      setServiceId(
        restored.serviceId ||
          saved.serviceId ||
          restored.quote?.serviceId ||
          result.services[0]?.id ||
          '',
      );
      setQuote(restored.quote);
      const key = `${storageKey}:draft:${restored.id}`;
      try {
        const raw = window.sessionStorage.getItem(key);
        const draft = raw ? JSON.parse(raw) : undefined;
        if (draft && typeof draft.content === 'string') setContent(draft.content.slice(0, 5000));
        if (!restored.quote && draft?.requesting === true) setRequesting(true);
        if (!desiredProfile && !restored.quote && draft?.quoteAttempted === true) {
          quoteAttemptRef.current = restored.id;
          setQuoteAttemptSession(restored.id);
        }
      } catch {
        /* Sent messages remain available when draft storage is unavailable. */
      }
      hydratedDraft.current = key;
      const photos = await api<Upload[]>(
        `${base}/sessions/${encodeURIComponent(saved.id)}/uploads`,
        {
          headers: { Authorization: `Bearer ${saved.token}` },
        },
      ).catch(() => []);
      if (!cancelled && revision === sessionRevision.current) setUploads(photos);
    }
    openRequest()
      .catch((cause) => {
        if (!cancelled && revision === sessionRevision.current) setLoadError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled && revision === sessionRevision.current) setRestoring(false);
      });
    return () => {
      cancelled = true;
      sessionRevision.current += 1;
    };
  }, [base, slug, storageKey, privatePreview, loadAttempt]);
  useEffect(() => {
    if (restoring || !draftKey || hydratedDraft.current !== draftKey) return;
    try {
      window.sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          content,
          requesting,
          ...(session?.id && quoteAttemptSession === session.id ? { quoteAttempted: true } : {}),
        }),
      );
    } catch {
      /* Typing and sending still work without draft storage. */
    }
  }, [content, requesting, draftKey, restoring, quoteAttemptSession, session?.id]);
  useEffect(() => {
    if (quote && session?.id && quoteAttemptSession === session.id) {
      quoteAttemptRef.current = '';
      setQuoteAttemptSession('');
    }
  }, [quote?.id, session?.id, quoteAttemptSession]);
  useEffect(() => {
    if (
      !requesting ||
      restoring ||
      !session ||
      currentSessionId.current !== session.id ||
      hydratedDraft.current !== draftKey
    )
      return;
    const body = chatBodyRef.current;
    const form = requestFormRef.current;
    if (privatePreview && !quote) form?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else if (body && form)
      body.scrollTo({
        top: body.scrollTop + form.getBoundingClientRect().top - body.getBoundingClientRect().top,
        behavior: 'auto',
      });
  }, [requesting, restoring, privatePreview, session?.id, quote?.id, draftKey]);
  useEffect(() => {
    if (
      !restoring &&
      !requesting &&
      !quote &&
      followingConversation.current &&
      !pendingUploadFocus.current &&
      !returnToComposer.current
    )
      endRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [session?.messages.length, uploads.length, quote?.id, restoring, requesting]);
  useEffect(() => {
    const pending = returnToComposer.current;
    if (!pending || requesting || restoring) return;
    returnToComposer.current = null;
    if (
      !privatePreview ||
      quote ||
      session?.id !== pending.id ||
      sessionRevision.current !== pending.revision
    )
      return;
    const composer = composerRef.current;
    if (!composer) return;
    composer.focus({ preventScroll: true });
    (composer.form || composer).scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [privatePreview, requesting, restoring, session?.id, quote?.id]);
  useEffect(() => {
    pendingUploadFocus.current = null;
  }, [quote?.id, requesting]);
  function revealUploadedPhoto(image: HTMLImageElement, id: string) {
    requestAnimationFrame(() => {
      const pending = pendingUploadFocus.current;
      if (
        !pending ||
        pending.id !== id ||
        pending.sessionId !== currentSessionId.current ||
        !image.isConnected ||
        requestingRef.current
      )
        return;
      image.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      pendingUploadFocus.current = null;
    });
  }
  useEffect(() => {
    const pending = pendingUploadFocus.current;
    if (!pending) return;
    const image = chatBodyRef.current?.querySelector<HTMLImageElement>(
      `img[data-upload-id="${CSS.escape(pending.id)}"]`,
    );
    if (image?.complete && image.naturalWidth) revealUploadedPhoto(image, pending.id);
  }, [uploads.length]);
  useEffect(() => {
    const body = chatBodyRef.current;
    const result = quoteRef.current;
    if (quote && !restoring && body && result) {
      if (privatePreview) {
        result.scrollIntoView({ block: 'start', behavior: 'instant' });
        return;
      }
      if (!session) return;
      const previous = receiptPosition.current;
      const entry =
        !previous ||
        previous.sessionId !== session.id ||
        previous.quoteId !== quote.id ||
        previous.status !== quote.status ||
        previous.marker !== receiptMarker;
      receiptPosition.current = {
        sessionId: session.id,
        quoteId: quote.id,
        status: quote.status,
        marker: receiptMarker,
        tailId: latestMessageId,
      };
      if (entry) {
        body.scrollTo({
          top:
            body.scrollTop + result.getBoundingClientRect().top - body.getBoundingClientRect().top,
          behavior: 'instant',
        });
        followingConversation.current = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      } else if (previous.tailId !== latestMessageId && followingConversation.current)
        revealLatestMessage();
      updateLatestMessageHint();
    }
  }, [
    quote?.id,
    quote?.status,
    restoring,
    privatePreview,
    session?.id,
    receiptMarker,
    latestMessageId,
    revealLatestMessage,
    updateLatestMessageHint,
  ]);
  useEffect(() => {
    if (!latestContext) {
      updateLatestMessageHint();
      return;
    }
    let active = true;
    const update = () => {
      if (active) updateLatestMessageHint();
    };
    const observer = new ResizeObserver(update);
    for (const element of [chatBodyRef.current, quoteRef.current, latestMessageRef.current])
      if (element) observer.observe(element);
    window.addEventListener('resize', update);
    update();
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [latestContext, updateLatestMessageHint]);
  useEffect(() => {
    if (
      !session ||
      !token ||
      preparingQuote ||
      quote?.status === 'accepted' ||
      quote?.status === 'declined'
    )
      return;
    const timer = setInterval(async () => {
      const revision = sessionRevision.current;
      try {
        const updated = await api<PublicSession>(`${base}/sessions/${session.id}`, {
          headers: headers(),
        });
        if (revision !== sessionRevision.current || currentSessionId.current !== updated.id) return;
        setSession((current) =>
          current && current.messages.length <= updated.messages.length ? updated : current,
        );
        if (updated.quote) setQuote(updated.quote);
      } catch {
        /* A temporary polling failure should not interrupt the customer. */
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [base, headers, session?.id, token, quote?.status, preparingQuote]);
  async function start(
    service: PublicService,
    firstMessage?: string,
  ): Promise<StartedInquiry | undefined> {
    if (startFlight.current) return startFlight.current;
    const revision = ++sessionRevision.current;
    setStarting(service.id);
    setError('');
    const operation = (async () => {
      try {
        const existing = sessionAccess.current;
        const result: StartedInquiry =
          existing?.serviceId === service.id
            ? existing
            : await api<StartedInquiry>(
                privatePreview ? '/playground/sessions' : `${base}/sessions`,
                {
                  method: 'POST',
                  ...json({ serviceId: service.id }),
                },
              );
        if (revision !== sessionRevision.current) return;
        const key = `${storageKey}:draft:${result.session.id}`;
        sessionAccess.current = { ...result, serviceId: service.id };
        hydratedDraft.current = key;
        setSession(result.session);
        setToken(result.token);
        setServiceId(service.id);
        setQuote(undefined);
        setUploads([]);
        setRequesting(false);
        let draftSaved = false;
        let accessSaved = false;
        try {
          window.sessionStorage.setItem(
            key,
            JSON.stringify({ content: contentRef.current, requesting: false }),
          );
          draftSaved = true;
        } catch {
          /* Optional draft storage. */
        }
        try {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify({ id: result.session.id, token: result.token, serviceId: service.id }),
          );
          accessSaved = true;
        } catch {
          /* The request still works without persistent access. */
        }
        if (draftSaved && accessSaved && idleDraftKey) {
          try {
            window.sessionStorage.removeItem(idleDraftKey);
          } catch {
            /* Optional draft storage. */
          }
        }
        if (firstMessage) {
          setSending(true);
          const reply = await api<{ session: PublicSession; quote?: Quote }>(
            `${base}/sessions/${result.session.id}/messages`,
            { method: 'POST', headers: headers(result.token), ...json({ content: firstMessage }) },
          );
          if (revision !== sessionRevision.current) return;
          sessionAccess.current = {
            session: reply.session,
            token: result.token,
            serviceId: service.id,
          };
          setSession(reply.session);
          if (reply.quote) setQuote(reply.quote);
          setContent((current) => (current.trim() === firstMessage ? '' : current));
          return { session: reply.session, token: result.token };
        }
        return result;
      } catch (error) {
        if (revision === sessionRevision.current) setError(errorMessage(error));
      } finally {
        if (revision === sessionRevision.current) {
          setStarting('');
          setSending(false);
        }
      }
    })();
    startFlight.current = operation;
    try {
      return await operation;
    } finally {
      if (startFlight.current === operation) startFlight.current = null;
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim() || interacting.current || startFlight.current || sending || uploading)
      return;
    const submitted = content.trim();
    followingConversation.current = true;
    if (!session) {
      if (!lazyPublicEntry || !onlyService) return;
      const interaction = {};
      interacting.current = interaction;
      try {
        await start(onlyService, submitted);
      } finally {
        if (interacting.current === interaction) interacting.current = null;
      }
      return;
    }
    const interaction = {};
    interacting.current = interaction;
    const revision = ++sessionRevision.current;
    if (liveReceipt) followingConversation.current = true;
    setSending(true);
    setError('');
    try {
      const result = await api<{ session: PublicSession; quote?: Quote }>(
        `${base}/sessions/${session.id}/messages`,
        { method: 'POST', headers: headers(), ...json({ content: submitted }) },
      );
      if (revision !== sessionRevision.current) return;
      setSession(result.session);
      if (result.quote) setQuote(result.quote);
      setContent((current) => (current.trim() === submitted ? '' : current));
    } catch (error) {
      if (revision === sessionRevision.current) setError(errorMessage(error));
    } finally {
      if (interacting.current === interaction) interacting.current = null;
      if (revision === sessionRevision.current) setSending(false);
    }
  }
  async function upload(file?: File) {
    if (!file || interacting.current || startFlight.current || uploading || sending) return;
    if (file.size > 8 * 1024 * 1024) {
      setError('Please choose a photo smaller than 8 MB.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Please choose a JPEG, PNG, or WebP photo.');
      return;
    }
    const interaction = {};
    interacting.current = interaction;
    setUploading(true);
    setError('');
    let revision = sessionRevision.current;
    try {
      const access =
        session && token
          ? { session, token }
          : onlyService && lazyPublicEntry
            ? await start(onlyService)
            : undefined;
      if (!access) {
        if (interacting.current === interaction) setFailedPhoto(file);
        return;
      }
      revision = ++sessionRevision.current;
      const form = new FormData();
      form.set('file', file);
      const result = await api<Upload>(`${base}/sessions/${access.session.id}/uploads`, {
        method: 'POST',
        headers: headers(access.token),
        body: form,
      });
      if (revision !== sessionRevision.current) return;
      followingConversation.current = true;
      pendingUploadFocus.current = { id: result.id, sessionId: access.session.id };
      setUploads((previous) => [...previous, result]);
      setFailedPhoto(undefined);
    } catch (error) {
      if (revision === sessionRevision.current) {
        setError(errorMessage(error));
        setFailedPhoto(file);
      }
    } finally {
      const ownsInteraction = interacting.current === interaction;
      if (ownsInteraction) interacting.current = null;
      if (ownsInteraction && (revision === sessionRevision.current || !sessionAccess.current)) {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    }
  }
  async function openQuoteForm() {
    if (interacting.current || startFlight.current || uploading || sending) return;
    if (session) {
      setRequesting(true);
      return;
    }
    if (!lazyPublicEntry || !onlyService) return;
    const interaction = {};
    interacting.current = interaction;
    try {
      if (await start(onlyService)) setRequesting(true);
    } finally {
      if (interacting.current === interaction) interacting.current = null;
    }
  }
  async function submitQuote(payload: PublicQuoteSubmission) {
    if (!session || interacting.current || startFlight.current || uploading || sending)
      throw new Error('Please wait for the current request to finish.');
    const interaction = {};
    interacting.current = interaction;
    const revision = ++sessionRevision.current;
    setPreparingQuote(true);
    if (!privatePreview) {
      quoteAttemptRef.current = session.id;
      setQuoteAttemptSession(session.id);
      try {
        const key = `${storageKey}:draft:${session.id}`;
        window.sessionStorage.setItem(
          key,
          JSON.stringify({
            content: contentRef.current,
            requesting: requestingRef.current,
            quoteAttempted: true,
          }),
        );
      } catch {
        /* The same-page guard works even when draft storage is unavailable. */
      }
    }
    try {
      const result = await api<Quote>(`${base}/sessions/${session.id}/quote`, {
        method: 'POST',
        headers: headers(),
        ...json(payload),
      });
      if (revision !== sessionRevision.current) return;
      setSession((current) =>
        current?.id === session.id
          ? {
              ...current,
              collectedInputs: { ...current.collectedInputs, ...payload.inputs },
            }
          : current,
      );
      setQuote(result);
      setRequesting(false);
      // The accepted quote and its confirmed inputs remain usable if this GET fails.
      const refreshed = await api<PublicSession>(`${base}/sessions/${session.id}`, {
        headers: headers(),
      }).catch(() => undefined);
      if (refreshed && revision === sessionRevision.current) setSession(refreshed);
    } finally {
      if (interacting.current === interaction) interacting.current = null;
      if (revision === sessionRevision.current) setPreparingQuote(false);
    }
  }
  function backToChat() {
    if (privatePreview && session)
      returnToComposer.current = { id: session.id, revision: sessionRevision.current };
    setRequesting(false);
  }
  function restart() {
    sessionRevision.current += 1;
    startFlight.current = null;
    interacting.current = null;
    sessionAccess.current = undefined;
    pendingUploadFocus.current = null;
    returnToComposer.current = null;
    receiptPosition.current = null;
    quoteAttemptRef.current = '';
    decisionFlight.current = null;
    try {
      if (draftKey) {
        window.sessionStorage.removeItem(draftKey);
        window.sessionStorage.removeItem(`${draftKey}:details`);
        if (idleDraftKey) window.sessionStorage.removeItem(idleDraftKey);
      }
    } catch {
      /* Optional draft storage. */
    }
    hydratedDraft.current = idleDraftKey;
    followingConversation.current = true;
    setContent('');
    setSending(false);
    setPreparingQuote(false);
    setUploading(false);
    setStarting('');
    setFailedPhoto(undefined);
    setSession(undefined);
    setQuote(undefined);
    setToken('');
    setUploads([]);
    setRequesting(false);
    setError('');
    setCopiedRequest(false);
    setRequestLink('');
    setRestartConfirmation(undefined);
    setQuoteAttemptSession('');
    setDeciding(false);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* Optional storage. */
    }
  }
  const submittedRequest =
    !!quote ||
    (!!session && ['submitted', 'issued', 'accepted', 'declined'].includes(session.status || ''));
  const guardedRestart =
    !privatePreview &&
    !!session &&
    !!token &&
    (submittedRequest || quoteAttemptSession === session.id);
  const liveBusy = sending || uploading || preparingQuote || deciding || !!starting;
  function currentAccess(access: ReturnAccess) {
    return (
      access.revision === sessionRevision.current &&
      access.id === currentSessionId.current &&
      access.token === sessionAccess.current?.token
    );
  }
  function restartBusy() {
    return liveBusy || !!interacting.current || !!startFlight.current || !!decisionFlight.current;
  }
  function askToRestart() {
    const attemptedLiveQuote =
      !privatePreview && !!session && !!token && quoteAttemptRef.current === session.id;
    if (!guardedRestart && !attemptedLiveQuote) {
      restart();
      return;
    }
    if (!session || restartBusy()) return;
    setRestartConfirmation({
      id: session.id,
      token,
      revision: sessionRevision.current,
      url: privateRequestUrl(window.location.origin, slug, session.id, token),
      submitted: submittedRequest,
    });
  }
  function confirmRestart() {
    if (!restartConfirmation || !currentAccess(restartConfirmation) || restartBusy()) {
      setRestartConfirmation(undefined);
      return;
    }
    restart();
  }
  async function copyRequestLink(access?: ReturnAccess) {
    if (!session || !token || privatePreview) return;
    const target = access || { id: session.id, token, revision: sessionRevision.current };
    if (!currentAccess(target)) return;
    const link = privateRequestUrl(window.location.origin, slug, target.id, target.token);
    try {
      await navigator.clipboard.writeText(link);
      if (!currentAccess(target)) return;
      setCopiedRequest(true);
      setRequestLink('');
    } catch {
      if (currentAccess(target)) setRequestLink(link);
    }
  }
  const service = profile?.services.find((value) => value.id === serviceId) || onlyService;
  const projectDescription = [
    ...(session?.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content) || []),
    ...(content.trim() ? [content.trim()] : []),
  ]
    .join('\n')
    .slice(0, 5000);
  const directSubmission =
    privatePreview && session && !hasDetailsDraft && !content.trim() && !failedPhoto
      ? privateReviewSubmission(session, projectDescription)
      : undefined;
  const messageElements = (session?.messages || []).map((message) => (
    <div
      className={`message qf-message ${message.role === 'user' ? 'owner qf-message--outgoing' : 'assistant'}`}
      key={`message:${message.id}`}
      data-message-id={message.id}
      ref={liveReceipt && message.id === latestMessageId ? latestMessageRef : undefined}
      tabIndex={liveReceipt && message.id === latestMessageId ? -1 : undefined}
    >
      <div className="qf-message-body">
        <span className="message-role qf-message-author">
          {message.role === 'user'
            ? 'You'
            : message.author === 'owner'
              ? 'Business owner'
              : 'Quote assistant'}
        </span>
        <p>{message.content}</p>
      </div>
    </div>
  ));
  const photoElement = uploads.length > 0 && (
    <div className="public-photos" key="project-photos">
      <span>Project photos</span>
      <div>
        {uploads.map((upload) => (
          <figure key={upload.id}>
            <img
              src={upload.previewDataUrl}
              data-upload-id={upload.id}
              onLoad={(event) => revealUploadedPhoto(event.currentTarget, upload.id)}
              alt={`Project photo: ${upload.filename}`}
            />
            <figcaption>{upload.filename}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
  const quoteElement = quote && session && (
    <div className="public-quote-anchor" ref={quoteRef} key={`quote:${quote.id}`}>
      <PublicQuoteResult
        quote={quote}
        session={session}
        photoCount={uploads.length}
        privatePreview={privatePreview}
        reviewReason={session.reviewReason}
        onDecision={async (decision) => {
          if (interacting.current || decisionFlight.current)
            throw new Error('Please wait for the current request to finish.');
          const operation = {};
          decisionFlight.current = operation;
          interacting.current = operation;
          setDeciding(true);
          const revision = ++sessionRevision.current;
          try {
            const updated = await api<Quote>(`${base}/sessions/${session.id}/decision`, {
              method: 'POST',
              headers: headers(),
              ...json({ decision }),
            });
            if (revision !== sessionRevision.current) return;
            setQuote(updated);
            const refreshed = await api<PublicSession>(`${base}/sessions/${session.id}`, {
              headers: headers(),
            });
            if (revision === sessionRevision.current) setSession(refreshed);
          } finally {
            if (interacting.current === operation) interacting.current = null;
            if (decisionFlight.current === operation) {
              decisionFlight.current = null;
              setDeciding(false);
            }
          }
        }}
      />
      {!privatePreview && (
        <div className={styles.resume}>
          <p>
            {session.contact?.verified
              ? 'Replies appear here. Email updates go to your verified address.'
              : 'Replies appear here. Keep this private link to come back.'}
          </p>
          <button className="text-button" type="button" onClick={() => void copyRequestLink()}>
            {copiedRequest ? 'Request link copied' : 'Copy request link'}
          </button>
          {requestLink && (
            <label>
              Your private request link
              <input
                readOnly
                value={requestLink}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
  const timeline = liveReceipt
    ? [
        ...messageElements.slice(0, receiptMarkerIndex + 1),
        quoteElement,
        photoElement,
        ...messageElements.slice(receiptMarkerIndex + 1),
      ]
    : [...messageElements, photoElement, quoteElement];
  return (
    <main
      className={`public-page public-widget ${embedded ? 'embedded' : styles.hosted} ${idleHostedEntry ? styles.idleEntry : ''} ${idleEmbeddedEntry ? styles.idleEmbeddedEntry : ''} ${activeLiveFollowup ? styles.activeFollowup : ''} ${privatePreview && quote ? styles.completedPreview : ''} ${privatePreview && requesting && !quote ? styles.reviewPreview : ''}`}
    >
      {!embedded && (
        <header className="public-topbar">
          <Link href="/" aria-label="Quotefolk home">
            Quotefolk
          </Link>
        </header>
      )}
      {loadError ? (
        <section className="public-unavailable">
          <h1>Online quotes are unavailable.</h1>
          <p>{loadError}</p>
          <p>Please contact the business directly to discuss your project.</p>
          <button className="text-button" onClick={() => setLoadAttempt((value) => value + 1)}>
            Try again
          </button>
        </section>
      ) : !profile || restoring ? (
        <div className="public-loading">
          <LoaderCircle className="spin" size={26} />
          <p>Loading quote request…</p>
        </div>
      ) : (
        <div className="public-layout">
          <section className="public-chat-card">
            {privatePreview && (
              <p className="public-test-status">
                Private test. We won’t contact customers or charge you.
              </p>
            )}
            {(!privatePreview || session) && (
              <header className="public-chat-header">
                <div>
                  {privatePreview ? (
                    <strong>{service?.name || 'Customer test'}</strong>
                  ) : activeLiveFollowup ? (
                    embedded ? (
                      <h2 className={styles.businessHeading}>{profile.business.name}</h2>
                    ) : (
                      <h1 className={styles.businessHeading}>{profile.business.name}</h1>
                    )
                  ) : (
                    <>
                      <strong>{profile.business.name}</strong>
                      {embedded ? (
                        <h2 className="public-request-heading">
                          {quote ? 'Your request' : 'Request a quote'}
                        </h2>
                      ) : (
                        <h1 className="public-request-heading">
                          {quote ? 'Your request' : 'Request a quote'}
                        </h1>
                      )}
                    </>
                  )}
                </div>
                {session && (
                  <button
                    className="text-button public-restart-button"
                    disabled={preparingQuote || (guardedRestart && liveBusy)}
                    onClick={askToRestart}
                    title={guardedRestart ? 'Start another request' : 'Start a new request'}
                    aria-label={guardedRestart ? 'Start another request' : 'Start a new request'}
                  >
                    {guardedRestart ? 'Start another request' : 'Start over'}
                  </button>
                )}
              </header>
            )}
            <div
              className={`${styles.conversationRegion} ${privatePreview ? '' : styles.liveConversation}`}
            >
              <div
                className="public-chat-body"
                ref={chatBodyRef}
                onScroll={(event) => {
                  const body = event.currentTarget;
                  followingConversation.current =
                    body.scrollHeight - body.scrollTop - body.clientHeight < 80;
                  updateLatestMessageHint();
                }}
              >
                {!session ? (
                  privatePreview && profile.services.length === 1 ? (
                    <form
                      className={styles.testProject}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (content.trim()) void start(profile.services[0], content.trim());
                      }}
                    >
                      <label htmlFor="private-test-project">Customer’s project</label>
                      <textarea
                        id="private-test-project"
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        placeholder="Describe a job a customer might ask you to quote."
                        maxLength={5000}
                        rows={5}
                        required
                      />
                      <Button
                        type="submit"
                        loading={!!starting}
                        disabled={!content.trim() || !!starting}
                      >
                        Try this request
                      </Button>
                    </form>
                  ) : lazyPublicEntry ? (
                    <p className={styles.serviceContext}>{onlyService?.name}</p>
                  ) : (
                    <div className="public-welcome">
                      {profile.services.length > 1 && <p>Choose a service.</p>}
                      <div className="public-service-options">
                        {profile.services.length ? (
                          profile.services.map((service) => (
                            <button
                              key={service.id}
                              aria-label={
                                privatePreview && profile.services.length === 1
                                  ? 'Start a customer test'
                                  : undefined
                              }
                              onClick={() => void start(service)}
                              disabled={!!starting}
                            >
                              <span>
                                <strong>
                                  {privatePreview && profile.services.length === 1
                                    ? 'Start a customer test'
                                    : service.name}
                                </strong>
                                {privatePreview && profile.services.length === 1 && (
                                  <small>{service.name}</small>
                                )}
                              </span>
                              {starting === service.id ? (
                                <LoaderCircle className="spin" size={18} />
                              ) : null}
                            </button>
                          ))
                        ) : (
                          <Notice>
                            No services are currently available for online requests. Please contact
                            the business directly.
                          </Notice>
                        )}
                      </div>
                    </div>
                  )
                ) : (
                  <>
                    <div className="public-message-list qf-thread" aria-live="polite">
                      {timeline}
                      {session.humanHandoff && !privatePreview && !quote && (
                        <p className="public-handoff-status">
                          Add your contact details to send this request to the business.
                        </p>
                      )}
                      <div ref={endRef} />
                    </div>
                    {requesting && !quote && (
                      <div
                        ref={requestFormRef}
                        className={privatePreview ? styles.reviewEntry : undefined}
                      >
                        <PublicQuoteForm
                          draftKey={`${draftKey}:details`}
                          service={service}
                          previewPricing={previewProfile?.services.find(
                            (item) => item.id === service?.id,
                          )}
                          session={session}
                          base={base}
                          token={token}
                          privatePreview={privatePreview}
                          onContactVerified={(email) => {
                            sessionRevision.current += 1;
                            setSession((current) =>
                              current
                                ? { ...current, contact: { verified: true, email } }
                                : current,
                            );
                          }}
                          initialDescription={projectDescription}
                          onCancel={backToChat}
                          onSubmit={submitQuote}
                        />
                      </div>
                    )}
                  </>
                )}
                {error && (
                  <Notice kind="error">
                    {error}
                    {failedPhoto && (
                      <button
                        className="text-button"
                        type="button"
                        disabled={uploading || sending}
                        onClick={() => void upload(failedPhoto)}
                      >
                        Try photo again
                      </button>
                    )}
                  </Notice>
                )}
              </div>
              {liveReceipt && latestMessageHint === latestContext && latestContext && (
                <button
                  type="button"
                  className={`${styles.latestMessage} ${quote?.status === 'accepted' || quote?.status === 'declined' ? styles.latestWithoutComposer : ''}`}
                  onPointerDown={() => {
                    latestCueComposerFocus.current = document.activeElement === composerRef.current;
                  }}
                  onPointerCancel={() => {
                    latestCueComposerFocus.current = false;
                  }}
                  onClick={() => {
                    if (latestContextRef.current !== latestContext) return;
                    const returnToComposer = latestCueComposerFocus.current;
                    latestCueComposerFocus.current = false;
                    revealLatestMessage();
                    if (returnToComposer) composerRef.current?.focus({ preventScroll: true });
                    else latestMessageRef.current?.focus({ preventScroll: true });
                  }}
                >
                  Latest message ↓
                </button>
              )}
            </div>
            {(session || lazyPublicEntry) &&
              !(privatePreview && quote) &&
              quote?.status !== 'accepted' &&
              quote?.status !== 'declined' &&
              !requesting && (
                <>
                  <form className="qf-composer public-composer" onSubmit={send}>
                    <label className="sr-only" htmlFor="public-message">
                      Tell us about your project
                    </label>
                    <textarea
                      ref={composerRef}
                      id="public-message"
                      rows={1}
                      maxLength={5000}
                      value={content}
                      disabled={preparingQuote}
                      onChange={(event) => setContent(event.target.value)}
                      required
                      placeholder="Tell us about your project…"
                    />
                    <div className="qf-composer-actions">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        id="project-photo"
                        onChange={(event) => void upload(event.target.files?.[0])}
                      />
                      <button
                        type="button"
                        className="photo-button"
                        disabled={
                          !!starting ||
                          uploading ||
                          sending ||
                          preparingQuote ||
                          uploads.length >= 3
                        }
                        onClick={() => fileRef.current?.click()}
                      >
                        {uploading && <LoaderCircle className="spin" size={16} />}
                        <span>
                          {uploading
                            ? 'Adding photo…'
                            : `Add photo${uploads.length ? ` (${uploads.length}/3)` : ''}`}
                        </span>
                      </button>
                      <Button
                        type="submit"
                        loading={sending || !!starting}
                        disabled={
                          !content.trim() || !!starting || uploading || sending || preparingQuote
                        }
                        aria-label="Send message"
                      >
                        Send
                      </Button>
                    </div>
                  </form>
                  {!quote && (
                    <div className="public-request-action">
                      {directSubmission && (
                        <button
                          className="text-button"
                          type="button"
                          disabled={!!starting || uploading || sending || preparingQuote}
                          onClick={() => void openQuoteForm()}
                        >
                          Edit project details
                        </button>
                      )}
                      <Button
                        variant={directSubmission ? 'primary' : 'secondary'}
                        loading={preparingQuote}
                        disabled={!!starting || uploading || sending || preparingQuote}
                        onClick={() => {
                          if (!directSubmission) return void openQuoteForm();
                          if (interacting.current || startFlight.current || uploading || sending)
                            return;
                          setError('');
                          void submitQuote(directSubmission).catch((error) =>
                            setError(errorMessage(error)),
                          );
                        }}
                      >
                        {directSubmission ? 'See request summary' : 'Get a quote'}
                      </Button>
                    </div>
                  )}
                </>
              )}
            {!privatePreview && !quote && (
              <footer className="public-chat-footer">
                <span>Your details and photos are shared with this business for your request.</span>
              </footer>
            )}
          </section>
        </div>
      )}
      {!embedded && (
        <footer className="public-powered">
          Powered by <Link href="/">quotefolk.</Link>
        </footer>
      )}
      {restartConfirmation && (
        <Modal
          title="Start another request?"
          className={styles.returnModal}
          onClose={() => setRestartConfirmation(undefined)}
        >
          <div className={styles.returnGuard}>
            <p>
              {restartConfirmation.submitted
                ? 'Your current request stays with the business. Keep its private link to return to it.'
                : 'Keep this private link to return to this conversation.'}
            </p>
            <label>
              Your private request link
              <input
                readOnly
                value={restartConfirmation.url}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button
              className="text-button"
              type="button"
              onClick={() => void copyRequestLink(restartConfirmation)}
            >
              {copiedRequest ? 'Request link copied' : 'Copy request link'}
            </button>
            <div className={styles.returnActions}>
              <Button variant="secondary" onClick={() => setRestartConfirmation(undefined)}>
                Keep this request
              </Button>
              <Button disabled={liveBusy} onClick={confirmRestart}>
                Start another request
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
