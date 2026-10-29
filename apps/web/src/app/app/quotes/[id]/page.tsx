'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUp, Check, CircleAlert, Pencil, Send } from 'lucide-react';
import { BeforeAfter } from '@/components/BeforeAfter';
import { CustomerMessage, OwnerMessage } from '@/components/Chat';
import { useOwner } from '@/components/owner/OwnerShell';
import { QuoteStatusTag } from '@/components/owner/QuoteStatus';
import { QuoteBuilder } from '@/components/practice/QuoteBuilder';
import { PaperButton, QuoteForm, type Stamp } from '@/components/QuoteForm';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toast';
import { Button, Field, Segmented, Tag, TextArea, TextInput } from '@/components/ui';
import type { LearningStyle } from '@/lib/account';
import { ApiError, errorMessage } from '@/lib/api';
import {
  approveQuote,
  declineQuote,
  loadQuote,
  messageCustomer,
  type QuoteDetail,
  type QuoteVideo,
  type ThreadMessage,
} from '@/lib/owner';
import { restyle, type Quote } from '@/lib/quote';
import { cx, shortDate } from '@/lib/util';

const STAMPS: Partial<Record<QuoteDetail['status'], Stamp>> = {
  review: 'draft',
  sent: 'sent',
  accepted: 'accepted',
  visit_requested: 'sent',
  lost: 'sent',
  expired: 'sent',
};

