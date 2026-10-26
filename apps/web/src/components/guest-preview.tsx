'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorMessage, json } from '@/lib/api';
import { useHumanCheck } from '@/lib/human-check';
import {
  approveGuestPreview,
  claimGuestPreview,
  clearGuestApproval,
  finishGuestClaim,
  guestAuthUrl,
  readGuestDraft,
  saveGuestDraft,
} from '@/lib/guest-preview';
import type { GuestPreview, GuestPreviewState } from '@/lib/types';
import styles from './guest-preview.module.css';

const exampleJob =
  'I cleaned a 1,000 sq ft concrete driveway for $275. It needed extra preparation before pressure washing, and the customer had easy ground-level access. The extra preparation is what made this job cost more.';

export function GuestPreviewReceipt({
  preview,
  showOriginal = true,
}: {
  preview: GuestPreview;
  showOriginal?: boolean;
}) {
  const receipt = preview.receipt;
  if (!receipt) return null;
  const publicDescription = receipt.description.trim();
  const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const showDescription =
    publicDescription &&
    normalized(publicDescription) !== normalized(receipt.name || '') &&
    (showOriginal || normalized(publicDescription) !== normalized(preview.content));
  const unit = receipt.unitLabel?.trim().toLowerCase();
  const unknownHours =
    receipt.example?.quantity === null && !!unit && ['hour', 'hours', 'hr', 'hrs'].includes(unit);
  const price = receipt.sourcePriceText
    ? `${receipt.sourcePriceText}${receipt.sourceCurrency && !receipt.sourcePriceText.toUpperCase().includes(receipt.sourceCurrency.toUpperCase()) ? ` ${receipt.sourceCurrency}` : ''} from your note`
    : '';
  const rationale = receipt.example?.rationale.trim();
  const rationaleKey = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const reasonKey = rationaleKey(rationale || '');
  const jobKey = rationaleKey(receipt.example?.description || receipt.example?.title || '');
  const showRationale = !!rationale && (!reasonKey || !` ${jobKey} `.includes(` ${reasonKey} `));
  return (
    <section className={styles.receipt} aria-label="Your assistant preview">
      <p className={styles.eyebrow}>Your assistant</p>
      <h2>{receipt.name || 'Your work'}</h2>
      {showDescription && <p className={styles.description}>{receipt.description}</p>}
      <div className={styles.questions}>
        <h3>Here’s what I’d ask</h3>
        <ul>
          {preview.questions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ul>
      </div>
      {receipt.example ? (
        <div className={styles.pastJob}>
          <span className={styles.jobLabel}>Your past job</span>
          <p>{receipt.example.description || receipt.example.title}</p>
          {(price || unknownHours) && (
            <div className={styles.jobFacts}>
              {price && <span>{price}</span>}
              {unknownHours && <span>Hours unknown</span>}
            </div>
          )}
          {showRationale && (
            <p>
              <strong className={styles.reasonLabel}>Why this price:</strong> {rationale}
            </p>
          )}
        </div>
      ) : price ? (
        <p className={styles.price}>{price}</p>
      ) : null}
      {showOriginal && (
        <details className={styles.original}>
          <summary>Your original note</summary>
          <p>{preview.content}</p>
        </details>
      )}
    </section>
  );
}

export default function GuestPreviewCanvas({
  onPreviewChange,
}: {
  onPreviewChange?: (visible: boolean) => void;
}) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  const [recoverable, setRecoverable] = useState<GuestPreview | null>(null);
  const [requestId, setRequestId] = useState('');
  const [editing, setEditing] = useState(true);
  const [example, setExample] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [needsCheck, setNeedsCheck] = useState(false);
  const [attemptContent, setAttemptContent] = useState('');
  const [attemptExpiresAt, setAttemptExpiresAt] = useState('');
  const human = useHumanCheck('guest_preview');
  const [retryAllowed, setRetryAllowed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const mutation = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  const latestRequest = useRef('');
  const submitted = useRef('');
  const submittedExpiry = useRef('');
  const proofExpiry = useRef('');
  const hasEdited = useRef(false);
  const usable = (value: GuestPreview | null) =>
    !!value?.receipt && value.status === 'ready' && value.readyToSave;
  const displayed =
    usable(preview) || preview?.status === 'claimed' || preview?.status === 'processing'
      ? preview
      : usable(recoverable)
        ? recoverable
        : preview;
  const earlier =
    !!displayed && (displayed.id !== preview?.id || displayed.content !== content.trim());
  const showingReceipt =
    !!displayed?.receipt &&
    !editing &&
    busy !== 'preview' &&
    ['ready', 'claimed'].includes(displayed.status);
  const alreadySaved = displayed?.status === 'claimed' && !!displayed.claim && !editing;
  const needsService =
    displayed?.status === 'ready' && !displayed.readyToSave && !editing && busy !== 'preview';
  const composerBase = !editing && displayed?.status === 'ready' ? displayed.content.trim() : '';
  const replying =
    !!composerBase &&
    (content.trim() === composerBase || content.startsWith(`${composerBase}\n\n`));
  const composerValue = replying
    ? content.trim() === composerBase
      ? ''
      : content.slice(composerBase.length + 2)
    : content;
  const conversationStarted = !!displayed || !!attemptContent || busy === 'preview';
  const submittedNote =
    busy === 'preview' || preview?.status === 'processing'
      ? attemptContent || preview?.content
      : displayed?.content || attemptContent;
  useEffect(() => {
    onPreviewChange?.(conversationStarted);
  }, [conversationStarted, onPreviewChange]);

  function openEditor(value: boolean) {
    setEditing(value);
  }

  // Reading a result never replaces the owner's separately editable working note.
  function acceptState(response: GuestPreviewState, fallback?: GuestPreview | null) {
    const expired =
      !response.preview &&
      !!submittedExpiry.current &&
      (Date.parse(submittedExpiry.current) <= Date.now() ||
        submittedExpiry.current !== response.expiresAt);
    proofExpiry.current = response.expiresAt;
    setPreview(expired ? null : response.preview);
    setRecoverable(
      expired
        ? null
        : usable(response.preview) ||
            ['processing', 'claimed'].includes(response.preview?.status || '')
          ? null
          : response.recoverablePreview || fallback || null,
    );
    if (expired) {
      setNeedsCheck(false);
      openEditor(true);
      setError('That preview has expired. Your note is kept. You can prepare new questions.');
    } else if (response.preview) setNeedsCheck(response.preview.status === 'processing');
    else if (!latestRequest.current) setNeedsCheck(false);
    setRetryAllowed(
      !expired &&
        !response.preview &&
        !!latestRequest.current &&
        !!submitted.current &&
        Date.parse(submittedExpiry.current) > Date.now() &&
        submittedExpiry.current === response.expiresAt,
    );
    return expired;
  }

  const failureMessage = (value: GuestPreview | null) =>
    value?.status === 'failed'
      ? value.error?.message || 'We couldn’t prepare the questions. Your note is still here.'
      : '';

  useEffect(() => {
    let active = true;
    const draft = readGuestDraft();
    let initialContent = draft?.content || '';
    if (!draft) {
      try {
        initialContent = sessionStorage.getItem('quotient:first-job')?.slice(0, 5000) || '';
      } catch {
        /* Browser storage is optional. */
      }
    }
    setContent(initialContent);
    if (draft) {
      setRequestId(draft.requestId);
      latestRequest.current = draft.requestId;
      submitted.current = draft.attemptContent || '';
      submittedExpiry.current = draft.attemptExpiresAt || '';
      setAttemptContent(draft.attemptContent || '');
      setAttemptExpiresAt(draft.attemptExpiresAt || '');
      openEditor(draft.editing);
      setNeedsCheck(!!draft.needsCheck);
    }
    api<GuestPreviewState>(
      `/guest-preview${draft?.requestId ? `?requestId=${encodeURIComponent(draft.requestId)}` : ''}`,
    )
      .then((response) => {
        if (!active) return;
        if (acceptState(response)) return;
        if (!draft && !initialContent && !hasEdited.current && response.preview) {
          setContent(response.preview.content);
          openEditor(response.preview.status === 'failed');
        } else if (!draft && !hasEdited.current && response.preview) {
          openEditor(false);
        }
        if (!response.preview && !response.recoverablePreview) openEditor(true);
        setError(failureMessage(response.preview));
        if (!response.preview && draft?.needsCheck)
          setError(
            'The latest result is still unconfirmed. Check for it before preparing another note.',
          );
      })
      .catch((cause) => {
        if (active) {
          setError(errorMessage(cause));
          setNeedsCheck(true);
        }
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (loaded)
      saveGuestDraft({ content, requestId, editing, needsCheck, attemptContent, attemptExpiresAt });
  }, [content, requestId, editing, needsCheck, attemptContent, attemptExpiresAt, loaded]);

  useEffect(() => {
    if (preview?.status !== 'processing') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const started = Date.now();
    const id = preview.id;
    const attempt = latestRequest.current;
    async function poll() {
      if (!active || latestRequest.current !== attempt) return;
      if (Date.now() - started > 90_000) {
        setNeedsCheck(true);
        setError('Your note is taking longer than expected. Check for the result in a moment.');
        return;
      }
      try {
        const response = await api<GuestPreviewState>(
          `/guest-preview${attempt ? `?requestId=${encodeURIComponent(attempt)}` : ''}`,
        );
        if (!active || latestRequest.current !== attempt) return;
        failures = 0;
        if (
          !response.preview &&
          submittedExpiry.current &&
          (Date.parse(submittedExpiry.current) <= Date.now() ||
            submittedExpiry.current !== response.expiresAt)
        ) {
          acceptState(response);
          return;
        }
        if (response.preview?.id === id) {
          acceptState(response);
          setError(failureMessage(response.preview));
          if (response.preview.status !== 'processing') {
            if (response.preview.status === 'failed' && !response.recoverablePreview)
              openEditor(true);
            return;
          }
        } else {
          setNeedsCheck(true);
          setError('The latest result is still unconfirmed. Your note is kept.');
          return;
        }
      } catch (cause) {
        if (!active) return;
        if (++failures >= 3) {
          setNeedsCheck(true);
          setError(errorMessage(cause));
          return;
        }
      }
      if (active) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preview?.id, preview?.status]);

  async function checkResult() {
    if (mutation.current) return;
    mutation.current = true;
    setBusy('checking');
    setError('');
    const attempt = requestId;
    try {
      const response = await api<GuestPreviewState>(
        `/guest-preview${attempt ? `?requestId=${encodeURIComponent(attempt)}` : ''}`,
      );
      if (latestRequest.current !== attempt) return;
      if (acceptState(response, usable(displayed) ? displayed : null)) return;
      // A null read can race a lost POST's transaction: it does not authorize a new paid attempt.
      if (!response.preview && needsCheck)
        setError(
          'The latest result is still unconfirmed. Check again before preparing another note.',
        );
      else setError(failureMessage(response.preview));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !loaded ||
      mutation.current ||
      !composerValue.trim() ||
      needsCheck ||
      preview?.status === 'processing'
    )
      return;
    await submitAttempt(crypto.randomUUID(), content.trim());
  }

  async function submitAttempt(id: string, submittedContent: string, retry = false) {
    if (mutation.current) return;
    if (
      retry &&
      (!retryAllowed ||
        Date.parse(attemptExpiresAt) <= Date.now() ||
        attemptExpiresAt !== proofExpiry.current)
    ) {
      setRetryAllowed(false);
      setError('That submission can no longer be retried here. Your note is kept.');
      return;
    }
    mutation.current = true;
    const expiresAt = retry ? attemptExpiresAt : proofExpiry.current;
    const previous = usable(displayed) ? displayed : null;
    latestRequest.current = id;
    submitted.current = submittedContent;
    submittedExpiry.current = expiresAt;
    setAttemptContent(submittedContent);
    setAttemptExpiresAt(expiresAt);
    setRetryAllowed(false);
    setRequestId(id);
    setPreview(null);
    setRecoverable(previous);
    openEditor(false);
    setNeedsCheck(true);
    saveGuestDraft({
      content,
      requestId: id,
      editing: false,
      needsCheck: true,
      attemptContent: submittedContent,
      attemptExpiresAt: expiresAt,
    });
    clearGuestApproval();
    setBusy('preview');
    setError('');
    setExample(false);
    try {
      const response = await api<{ preview: GuestPreview }>('/guest-preview', {
        method: 'POST',
        headers: await human.headers(),
        ...json({
          content: submittedContent,
          requestId: id,
          ...(retry ? { expectedSessionExpiresAt: expiresAt } : {}),
        }),
      });
      if (
        acceptState(
          { ...response, recoverablePreview: null, expiresAt: response.preview.expiresAt },
          previous,
        )
      )
        return;
      if (response.preview.status === 'failed') {
        setError(failureMessage(response.preview));
        openEditor(!previous);
        try {
          const recovered = await api<GuestPreviewState>(
            `/guest-preview?requestId=${encodeURIComponent(id)}`,
          );
          if (acceptState(recovered, previous)) return;
          if (recovered.recoverablePreview) openEditor(false);
        } catch {
          /* The failed attempt is known; the earlier receipt remains available in memory. */
        }
      } else requestAnimationFrame(() => result.current?.focus({ preventScroll: true }));
    } catch (cause) {
      const proofChanged =
        cause instanceof ApiError && cause.code === 'GUEST_PREVIEW_PROOF_CHANGED';
      const rejected =
        cause instanceof ApiError &&
        ([400, 401, 403, 413, 422, 429].includes(cause.status) ||
          cause.code === 'GUEST_PREVIEW_PROOF_CHANGED');
      setNeedsCheck(!rejected);
      setError(errorMessage(cause));
      if (proofChanged) {
        setPreview(null);
        setRecoverable(null);
      }
      openEditor(proofChanged || !previous);
      try {
        const response = await api<GuestPreviewState>(
          `/guest-preview?requestId=${encodeURIComponent(id)}`,
        );
        if (acceptState(response, proofChanged ? null : previous)) return;
        if (
          (response.preview &&
            ['ready', 'processing', 'claimed'].includes(response.preview.status)) ||
          usable(response.recoverablePreview)
        )
          openEditor(false);
        if (response.preview) setError(failureMessage(response.preview));
      } catch {
        /* Keep the exact uncertain attempt for free checking, never automatically POST again. */
      }
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  async function saveAssistant() {
    if (!displayed || mutation.current || !displayed.readyToSave) return;
    mutation.current = true;
    setBusy('save');
    setError('');
    const approval = approveGuestPreview(displayed);
    try {
      try {
        await api('/auth/me');
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          router.push(guestAuthUrl('/signup', approval));
          return;
        }
        throw cause;
      }
      const claimed = await claimGuestPreview(approval);
      router.push(finishGuestClaim(claimed.service.id, displayed));
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      setBusy('');
    }
  }

  function editNote() {
    clearGuestApproval();
    openEditor(true);
    if (!needsCheck) setError('');
    requestAnimationFrame(() => input.current?.focus());
  }

  return (
    <div className={styles.canvas}>
      <div className={styles.conversation} aria-label="Your setup conversation">
        <div className={styles.assistantIdentity}>
          <span className={styles.assistantMark} aria-hidden="true">
            q
          </span>
          <span>Quotefolk</span>
        </div>
        {!conversationStarted && <p className={styles.opening}>What kind of work do you do?</p>}
        {submittedNote && (
          <details
            className={styles.ownerTurn}
            open={needsService || submittedNote.length <= 180}
            aria-label="Your submitted note"
          >
            <summary>
              <span>You</span>
              <span className={styles.noteTitle}>Your original note</span>
              <span aria-hidden="true">↗</span>
            </summary>
            <p>{submittedNote}</p>
          </details>
        )}
        <div ref={result} tabIndex={-1} className={styles.response}>
          {needsService && displayed ? (
            <section className={styles.clarification} aria-label="Describe your service">
              <span className={styles.responseLabel}>Quotefolk</span>
              <h2>What service do you offer?</h2>
              <p>Tell me what you do for customers. I’ll keep the details you’ve already shared.</p>
            </section>
          ) : showingReceipt && displayed ? (
            <>
              {earlier && (
                <p className={styles.earlier}>
                  These are your earlier questions. Your changes aren’t included.
                </p>
              )}
              <GuestPreviewReceipt preview={displayed} showOriginal={false} />
              <div className={styles.actions}>
                {displayed.aiMode === 'demo' && (
                  <p className={styles.status}>
                    Demo preview. These questions haven’t been prepared by a live model.
                  </p>
                )}
                {displayed.status === 'claimed' && displayed.claim ? (
                  <button
                    className={styles.primary}
                    onClick={() =>
                      router.push(
                        `/dashboard?service=${encodeURIComponent(displayed.claim!.serviceId)}&step=teach`,
                      )
                    }
                  >
                    Open your assistant <span aria-hidden="true">↗</span>
                  </button>
                ) : (
                  <>
                    <p className={styles.consent}>
                      Save these questions, then price a practice job to teach it your judgment. You
                      set the final price.
                    </p>
                    <button
                      className={styles.primary}
                      disabled={!!busy || !displayed.readyToSave}
                      onClick={saveAssistant}
                    >
                      {busy === 'save'
                        ? 'Saving…'
                        : earlier
                          ? 'Save earlier questions'
                          : 'Save your assistant'}{' '}
                      <span aria-hidden="true">↗</span>
                    </button>
                  </>
                )}
                <button className={styles.quiet} disabled={!!busy} onClick={editNote}>
                  {earlier ? 'Back to your changes' : 'Edit your note'}
                </button>
              </div>
            </>
          ) : alreadySaved && displayed?.claim ? (
            <div className={styles.actions}>
              <h2>Your assistant is saved.</h2>
              <button
                className={styles.primary}
                onClick={() =>
                  router.push(
                    `/dashboard?service=${encodeURIComponent(displayed.claim!.serviceId)}&step=teach`,
                  )
                }
              >
                Open your assistant <span aria-hidden="true">↗</span>
              </button>
              <button className={styles.quiet} onClick={editNote}>
                Start with another note
              </button>
            </div>
          ) : (busy === 'preview' || preview?.status === 'processing') && !editing ? (
            <div className={styles.pending} aria-live="polite" aria-busy="true">
              <span className={styles.responseLabel}>Quotefolk</span>
              <p>Preparing questions from your note…</p>
            </div>
          ) : null}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {needsCheck && (
          <div className={styles.editorActions}>
            <button className={styles.quiet} onClick={checkResult} disabled={!!busy}>
              {busy === 'checking' ? 'Checking…' : 'Check for my result'}
            </button>
            {retryAllowed && requestId && attemptContent && (
              <button
                className={styles.quiet}
                disabled={!!busy}
                onClick={() => submitAttempt(requestId, attemptContent, true)}
              >
                Retry last submission
              </button>
            )}
          </div>
        )}
      </div>
      {!alreadySaved && (
        <form className={styles.composer} onSubmit={generate}>
          <div className={styles.composerHeading}>
            <label htmlFor="first-job-description">
              {replying
                ? needsService
                  ? 'Your reply'
                  : 'Add a detail or correction'
                : 'Start with your work.'}
            </label>
            {!conversationStarted && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setContent(exampleJob);
                  setExample(true);
                  input.current?.focus();
                }}
              >
                Use an example
              </button>
            )}
          </div>
          <textarea
            ref={input}
            id="first-job-description"
            name="job"
            value={composerValue}
            readOnly={busy === 'preview'}
            onChange={(event) => {
              hasEdited.current = true;
              const value = event.target.value;
              setContent(replying ? `${composerBase}${value ? `\n\n${value}` : ''}` : value);
              setExample(false);
              clearGuestApproval();
            }}
            placeholder={
              replying
                ? needsService
                  ? 'Tell me what you do for customers…'
                  : 'Add something, or correct what I understood…'
                : 'A recent job, a tricky decision, or simply what you do…'
            }
            required
            maxLength={replying ? Math.max(0, 5000 - composerBase.length - 2) : 5000}
            rows={replying ? 2 : 4}
            aria-describedby={example ? 'first-job-hint' : undefined}
          />
          {example && (
            <p className={styles.status} id="first-job-hint">
              Example job. Replace it with your own details.
            </p>
          )}
          <div className={styles.composerFooter}>
            <span>
              {replying
                ? 'Your earlier details stay in the conversation.'
                : 'No account needed to start.'}
            </span>
            <button
              className={replying && !needsService ? styles.send : styles.primary}
              type="submit"
              disabled={
                !loaded ||
                !composerValue.trim() ||
                !!busy ||
                needsCheck ||
                preview?.status === 'processing'
              }
            >
              {busy === 'preview'
                ? 'Preparing your questions…'
                : replying
                  ? needsService
                    ? 'Send reply'
                    : 'Update assistant'
                  : 'Show me the questions'}{' '}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
          <div ref={human.slot} className="human-check" />
          {editing && (usable(displayed) || displayed?.status === 'ready') && (
            <button
              className={styles.quiet}
              type="button"
              onClick={() => {
                openEditor(false);
                if (!needsCheck) setError('');
              }}
            >
              Back to your preview
            </button>
          )}
        </form>
      )}
    </div>
  );
}

export { styles as guestPreviewStyles };
