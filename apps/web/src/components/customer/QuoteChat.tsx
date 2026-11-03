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
import { ArrowUp, Camera, Check, Video, X } from 'lucide-react';
import { BeforeAfter } from '@/components/BeforeAfter';
import { BusinessMark, CustomerMessage, Typing } from '@/components/Chat';
import { PaperButton, QuoteForm } from '@/components/QuoteForm';
import { Button, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import {
  accessFromLink,
  decide,
  greeting,
  loadChat,
  loadViewer,
  leaveContact,
  LOSS_REASONS,
  openedForm,
  photoUrl,
  saveAccess,
  savedAccess,
  sendMessage,
  sendPhoto,
  sendVideo,
  startChat,
  videoPath,
  type BusinessProfile,
  type ChatAccess,
  type ChatMessage,
  type ChatView,
  type Contact,
  type LossReason,
} from '@/lib/chat';
import { useHumanCheck } from '@/lib/human-check';
import { quoteFootnote } from '@/lib/quote';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { useVisualViewport } from '@/lib/use-visual-viewport';
import { ReadingSteps } from './ReadingSteps';
import { cx, readPhoto } from '@/lib/util';
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, readVideo } from '@/lib/video';
import { setCurrency } from '@/lib/currency';

const MAX_PHOTOS_AT_ONCE = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASKS_FOR_PHOTO = /\b(photo|picture|pic)s?\b/i;

/** Seven to fifteen digits, written any usual way. */
const isPhone = (value: string) =>
  /^\+?[\d\s().-]+$/.test(value) && /^\d{7,15}$/.test(value.replace(/\D/g, ''));

/** `sent` and `total` are how much of a video has gone up, once it's on its way. */
type Pending = { text?: string; photo?: string; video?: string; sent?: number; total?: number };
/** Why the customer is leaving their details, on a quote they can see. */
type Form = 'yes' | 'visit' | 'copy' | 'question';