export default function QuotePage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useOwner();
  const notify = useToast();
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  // How the price goes out: as the Charm drafted it, or the owner's pick.
  const [style, setStyle] = useState<LearningStyle | null>(null);

  useEffect(() => {
    loadQuote(id)
      .then(setQuote)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [id]);

  if (error)
    return (
      <>
        <BackLink />
        <p className="mt-6 text-stop" role="alert">
          {error}
        </p>
      </>
    );
  if (!quote) return <div className="shimmer h-64 rounded-md" aria-busy="true" />;

  const first = quote.customer.split(' ')[0];
  const waiting = quote.status === 'review';
  const drafted: LearningStyle = quote.card.style ?? 'firm';
  const chosen = style ?? drafted;
  const shown = waiting && chosen !== drafted ? restyle(quote.card, chosen) : quote.card;

  async function approve(card?: Quote) {
    setBusy(true);
    setActionError('');
    try {
      const sent = await approveQuote(id, card, chosen !== drafted ? chosen : undefined);
      setQuote(sent);
      setEditing(false);
      notify(
        sent.test ? 'Sent to your test chat.' : `Sent. ${first} has the quote in their inbox.`,
      );
    } catch (approveError) {
      const message = errorMessage(approveError);
      setActionError(
        approveError instanceof ApiError && approveError.code === 'BILLING_LIMIT'
          ? `${message} You can change this in Settings.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BackLink />
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2" data-private>
        <h1 className="t-h1">{quote.customer}</h1>
        <QuoteStatusTag status={quote.status} />
        {quote.test && <Tag>Test</Tag>}
        {quote.reachable === false && !quote.test && <Tag>Only looked</Tag>}
      </div>
      <p className="mt-2 text-ink-2" data-private>
        {[
          quote.serviceName,
          `No. ${quote.number}`,
          shortDate(quote.createdAt),
          quote.customerPhone,
          quote.customerEmail,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {quote.reachable === false && !quote.test && (
        <p className="mt-3 text-sm text-muted">
          They saw this quote but didn&apos;t leave a phone number or email, so it wasn&apos;t
          billed. You&apos;ll hear from us if they come back to it.
        </p>
      )}
      {quote.test && (
        <p className="mt-3 text-sm text-muted">
          You tried this one yourself. Nothing was emailed or billed.
        </p>
      )}

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <div className="order-2 min-w-0 lg:order-1" data-private>
          <h2 className="t-h3">The conversation</h2>
          {quote.summary && <p className="mt-2 text-ink-2">{quote.summary}</p>}
          {quote.details && (
            <p className="mt-2 text-sm text-muted">
              <span className="font-semibold text-ink-2">Details: </span>
              {quote.details}
            </p>
          )}
          {quote.videos?.map((video) => (
            <VideoFindings key={video.id} video={video} />
          ))}
          {quote.preview && (
            <div className="mt-5">
              <BeforeAfter
                before={quote.preview.before}
                after={quote.preview.after}
                caption={
                  <>
                    Customers see this with the quote: their photo, and a picture of it done that
                    Muse Image made from it. You can turn it off in{' '}
                    <Link href="/app/settings" className="underline underline-offset-2">
                      Settings
                    </Link>
                    .
                  </>
                }
              />
            </div>
          )}
          <Thread messages={quote.messages} customer={quote.customer} />
          <Reply quote={quote} first={first} onSent={setQuote} />
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-5 lg:sticky lg:top-24 lg:order-2">
          {waiting && <WhyWaiting quote={quote} />}
          {waiting && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold">Send as</p>
              <Segmented<LearningStyle>
                label="Send as"
                value={chosen}
                onChange={setStyle}
                options={[
                  { value: 'firm', label: 'Firm price' },
                  { value: 'range', label: 'Price range' },
                  { value: 'estimate', label: 'Estimate' },
                ]}
              />
            </div>
          )}
          <QuoteForm
            quote={shown}
            business={me.business.name}
            stamp={STAMPS[quote.status]}
            actions={
              waiting ? (
                <>
                  <PaperButton primary disabled={busy} onClick={() => void approve()}>
                    <Send aria-hidden /> {busy ? 'Sending…' : 'Send quote'}
                  </PaperButton>
                  <PaperButton onClick={() => setEditing(true)}>
                    <Pencil aria-hidden /> Edit
                  </PaperButton>
                  <PaperButton onClick={() => setDeclining(true)}>Decline</PaperButton>
                </>
              ) : undefined
            }
          />
          {actionError && (
            <p className="text-sm text-stop" role="alert">
              {actionError}{' '}
              {actionError.includes('Settings') && (
                <Link href="/app/settings" className="underline underline-offset-4">
                  Open Settings
                </Link>
              )}
            </p>
          )}
          {quote.status === 'declined' && (
            <p className="text-sm text-muted">You declined this one. {first} was told politely.</p>
          )}
          {quote.outcome && (
            <p className="text-sm text-ink-2">
              <span className="font-semibold text-ink">{first} isn&apos;t going ahead: </span>
              {quote.outcome.reason.charAt(0).toLowerCase() + quote.outcome.reason.slice(1)}.
              {quote.outcome.note && <> They added: &ldquo;{quote.outcome.note}&rdquo;</>}
            </p>
          )}
          {quote.status === 'accepted' && quote.acceptLabel && (
            <p className="text-sm text-ink-2" data-private>
              {first} tapped &ldquo;{quote.acceptLabel}&rdquo;.
            </p>
          )}
          {quote.status === 'expired' && (
            <p className="text-sm text-muted">
              {first} didn&apos;t answer before the quote ran out. They can still accept it.
            </p>
          )}
        </div>
      </div>

      <QuoteBuilder
        open={editing}
        customer={{ id: quote.id, name: quote.customer, firstName: first, suggestions: [] }}
        initial={quote.card}
        subtitle={`Change anything, then send it. ${first} only sees the quote, not your note.`}
        sending={busy}
        error={actionError}
        onClose={() => setEditing(false)}
        onSend={(draft) => void approve({ ...quote.card, ...draft })}
      />
      <DeclineSheet
        open={declining}
        quote={quote}
        business={me.business.name}
        onClose={() => setDeclining(false)}
        onDeclined={(declined) => {
          setQuote(declined);
          setDeclining(false);
          notify(`Declined. ${first} got your message.`);
        }}
      />
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/app"
      className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden /> All quotes
    </Link>
  );
}

/** Why the quote didn't go out on its own, and what the Charm based it on. */
function WhyWaiting({ quote }: { quote: QuoteDetail }) {
  const reasons = quote.checks
    .filter((check) => !check.passed && check.detail)
    .map((check) => check.detail);
  if (!reasons.length && quote.reviewReason) reasons.push(quote.reviewReason);
  return (
    <section
      className="rounded-md border border-line bg-canary-soft p-4"
      aria-labelledby="why-title"
    >
      <h2 id="why-title" className="flex items-center gap-2 font-semibold">
        <CircleAlert className="size-5" aria-hidden /> Why it&apos;s waiting for you
      </h2>
      {reasons.length === 1 ? (
        <p className="mt-2 text-[15px]">{reasons[0]}</p>
      ) : (
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[15px]">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {(quote.reasoning || quote.basis) && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-ink/10 pt-3 text-sm text-ink-2">
          {quote.basis && (
            <p>
              <span className="font-semibold text-ink">Started from: </span>
              {quote.basis}
            </p>
          )}
          {quote.reasoning && (
            <p>
              <span className="font-semibold text-ink">How your Charm priced it: </span>
              {quote.reasoning}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const plural = (unit: string, count: number) => (count === 1 ? unit.replace(/s$/, '') : unit);

/** What was counted and measured in a customer's walk-around video, and where each number came from. */
function VideoFindings({ video }: { video: QuoteVideo }) {
  if (video.status === 'measuring')
    return <p className="mt-4 text-sm text-muted">Measuring the video they sent…</p>;
  if (video.status === 'failed')
    return (
      <p className="mt-4 text-sm text-muted">
        They sent a video, but it couldn&apos;t be measured. {video.failure}
      </p>
    );
  return (
    <section
      className="mt-5 rounded-md border border-line bg-surface p-4"
      aria-labelledby={`video-${video.id}`}
    >
      <h3 id={`video-${video.id}`} className="font-semibold">
        Measured from their video
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5 text-[15px]">
        {video.counts.map((item) => (
          <li key={item.label}>
            <span className="font-semibold">
              {item.count} {plural(item.unit, item.count)}
            </span>
            <span className="text-ink-2">
              {' '}
              — each one followed through the video and counted once
              {item.sparkCount !== null && item.sparkCount !== item.count
                ? `. Watching it straight through, about ${item.sparkCount}.`
                : '.'}
            </span>
          </li>
        ))}
        {video.area && (
          <li>
            <span className="font-semibold">
              {video.area.surface}: about {video.area.low.toLocaleString()}–
              {video.area.high.toLocaleString()} {video.area.unit}
            </span>
            {video.area.basis && (
              <span className="text-ink-2"> — sized from {video.area.basis}.</span>
            )}
          </li>
        )}
        {video.narration && (
          <li className="text-ink-2">
            <span className="font-semibold text-ink">They said: </span>
            {video.narration}
          </li>
        )}
      </ul>
      {video.overlays.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {video.overlays.map((overlay) => (
            <figure key={overlay.url} className="flex flex-col gap-1">
              <img
                src={overlay.url}
                alt={`${overlay.label} outlined on a still from their video`}
                className="w-full rounded-[10px] border border-line"
              />
              <figcaption className="text-xs text-muted">{overlay.label} outlined</figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

function Thread({ messages, customer }: { messages: ThreadMessage[]; customer: string }) {
  const initials = customer
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    // A customer's own words and photos: never in a session recording.
    <div className="ph-no-capture mt-5 flex flex-col gap-3" data-private>
      {messages.map((message) => {
        if (message.kind === 'status')
          return (
            <p key={message.id} className="py-1 text-center text-sm text-muted">
              {message.from === 'customer' ? `${customer.split(' ')[0]}: ` : ''}
              {message.text}
            </p>
          );
        if (message.from === 'customer' && message.videoId)
          return (
            <CustomerMessage
              key={message.id}
              name={customer}
              initials={initials || 'C'}
              tone="blue"
            >
              <video
                src={`/api/v1/app/videos/${message.videoId}`}
                controls
                playsInline
                muted
                preload="metadata"
                aria-label={`${customer}’s video`}
                className="w-64 max-w-full rounded-[12px] bg-black"
              />
            </CustomerMessage>
          );
        if (message.from === 'customer')
          return (
            <CustomerMessage
              key={message.id}
              name={customer}
              initials={initials || 'C'}
              tone="blue"
              photos={message.photos.length ? message.photos.map((photo) => photo.url) : undefined}
            >
              {message.text || undefined}
            </CustomerMessage>
          );
        if (message.from === 'owner')
          return <OwnerMessage key={message.id}>{message.text}</OwnerMessage>;
        return (
          <div key={message.id} className="flex flex-col items-end gap-1">
            <p className="text-xs text-muted">Your Charm</p>
            <p className="max-w-[85%] rounded-[16px] rounded-br-[4px] border border-line bg-surface-2 px-4 py-3 text-[15.5px] leading-[1.55] sm:max-w-[75%]">
              {message.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** The owner writes to the customer directly. The AI stops replying in that chat. */
function Reply({
  quote,
  first,
  onSent,
}: {
  quote: QuoteDetail;
  first: string;
  onSent: (quote: QuoteDetail) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (quote.status === 'declined') return null;

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      onSent(await messageCustomer(quote.id, text.trim()));
      setText('');
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void send(event)} className="mt-6 border-t border-line pt-5">
      <label htmlFor="owner-reply" className="text-sm font-semibold">
        Message {first}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <TextInput
          id="owner-reply"
          autoComplete="off"
          maxLength={2000}
          placeholder="Ask a question or add a note"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Send message"
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-sm bg-ink text-on-ink hover:opacity-90 disabled:opacity-30"
        >
          <ArrowUp className="size-5" />
        </button>
      </div>
      <p
        className={cx('mt-2 text-sm', error ? 'text-stop' : 'text-muted')}
        role={error ? 'alert' : undefined}
      >
        {error ||
          (quote.test
            ? 'This is your test chat, so nothing is emailed.'
            : `${first} gets it by email and can reply in the chat. Your Charm stops replying once you step in.`)}
      </p>
    </form>
  );
}

function DeclineSheet({
  open,
  quote,
  business,
  onClose,
  onDeclined,
}: {
  open: boolean;
  quote: QuoteDetail;
  business: string;
  onClose: () => void;
  onDeclined: (quote: QuoteDetail) => void;
}) {
  const first = quote.customer.split(' ')[0];
  const [message, setMessage] = useState(
    `Thanks for asking, ${first}. ${business} isn’t able to take on this job, sorry.`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Decline this request"
      subtitle={`${first} won’t get a quote.`}
    >
      <div className="flex flex-col gap-4">
        <Field label={`Your message to ${first}`} htmlFor="decline-message">
          <TextArea
            id="decline-message"
            rows={4}
            maxLength={1000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              declineQuote(quote.id, message.trim())
                .then(onDeclined)
                .catch((declineError) => setError(errorMessage(declineError)))
                .finally(() => setBusy(false));
            }}
          >
            <Check aria-hidden /> {busy ? 'Declining…' : 'Decline and send'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
