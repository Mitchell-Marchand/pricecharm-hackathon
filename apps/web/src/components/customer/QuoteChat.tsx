'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Camera, Check, X } from 'lucide-react';
import { BusinessMark, CustomerMessage, Typing } from '@/components/Chat';
import { PaperButton, QuoteForm } from '@/components/QuoteForm';
import { Button, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import {
  accessFromLink,
  decide,
  greeting,
  loadChat,
  LOSS_REASONS,
  photoUrl,
  requestCode,
  saveAccess,
  savedAccess,
  sendMessage,
  sendPhoto,
  startChat,
  verifyCode,
  type BusinessProfile,
  type ChatAccess,
  type ChatMessage,
  type ChatView,
  type LossReason,
} from '@/lib/chat';
import { useHumanCheck } from '@/lib/human-check';
import { quoteFootnote } from '@/lib/quote';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { cx, readPhoto } from '@/lib/util';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASKS_FOR_PHOTO = /\b(photo|picture|pic)s?\b/i;

type Pending = { text?: string; photo?: string };
type Verification = { id: string; email: string; devCode?: string };

/**
 * What a customer sees on the quote link and the website widget: a short chat, their email
 * confirmed with a code, then the quote itself.
 */
export function QuoteChat({
  slug,
  profile,
  source,
  onClose,
  owner = false,
}: {
  slug: string;
  profile: BusinessProfile;
  source: 'link' | 'widget';
  onClose?: () => void;
  /** Opened by the signed-in owner to try it, so it says it's a test before the chat starts. */
  owner?: boolean;
}) {
  const [access, setAccess] = useState<ChatAccess | null>(null);
  const [chat, setChat] = useState<ChatView | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [freshQuote, setFreshQuote] = useState(false);
  const human = useHumanCheck('quote_chat', !access);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  // Photos the customer just sent, shown from the browser instead of downloaded again.
  const localPhotos = useRef(new Map<string, string>());

  // Reopen this browser's chat, or the one from the customer's quote email.
  useEffect(() => {
    const saved = accessFromLink() ?? savedAccess(slug);
    if (!saved) {
      setRestoring(false);
      return;
    }
    loadChat(slug, saved)
      .then((view) => {
        saveAccess(slug, saved);
        setAccess(saved);
        setChat(view);
      })
      .catch((loadError) => {
        if (loadError instanceof ApiError && [401, 403, 404].includes(loadError.status))
          saveAccess(slug, null);
        else setError(errorMessage(loadError));
      })
      .finally(() => setRestoring(false));
  }, [slug]);

  const { toBottom: stickToBottom, showTop } = useStickToBottom(scroller);
  const card = useRef<HTMLDivElement>(null);
  const shownQuote = useRef<string | null>(null);

  // A quote opens at its top, where the price is, when it first arrives and when the customer
  // comes back to answer it from their email. Once they've answered, the chat opens at the end.
  const quoteId = chat?.quote?.id ?? null;
  // Past its valid days, a quote can still be answered.
  const quoteOpen = ['sent', 'expired'].includes(chat?.quote?.status ?? '');
  useLayoutEffect(() => {
    if (!quoteId || shownQuote.current === quoteId || !card.current) return;
    shownQuote.current = quoteId;
    if (freshQuote || quoteOpen) showTop(card.current);
  }, [quoteId, quoteOpen, freshQuote, showTop]);

  const update = useCallback((view: ChatView) => {
    setChat((previous) => {
      if (!previous?.quote && view.quote) setFreshQuote(true);
      return view;
    });
  }, []);

  // Once the chat is with the owner, check in now and then for their quote or reply.
  const waiting =
    !!chat && ['quoting', 'review', 'sent', 'accepted', 'visit'].includes(chat.status);
  useEffect(() => {
    if (!access || !waiting) return;
    const refresh = () => {
      if (document.visibilityState === 'visible')
        loadChat(slug, access)
          .then(update)
          .catch(() => {});
    };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [access, waiting, slug, update]);

  async function ensureChat(): Promise<ChatAccess> {
    if (access) return access;
    const started = await startChat(slug, source, await human.headers());
    const next = { chatId: started.chat.id, token: started.token };
    saveAccess(slug, next);
    setAccess(next);
    setChat(started.chat);
    return next;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft('');
    setError('');
    setPending({ text: trimmed });
    stickToBottom();
    setBusy(true);
    try {
      const current = await ensureChat();
      update(await sendMessage(slug, current, trimmed));
    } catch (sendError) {
      setDraft(trimmed);
      setError(errorMessage(sendError));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function addPhoto(file: File) {
    setError('');
    setBusy(true);
    try {
      const dataUrl = await readPhoto(file, 1600);
      setPending({ photo: dataUrl });
      stickToBottom();
      const blob = await (await fetch(dataUrl)).blob();
      const current = await ensureChat();
      const known = new Set(chat?.messages.flatMap((message) => message.photos.map((p) => p.id)));
      const view = await sendPhoto(slug, current, blob);
      const added = view.messages
        .flatMap((message) => message.photos)
        .find((photo) => !known.has(photo.id));
      if (added) localPhotos.current.set(added.id, dataUrl);
      update(view);
    } catch (photoError) {
      setError(errorMessage(photoError));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function submitContact(event: FormEvent) {
    event.preventDefault();
    if (!access || busy || !name.trim() || !EMAIL.test(email.trim())) return;
    setError('');
    setBusy(true);
    try {
      const result = await requestCode(slug, access, name.trim(), email.trim());
      if (result.chat) update(result.chat);
      else if (result.verificationId)
        setVerification({
          id: result.verificationId,
          email: email.trim(),
          devCode: result.devCode,
        });
    } catch (contactError) {
      setError(errorMessage(contactError));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!access || !verification || busy || code.length !== 6) return;
    setError('');
    setBusy(true);
    try {
      update(await verifyCode(slug, access, verification.id, code));
      setVerification(null);
      setCode('');
    } catch (codeError) {
      setError(errorMessage(codeError));
    } finally {
      setBusy(false);
    }
  }

  async function choose(decision: 'accept' | 'visit' | 'decline', reason?: LossReason) {
    if (!access || busy) return;
    setError('');
    setBusy(true);
    stickToBottom();
    try {
      update(await decide(slug, access, decision, reason));
      setDeclining(false);
    } catch (decideError) {
      setError(errorMessage(decideError));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    saveAccess(slug, null);
    setAccess(null);
    setChat(null);
    setVerification(null);
    setFreshQuote(false);
    setError('');
    setDraft('');
  }

  const status = chat?.status ?? 'chatting';
  const ownerName = profile.ownerFirstName || profile.name;
  const last = chat?.messages.at(-1);
  const lastFromAssistant = last?.from === 'assistant' && last.kind === 'text' ? last : null;
  const chips = !chat
    ? restoring
      ? []
      : profile.services.slice(0, 6)
    : status === 'chatting' && lastFromAssistant
      ? lastFromAssistant.chips
      : [];
  const asksForPhoto =
    status === 'chatting' && !!lastFromAssistant && ASKS_FOR_PHOTO.test(lastFromAssistant.text);
  const finished = ['accepted', 'visit', 'closed'].includes(status);
  const canType = ['chatting', 'review', 'sent', 'accepted', 'visit'].includes(status);

  // The quote card sits right after the message that announced it.
  const messages = chat?.messages ?? [];
  const sentAt = chat?.quote?.sentAt;
  const cardAfter = chat?.quote
    ? (() => {
        const index = sentAt ? messages.findIndex((message) => message.createdAt >= sentAt) : -1;
        return index === -1 ? messages.length - 1 : index;
      })()
    : -2;

  const placeholder =
    status === 'review'
      ? `Add a note for ${ownerName}`
      : status === 'sent' || finished
        ? `Ask ${ownerName} a question`
        : 'Type your answer';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <BusinessMark initials={profile.initials} logo={profile.logo} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{profile.name}</p>
          <p className="text-xs text-muted">Usually quotes in about 2 minutes</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-10 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-5" />
          </button>
        )}
      </header>
      {(chat ? chat.test : owner) && (
        <p className="bg-canary-soft px-4 py-2 text-xs text-ink">
          You&apos;re signed in, so this is a test. Nothing is emailed or billed.
        </p>
      )}

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
        aria-live="polite"
      >
        <div className="flex flex-col gap-3">
          {!chat && !restoring && (
            <AssistantBubble profile={profile}>{greeting(profile.name)}</AssistantBubble>
          )}
          {messages.map((message, index) => (
            <div key={message.id} className="contents">
              <Message
                message={message}
                profile={profile}
                access={access}
                local={localPhotos.current}
              />
              {index === cardAfter && chat?.quote && (
                <div ref={card} className="pr-3 pb-3">
                  {chat.test && chat.quote.status === 'review' && (
                    <WouldWait quoteId={chat.quote.id} reasons={chat.wouldWait ?? []} />
                  )}
                  <QuoteForm
                    quote={chat.quote.card}
                    business={profile.name}
                    logo={profile.logo}
                    stamp={
                      chat.quote.status === 'accepted'
                        ? 'accepted'
                        : chat.quote.status === 'review'
                          ? 'draft'
                          : undefined
                    }
                    animate={freshQuote}
                    footnote={quoteFootnote(chat.quote.card, ownerName)}
                    actions={
                      quoteOpen ? (
                        <>
                          <PaperButton
                            primary
                            disabled={busy}
                            onClick={() => void choose('accept')}
                          >
                            <Check aria-hidden /> {chat.quote.acceptLabel || 'Accept quote'}
                          </PaperButton>
                          <PaperButton onClick={() => composer.current?.focus()}>
                            Ask a question
                          </PaperButton>
                          <PaperButton disabled={busy} onClick={() => void choose('visit')}>
                            Request a site visit
                          </PaperButton>
                          <PaperButton
                            disabled={busy}
                            onClick={() => {
                              setDeclining(true);
                              stickToBottom();
                            }}
                          >
                            Not going ahead
                          </PaperButton>
                        </>
                      ) : undefined
                    }
                  />
                  {quoteOpen && declining && (
                    <div className="fade-up mt-3 flex flex-col gap-2">
                      <p className="text-sm text-ink-2">Mind saying why? It helps {ownerName}.</p>
                      <div className="flex flex-wrap gap-2">
                        {LOSS_REASONS.map((reason) => (
                          <button
                            key={reason.id}
                            type="button"
                            disabled={busy}
                            onClick={() => void choose('decline', reason.id)}
                            className="inline-flex min-h-10 items-center rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
                          >
                            {reason.label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setDeclining(false)}
                        className="self-start text-sm text-muted underline underline-offset-4 hover:text-ink"
                      >
                        Never mind
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {pending && (
            <div className="fade-up flex justify-end">
              <CustomerBubble photo={!!pending.photo}>
                {pending.photo ? (
                  <img
                    src={pending.photo}
                    alt="Your photo"
                    className="w-56 max-w-full rounded-[12px] opacity-70"
                  />
                ) : (
                  <p className="text-[15px]">{pending.text}</p>
                )}
              </CustomerBubble>
            </div>
          )}
          {busy &&
            (status === 'chatting' || verification || (chat?.test && status === 'contact')) && (
              <Typing
                name={profile.name}
                initials={profile.initials}
                tone="blue"
                logo={profile.logo}
              />
            )}
        </div>
      </div>

      <footer
        className="flex flex-col gap-2 border-t border-line bg-surface px-3 py-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}
      >
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        <div ref={human.slot} />

        {(chips.length > 0 || asksForPhoto) && !busy && (
          <div className="flex flex-wrap gap-2">
            {asksForPhoto && (
              <button
                type="button"
                onClick={() => filePicker.current?.click()}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[15px] font-medium text-on-accent hover:opacity-90"
              >
                <Camera className="size-4" aria-hidden /> Add a photo
              </button>
            )}
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => void send(chip)}
                className="inline-flex min-h-10 items-center rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent-soft"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {status === 'contact' && !verification && (
          <form className="flex flex-col gap-2" onSubmit={submitContact}>
            <p className="text-sm text-ink-2">Where should we send your quote?</p>
            <label htmlFor="chat-name" className="sr-only">
              Your name
            </label>
            <TextInput
              id="chat-name"
              autoComplete="name"
              placeholder="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label htmlFor="chat-email" className="sr-only">
              Your email
            </label>
            <TextInput
              id="chat-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim() || !EMAIL.test(email.trim())}>
              {chat?.test ? 'See my quote' : 'Send me a code'}
            </Button>
            <p className="text-xs text-muted">
              {profile.name} gets your name, email and this chat so they can reply.{' '}
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Privacy
              </a>
            </p>
          </form>
        )}

        {verification && (
          <form className="flex flex-col gap-2" onSubmit={submitCode}>
            <label htmlFor="chat-code" className="text-sm text-ink-2">
              We sent a 6-digit code to <span className="font-semibold">{verification.email}</span>.
              Enter it to see your quote.
            </label>
            <div className="flex gap-2">
              <TextInput
                id="chat-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                className="font-mono tracking-[0.3em]"
              />
              <Button type="submit" disabled={busy || code.length !== 6}>
                See my quote
              </Button>
            </div>
            {verification.devCode && (
              <p className="text-xs text-muted">
                Local test code: <span className="font-mono">{verification.devCode}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 text-sm">
              <button
                type="button"
                className="text-accent underline underline-offset-4"
                disabled={busy}
                onClick={(event) => void submitContact(event)}
              >
                Send a new code
              </button>
              <button
                type="button"
                className="text-accent underline underline-offset-4"
                onClick={() => {
                  setVerification(null);
                  setCode('');
                  setError('');
                }}
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        {status === 'quoting' && (
          <p className="py-2 text-sm text-muted">Putting your quote together…</p>
        )}

        {status === 'closed' && <p className="py-1 text-sm text-muted">This request is closed.</p>}

        {canType && !restoring && !verification && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            {status === 'chatting' && (
              <button
                type="button"
                onClick={() => filePicker.current?.click()}
                disabled={busy}
                aria-label="Add a photo"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                <Camera className="size-5" />
              </button>
            )}
            <label htmlFor="chat-message" className="sr-only">
              Message
            </label>
            <TextInput
              id="chat-message"
              ref={composer}
              autoComplete="off"
              enterKeyHint="send"
              maxLength={2000}
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="Send"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp className="size-5" />
            </button>
          </form>
        )}

        {(finished || (chat?.test && chat.quote)) && (
          <button
            type="button"
            onClick={startOver}
            className="self-start text-sm text-accent underline underline-offset-4"
          >
            {chat?.test ? 'Try another request' : 'Need something else? Start a new request'}
          </button>
        )}

        <input
          ref={filePicker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void addPhoto(file);
          }}
        />
      </footer>
    </div>
  );
}

/** In an owner's test: a real customer would wait for their OK on this quote, and why. */
function WouldWait({
  quoteId,
  reasons,
}: {
  quoteId: string;
  reasons: { id: string; detail: string }[];
}) {
  return (
    <div className="mb-3 rounded-md border border-line bg-canary-soft p-3 text-sm">
      <p className="font-semibold">A real customer would wait for your OK on this one.</p>
      {reasons.length > 0 && (
        <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5 text-ink-2">
          {reasons.map((reason) => (
            <li key={reason.id}>{reason.detail}</li>
          ))}
        </ul>
      )}
      <a
        href={`/app/quotes/${quoteId}`}
        className="mt-2 inline-block font-semibold text-accent underline underline-offset-4"
      >
        Open it in your quotes
      </a>
    </div>
  );
}

function AssistantBubble({ profile, children }: { profile: BusinessProfile; children: string }) {
  return (
    <CustomerMessage name={profile.name} initials={profile.initials} tone="blue" showAvatar={false}>
      {children}
    </CustomerMessage>
  );
}

function CustomerBubble({ photo, children }: { photo: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        'max-w-[80%] rounded-[16px] rounded-br-[4px] bg-accent text-on-accent',
        photo ? 'p-1.5' : 'px-3.5 py-2.5',
      )}
    >
      {children}
    </div>
  );
}

function Message({
  message,
  profile,
  access,
  local,
}: {
  message: ChatMessage;
  profile: BusinessProfile;
  access: ChatAccess | null;
  local: Map<string, string>;
}) {
  if (message.from === 'customer' && message.kind === 'status')
    return <p className="fade-up py-1 text-center text-sm text-muted">{message.text}</p>;
  if (message.from === 'customer')
    return (
      <div className="fade-up flex justify-end">
        <CustomerBubble photo={message.photos.length > 0}>
          {message.photos.length > 0 && access ? (
            message.photos.map((photo) => (
              <ChatPhoto
                key={photo.id}
                url={photo.url}
                access={access}
                local={local.get(photo.id)}
              />
            ))
          ) : (
            <p className="text-[15px] whitespace-pre-line">{message.text}</p>
          )}
        </CustomerBubble>
      </div>
    );
  if (message.from === 'owner')
    return (
      <div className="fade-up flex flex-col gap-1">
        <p className="pl-[46px] text-xs text-muted">
          {profile.ownerFirstName ? `${profile.ownerFirstName} at ${profile.name}` : profile.name}
        </p>
        <CustomerMessage
          name={profile.name}
          initials={profile.initials}
          tone="blue"
          showAvatar={false}
        >
          {message.text}
        </CustomerMessage>
      </div>
    );
  return <AssistantBubble profile={profile}>{message.text}</AssistantBubble>;
}

/** Chat photos need the chat's token, so they're fetched rather than linked. */
function ChatPhoto({ url, access, local }: { url: string; access: ChatAccess; local?: string }) {
  const [src, setSrc] = useState(local ?? '');
  useEffect(() => {
    if (local) return;
    let objectUrl = '',
      live = true;
    photoUrl(access, url)
      .then((loaded) => {
        objectUrl = loaded;
        if (live) setSrc(loaded);
        else URL.revokeObjectURL(loaded);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, access, local]);
  return src ? (
    <img src={src} alt="Your photo" className="w-56 max-w-full rounded-[12px]" />
  ) : (
    <div
      className="aspect-[4/3] w-56 max-w-full rounded-[12px] bg-on-accent/15"
      aria-label="Loading photo"
    />
  );
}