/**
 * What a customer sees on the quote link and the website widget: a short chat, then the quote
 * itself. They leave their name and a phone number or email when they say yes, ask for a visit,
 * want a copy or ask a question. Owners can ask for those before the price shows instead.
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
  // The quote is in the business's currency.
  setCurrency(profile.currency);
  const [access, setAccess] = useState<ChatAccess | null>(null);
  const [chat, setChat] = useState<ChatView | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [contact, setContact] = useState<Contact>({ name: '', email: '', phone: '', address: '' });
  const [form, setForm] = useState<Form | null>(null);
  const [freshQuote, setFreshQuote] = useState(false);
  // The owner trying their own link gets a test chat, which skips the check, and is told it's a
  // test before they start.
  const [signedIn, setSignedIn] = useState(owner);
  const viewer = useRef<Promise<boolean> | null>(null);
  const ownerViewing = useCallback(() => {
    viewer.current ??= owner
      ? Promise.resolve(true)
      : loadViewer(slug)
          .then((found) => found.owner)
          .catch(() => false);
    return viewer.current;
  }, [owner, slug]);
  useEffect(() => {
    void ownerViewing().then(setSignedIn);
  }, [ownerViewing]);
  const human = useHumanCheck('quote_chat', !access && !signedIn);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const videoPicker = useRef<HTMLInputElement>(null);
  // Photos and videos the customer just sent, shown from the browser instead of downloaded again.
  const localPhotos = useRef(new Map<string, string>());
  const localVideos = useRef(new Map<string, string>());

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
  useVisualViewport();
  const card = useRef<HTMLDivElement>(null);
  const shownQuote = useRef<string | null>(null);

  // A quote opens at its top, where the price is, when it first arrives and when the customer
  // comes back to answer it from their email. Once they've answered, the chat opens at the end.
  const quoteId = chat?.quote?.id ?? null;
  // Past its valid days, a quote can still be answered.
  const quoteOpen = ['sent', 'expired'].includes(chat?.quote?.status ?? '');
  // In the owner's test, a quote waiting for them shows apart from the chat: a customer never sees it.
  const ownerOnly = !!chat?.test && chat.quote?.status === 'review';
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

  // Once the chat is with the owner, check in now and then for their quote or reply. A video or
  // photos being measured are checked on more often, since the assistant carries on once they're done.
  const measuring = !!chat?.measuring;
  const waiting =
    !!chat &&
    (measuring || ['quoting', 'review', 'sent', 'accepted', 'visit'].includes(chat.status));
  useEffect(() => {
    if (!access || !waiting) return;
    const refresh = () => {
      if (document.visibilityState === 'visible')
        loadChat(slug, access)
          .then(update)
          .catch(() => {});
    };
    const timer = window.setInterval(refresh, measuring ? 2_500 : 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [access, waiting, measuring, slug, update]);

  // One start for everything sent before the chat exists, like several photos picked at once.
  const starting = useRef<Promise<ChatAccess> | null>(null);
  async function ensureChat(): Promise<ChatAccess> {
    if (access) return access;
    starting.current ??= (async () => {
      const started = await startChat(
        slug,
        source,
        (await ownerViewing()) ? {} : await human.headers(),
      );
      const next = { chatId: started.chat.id, token: started.token };
      saveAccess(slug, next);
      setAccess(next);
      setChat(started.chat);
      return next;
    })();
    try {
      return await starting.current;
    } catch (startError) {
      // Signed out since the page opened: the next try asks again, and runs the check.
      starting.current = null;
      viewer.current = null;
      throw startError;
    }
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
      // The newest one: when several go in a row, this render's chat can be a photo behind.
      const added = view.messages
        .flatMap((message) => message.photos)
        .filter((photo) => !known.has(photo.id))
        .at(-1);
      if (added) localPhotos.current.set(added.id, dataUrl);
      update(view);
    } catch (photoError) {
      setError(errorMessage(photoError));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function addVideo(file: File) {
    setError('');
    if (file.size > MAX_VIDEO_BYTES) {
      setError('That video is too big. Send one under a minute or so.');
      return;
    }
    setBusy(true);
    try {
      const { durationMs, stills, poster } = await readVideo(file);
      if (durationMs && durationMs > MAX_VIDEO_SECONDS * 1000) {
        setError('That video is a bit long. Send one under a minute and a half.');
        return;
      }
      setPending({ video: poster || 'loading' });
      stickToBottom();
      const current = await ensureChat();
      const known = new Set(chat?.messages.flatMap((message) => message.video?.id ?? []));
      const view = await sendVideo(slug, current, file, stills, durationMs, (sent, total) =>
        setPending((shown) => (shown?.video ? { ...shown, sent, total } : shown)),
      );
      const added = view.messages.find((message) => message.video && !known.has(message.video.id));
      if (added?.video) localVideos.current.set(added.video.id, URL.createObjectURL(file));
      update(view);
    } catch (videoError) {
      setError(errorMessage(videoError));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  // The job's street address goes with a yes, a visit or a question, where the owner asks for it.
  // It's optional, and the price has already shown by then.
  const asksAddress =
    profile.asksAddress === true && (form === 'yes' || form === 'visit' || form === 'question');
  // Their details, once they're good to send: an email for a copy, otherwise a phone or an email.
  const typed = {
    name: contact.name.trim(),
    email: contact.email.trim(),
    phone: contact.phone.trim(),
    ...(asksAddress && contact.address?.trim() ? { address: contact.address.trim() } : {}),
  };
  const contactReady =
    !!typed.name &&
    (!typed.email || EMAIL.test(typed.email)) &&
    (!typed.phone || isPhone(typed.phone)) &&
    (form === 'copy' ? !!typed.email : !!typed.email || !!typed.phone);

  function openForm(next: Form) {
    setError('');
    setDeclining(false);
    setForm(next);
    if (access) void openedForm(slug, access, next);
  }

  async function submitContact(event: FormEvent) {
    event.preventDefault();
    if (!access || busy || !contactReady) return;
    setError('');
    setBusy(true);
    stickToBottom();
    try {
      if (form === 'yes' || form === 'visit')
        update(await decide(slug, access, form === 'yes' ? 'accept' : 'visit', { contact: typed }));
      else {
        const result = await leaveContact(
          slug,
          access,
          typed,
          form === 'question' ? 'question' : 'copy',
        );
        if (result.chat) update(result.chat);
      }
      const asking = form === 'question';
      setForm(null);
      if (asking) window.setTimeout(() => composer.current?.focus(), 0);
    } catch (contactError) {
      setError(errorMessage(contactError));
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
      update(await decide(slug, access, decision, { reason }));
      setDeclining(false);
    } catch (decideError) {
      setError(errorMessage(decideError));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    starting.current = null;
    saveAccess(slug, null);
    setAccess(null);
    setChat(null);
    setForm(null);
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
  const reachable = !!(chat?.contact.email || chat?.contact.phone);
  // Someone who has only looked at their quote leaves their details before asking something, so
  // the answer can reach them.
  const canType =
    ['chatting', 'review', 'sent', 'accepted', 'visit'].includes(status) &&
    !form &&
    !measuring &&
    (status !== 'sent' || reachable);
  const videos = chat?.videosAllowed ?? profile.videos ?? false;

  // The quote card sits right after the message that announced it.
  const messages = chat?.messages ?? [];
  const sentAt = chat?.quote?.sentAt;
  const cardAfter = chat?.quote
    ? (() => {
        const index = sentAt ? messages.findIndex((message) => message.createdAt >= sentAt) : -1;
        return index === -1 ? messages.length - 1 : index;
      })()
    : -2;

  // The form for their details: before the price when the owner asks for that, for a quote that
  // waits for the owner, or for what they chose on the quote.
  const shownForm =
    status === 'contact'
      ? chat?.waitingForOwner
        ? ('review' as const)
        : ('first' as const)
      : form && quoteOpen
        ? form
        : null;
  const ASK = {
    first: { title: 'Where should we send your quote?', submit: 'See my quote' },
    review: { title: '', submit: 'Send it to me' },
    yes: { title: `Where can ${ownerName} reach you to book?`, submit: `Let ${ownerName} know` },
    visit: {
      title: `Where can ${ownerName} reach you to set up a visit?`,
      submit: 'Ask for a visit',
    },
    copy: { title: 'Where should we email it?', submit: 'Email it to me' },
    question: { title: `Where can ${ownerName} answer you?`, submit: 'Next' },
  };

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
      {(chat ? chat.test : signedIn) && (
        <p className="bg-canary-soft px-4 py-2 text-xs text-ink">
          You&apos;re signed in, so this is a test. Nothing is emailed or billed.
        </p>
      )}

      <div
        ref={scroller}
        className="chat-scroll min-h-0 flex-1 overscroll-contain px-3 py-4"
        aria-live="polite"
      >
        <div className="flex flex-col gap-3">
          {!chat && !restoring && (
            <AssistantBubble profile={profile}>
              {greeting(profile.name, profile.ownerFirstName)}
            </AssistantBubble>
          )}
          {messages.map((message, index) => (
            <div key={message.id} className="contents">
              <Message
                slug={slug}
                message={message}
                profile={profile}
                access={access}
                local={localPhotos.current}
                localVideos={localVideos.current}
              />
              {index === cardAfter && chat?.quote && (
                <div
                  ref={card}
                  className={cx(
                    'pb-3',
                    // The copies under the quote stick out to its right.
                    ownerOnly ? 'rounded-md border border-line bg-canary-soft p-3 pr-6' : 'pr-3',
                  )}
                >
                  {ownerOnly && (
                    <WouldWait quoteId={chat.quote.id} reasons={chat.wouldWait ?? []} />
                  )}
                  <QuoteForm
                    quote={chat.quote.card}
                    business={profile.name}
                    logo={profile.logo}
                    stamp={chat.quote.status === 'accepted' ? 'accepted' : undefined}
                    animate={freshQuote}
                    footnote={quoteFootnote(chat.quote.card, {
                      photos: messages.some((message) => message.photos.length > 0),
                      video: messages.some((message) => message.video),
                    })}
                    actions={
                      quoteOpen ? (
                        <>
                          <PaperButton
                            primary
                            disabled={busy}
                            onClick={() => (reachable ? void choose('accept') : openForm('yes'))}
                          >
                            <Check aria-hidden /> {chat.quote.acceptLabel || 'Looks good to me'}
                          </PaperButton>
                          <p className="basis-full text-center text-[13px] text-paper-muted">
                            No payment now. {ownerName} will reach out to book a time.
                          </p>
                          <PaperButton
                            onClick={() =>
                              reachable ? composer.current?.focus() : openForm('question')
                            }
                          >
                            Ask a question
                          </PaperButton>
                          {!chat.contact.email && (
                            <PaperButton disabled={busy} onClick={() => openForm('copy')}>
                              Email me a copy
                            </PaperButton>
                          )}
                          <PaperButton
                            disabled={busy}
                            onClick={() => (reachable ? void choose('visit') : openForm('visit'))}
                          >
                            Request a site visit
                          </PaperButton>
                          <PaperButton
                            disabled={busy}
                            onClick={() => {
                              setForm(null);
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
                  {chat.quote.preview && access && (
                    <QuotePreview preview={chat.quote.preview} access={access} />
                  )}
                </div>
              )}
            </div>
          ))}
          {pending && (
            <div className="fade-up flex justify-end">
              <CustomerBubble photo={!!pending.photo || !!pending.video}>
                {pending.video ? (
                  <div className="flex w-56 max-w-full flex-col gap-1.5">
                    {pending.video !== 'loading' && (
                      <img
                        src={pending.video}
                        alt="Your video"
                        className="w-full rounded-[12px] opacity-70"
                      />
                    )}
                    <UploadProgress sent={pending.sent} total={pending.total} />
                  </div>
                ) : pending.photo ? (
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
          {busy && (status === 'chatting' || status === 'contact') && (
            <Typing
              name={profile.name}
              initials={profile.initials}
              tone="blue"
              logo={profile.logo}
            />
          )}
          {measuring && !busy && (
            <ReadingSteps
              profile={profile}
              photos={!!chat?.measuringPhotos}
              progress={chat?.progress ?? null}
            />
          )}
        </div>
      </div>

      <footer
        className="flex flex-col gap-2 border-t border-line bg-surface px-3 py-3"
        style={{
          paddingBottom: 'max(12px, var(--safe-bottom, env(safe-area-inset-bottom, 0px)))',
        }}
      >
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        {human.slow && <p className="text-sm text-muted">Running a quick security check…</p>}
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
            {asksForPhoto && videos && (
              <button
                type="button"
                onClick={() => videoPicker.current?.click()}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent/10"
              >
                <Video className="size-4" aria-hidden /> Send a video
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

        {shownForm && (
          <form className="fade-up flex flex-col gap-2" onSubmit={submitContact}>
            {ASK[shownForm].title && <p className="text-sm text-ink-2">{ASK[shownForm].title}</p>}
            <div>
              <label htmlFor="chat-name" className="sr-only">
                Your name
              </label>
              <TextInput
                id="chat-name"
                autoComplete="name"
                placeholder="Your name"
                value={contact.name}
                onChange={(event) => setContact({ ...contact, name: event.target.value })}
              />
            </div>
            <div className={cx('grid gap-2', shownForm !== 'copy' && 'sm:grid-cols-2')}>
              {shownForm !== 'copy' && (
                <div>
                  <label htmlFor="chat-phone" className="sr-only">
                    Your phone number
                  </label>
                  <TextInput
                    id="chat-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="Phone"
                    value={contact.phone}
                    onChange={(event) => setContact({ ...contact, phone: event.target.value })}
                  />
                </div>
              )}
              <div>
                <label htmlFor="chat-email" className="sr-only">
                  Your email
                </label>
                <TextInput
                  id="chat-email"
                  type="email"
                  autoComplete="email"
                  placeholder="Email"
                  value={contact.email}
                  onChange={(event) => setContact({ ...contact, email: event.target.value })}
                />
              </div>
            </div>
            {asksAddress && shownForm === form && (
              <div>
                <label htmlFor="chat-address" className="sr-only">
                  The job’s street address
                </label>
                <TextInput
                  id="chat-address"
                  autoComplete="street-address"
                  maxLength={200}
                  placeholder="Job address"
                  value={contact.address ?? ''}
                  onChange={(event) => setContact({ ...contact, address: event.target.value })}
                />
              </div>
            )}
            {shownForm !== 'copy' && (
              <p className="text-xs text-muted">A phone number or an email is enough.</p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button type="submit" disabled={busy || !contactReady}>
                {ASK[shownForm].submit}
              </Button>
              {form && (
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="text-sm text-muted underline underline-offset-4 hover:text-ink"
                >
                  Not now
                </button>
              )}
            </div>
            <p className="text-xs text-muted">
              {asksAddress && shownForm === form
                ? `${profile.name} gets your name, how to reach you, the job address and this chat so they can reply.`
                : `${profile.name} gets your name, how to reach you and this chat so they can reply.`}{' '}
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

        {status === 'quoting' && (
          <p className="py-2 text-sm text-muted">Putting your quote together…</p>
        )}

        {measuring && !busy && (
          <p className="py-1 text-center text-sm text-muted">You can reply once it’s done.</p>
        )}

        {status === 'closed' && <p className="py-1 text-sm text-muted">This request is closed.</p>}

        {canType && !restoring && (
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
            {status === 'chatting' && videos && (
              <button
                type="button"
                onClick={() => videoPicker.current?.click()}
                disabled={busy}
                aria-label="Send a video of the job"
                title="Film a quick walk-around and we’ll count and measure from it"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                <Video className="size-5" />
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
              // Keeps the typing box focused, so the keyboard stays up between messages.
              onMouseDown={(event) => event.preventDefault()}
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
          multiple
          className="hidden"
          onChange={(event) => {
            // A few at once, sent one after another; the reading waits for all of them.
            const files = [...(event.target.files ?? [])].slice(0, MAX_PHOTOS_AT_ONCE);
            event.target.value = '';
            void (async () => {
              for (const file of files) await addPhoto(file);
            })();
          }}
        />
        <input
          ref={videoPicker}
          type="file"
          accept="video/mp4,video/quicktime,video/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void addVideo(file);
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
    <div className="mb-3 text-sm">
      <p className="font-semibold">Only you can see this quote.</p>
      <p className="mt-1 text-ink-2">A real customer would wait for your OK on this one.</p>
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
  slug,
  message,
  profile,
  access,
  local,
  localVideos,
}: {
  slug: string;
  message: ChatMessage;
  profile: BusinessProfile;
  access: ChatAccess | null;
  local: Map<string, string>;
  localVideos: Map<string, string>;
}) {
  if (message.from === 'customer' && message.kind === 'status')
    return <p className="fade-up py-1 text-center text-sm text-muted">{message.text}</p>;
  if (message.from === 'customer' && message.video)
    return (
      <div className="fade-up flex justify-end">
        <CustomerBubble photo>
          <div className="flex w-56 max-w-full flex-col gap-1.5">
            {access && (
              <div className="relative">
                <ChatVideo
                  url={videoPath(slug, access, message.video.id)}
                  access={access}
                  local={localVideos.get(message.video.id)}
                />
                {message.video.status === 'measuring' && (
                  <div
                    // Above the video: iOS draws a video over anything without a z-index.
                    className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[12px]"
                    aria-hidden
                  >
                    <div className="scan absolute inset-x-0 top-0" />
                  </div>
                )}
              </div>
            )}
            {message.video.status === 'measured' && message.video.found.length > 0 && (
              <p className="px-1 text-xs">Counted: {message.video.found.join(' · ')}</p>
            )}
          </div>
        </CustomerBubble>
      </div>
    );
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

/** How much of a video has gone up, in megabytes, with a bar. Phones can take a while. */
function UploadProgress({ sent, total }: { sent?: number; total?: number }) {
  const share = total ? Math.min(1, (sent ?? 0) / total) : 0;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
  return (
    <div className="flex flex-col gap-1.5 px-1 pb-0.5">
      <p className="text-xs">
        {!total
          ? 'Sending your video…'
          : share < 1
            ? `Sending your video… ${mb(sent ?? 0)} of ${mb(total)} MB`
            : 'Sent. Saving it…'}
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-on-accent/25">
        <div
          className="h-full rounded-full bg-on-accent transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** The quote's before-and-after. Like photos, the pictures need the chat's token to load. */
function QuotePreview({
  preview,
  access,
}: {
  preview: { before: string; after: string; from?: 'photo' | 'video' };
  access: ChatAccess;
}) {
  const [sources, setSources] = useState<{ before: string; after: string } | null>(null);
  useEffect(() => {
    let live = true;
    const loaded: string[] = [];
    Promise.all([photoUrl(access, preview.before), photoUrl(access, preview.after)])
      .then(([before, after]) => {
        loaded.push(before, after);
        if (live) setSources({ before, after });
        else loaded.forEach((url) => URL.revokeObjectURL(url));
      })
      .catch(() => {});
    return () => {
      live = false;
      loaded.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [preview.before, preview.after, access]);
  if (!sources) return null;
  return (
    <div className="mt-4">
      <BeforeAfter
        before={sources.before}
        after={sources.after}
        caption={`What it could look like when it’s done. This picture was made with AI from your ${preview.from === 'video' ? 'video' : 'photo'}, so the real result can look different.`}
      />
    </div>
  );
}

/** Like photos, chat videos need the chat's token, so they're fetched rather than linked. */
function ChatVideo({ url, access, local }: { url: string; access: ChatAccess; local?: string }) {
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
    <video
      // Without a start time iOS shows a blank box until it's played; with one it shows that frame.
      src={`${src}#t=0.001`}
      controls
      playsInline
      muted
      preload="metadata"
      aria-label="Your video"
      className="w-full rounded-[12px] bg-black"
    />
  ) : (
    <div
      className="aspect-[9/16] w-full rounded-[12px] bg-on-accent/15"
      aria-label="Loading video"
    />
  );
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
