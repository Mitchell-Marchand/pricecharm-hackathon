'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowUp,
  Ban,
  Camera,
  Check,
  MessageSquarePlus,
  Pencil,
  Receipt,
  RotateCw,
} from 'lucide-react';
import { CustomerMessage, OwnerMessage, SiteVisitMessage, Typing } from '@/components/Chat';
import { PhotoViewer, type ViewerPhoto } from '@/components/PhotoViewer';
import { QuoteBuilder } from '@/components/practice/QuoteBuilder';
import { TurnDownSheet, type TurnDownTarget } from '@/components/practice/TurnDownSheet';
import { QuoteForm } from '@/components/QuoteForm';
import { useToast } from '@/components/Toast';
import { Avatar, Button, Chip, Tag, TextArea, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  answerQuestion,
  distanceText,
  explainQuote,
  fixInsight,
  loadPractice,
  requestGuess,
  retryPractice,
  sendPracticeMessage,
  sendPracticeQuote,
  typingDelay,
  type PracticeMessage,
  type PracticeRun,
  type PracticeState,
  type QuoteDraft,
  type Tone,
} from '@/lib/practice';
import { total } from '@/lib/quote';
import { turnsDown } from '@/lib/turn-downs';
import { cx, money, rate, scrollToBottom } from '@/lib/util';

function gapPercent(guessCents: number, ownerCents: number): number | null {
  return ownerCents > 0 ? Math.round((Math.abs(guessCents - ownerCents) / ownerCents) * 100) : null;
}

function ShadowBar({
  label,
  cents,
  max,
  tone,
}: {
  label: string;
  cents: number;
  max: number;
  tone: 'accent' | 'ink';
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)_72px] items-center gap-3 sm:grid-cols-[120px_minmax(0,1fr)_80px]">
      <span className="text-sm text-muted">{label}</span>
      <span className="h-3 rounded-full bg-surface-2">
        <span
          className={cx('block h-3 rounded-full', tone === 'accent' ? 'bg-accent' : 'bg-ink')}
          style={{ width: `${Math.max(6, (cents / max) * 100)}%` }}
        />
      </span>
      <span className="tabular text-right font-mono text-sm font-semibold">{money(cents)}</span>
    </div>
  );
}

/** What turning a customer down saved, as it stands now, with a way to change it. */
function TurnedDown({
  run,
  onTurnDown,
}: {
  run: PracticeRun;
  onTurnDown: (target: TurnDownTarget) => void;
}) {
  const saved = run.turnDown;
  if (!saved) return null;
  const first = run.customer?.firstName ?? 'them';
  const line = saved.rule
    ? turnsDown(saved.rule)
    : saved.minimumCents
      ? `Charges at least ${money(saved.minimumCents)} for any job`
      : null;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-[15px] text-ink-2">
        You turned {first} down: {saved.reasonText.toLowerCase()}.{' '}
        {saved.removed
          ? 'You’ve taken out what it saved since, so live chats don’t follow it.'
          : saved.minimumCents
            ? 'Smaller jobs get your minimum from now on.'
            : 'Your Charm says no to jobs like this from now on, kindly, without a quote.'}
      </p>
      {line && !saved.removed && (
        <div className="flex items-start justify-between gap-3 rounded-sm bg-surface-2 px-3.5 py-3">
          <p className="text-[15px] font-medium text-ink">{line}</p>
          <button
            type="button"
            onClick={() =>
              onTurnDown(
                saved.rule
                  ? { mode: 'edit', rule: saved.rule }
                  : { mode: 'minimum', minimumCents: saved.minimumCents },
              )
            }
            className="inline-flex shrink-0 items-center gap-1 text-sm text-muted hover:text-accent"
          >
            <Pencil className="size-3.5" aria-hidden /> Change
          </button>
        </div>
      )}
    </div>
  );
}

function InsightCard({
  run,
  closePercent,
  onChange,
  onTurnDown,
}: {
  run: PracticeRun;
  closePercent: number;
  onChange: (run: PracticeRun) => void;
  onTurnDown: (target: TurnDownTarget) => void;
}) {
  const notify = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const ownerCents = run.quote ? total(run.quote) : 0;
  const guess = run.shadow?.cents ?? 0;
  const flagged = Boolean(run.shadow?.siteVisit);
  const reason = run.shadow?.reason ?? '';
  const gap = run.outcome === 'quote' && guess > 0 ? gapPercent(guess, ownerCents) : null;
  const apart = guess - ownerCents;
  const market = run.outcome === 'quote' ? run.market : null;
  const max = Math.max(guess, ownerCents) * 1.08 || 1;
  const save = async (id: string) => {
    const text = value.trim();
    setEditing(null);
    if (!text) return;
    try {
      onChange(await fixInsight(run.id, id, text));
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  return (
    <section
      className="fade-up rounded-md border border-line bg-surface p-5 shadow-1 sm:p-6"
      aria-labelledby={`insight-${run.id}`}
    >
      <p className="t-label text-muted">Only you see this</p>
      <h2 id={`insight-${run.id}`} className="t-h2 mt-2">
        Here&apos;s what your Charm picked up
      </h2>

      {run.outcome === 'quote' && (
        <div className="mt-5 flex flex-col gap-3">
          {guess > 0 && (
            <>
              <ShadowBar label="Its guess" cents={guess} max={max} tone="accent" />
              <ShadowBar label="Your quote" cents={ownerCents} max={max} tone="ink" />
            </>
          )}
          <p className="text-[15px] text-ink-2">
            {guess > 0 ? (
              <>
                Before you sent yours, it guessed {money(guess)}
                {apart === 0 ? (
                  <>
                    , <span className="font-semibold text-ink">the same as you</span>.
                  </>
                ) : (
                  <>
                    ,{' '}
                    <span className="font-semibold text-ink">
                      {money(Math.abs(apart))} {apart > 0 ? 'more' : 'less'} than you
                    </span>
                    {gap ? ` (${gap}%)` : ''}.
                  </>
                )}{' '}
                {gap !== null && gap <= closePercent
                  ? "That's close. It's learning your pricing."
                  : "It'll get closer with each practice quote."}
              </>
            ) : (
              <HeldBack run={run} />
            )}
          </p>
          {market && (
            <p className="text-[15px] text-ink-2">
              You may be charging less than most. {market.businesses} other{' '}
              {market.trade.toLowerCase()} businesses on PriceCharm charge about{' '}
              {rate(market.centsPerUnit)} per {market.unit.replace(/s$/, '')} for this. Yours comes
              to {rate(market.ownerCentsPerUnit)}.
            </p>
          )}
        </div>
      )}
      {run.outcome === 'declined' && <TurnedDown run={run} onTurnDown={onTurnDown} />}
      {run.outcome === 'site-visit' && (
        <p className="mt-4 text-[15px] text-ink-2">
          {flagged ? (
            <>
              <span className="font-semibold text-ink">
                Your Charm would have asked to see this one too.
              </span>{' '}
              {reason ? `It spotted the ${reason} in the photos and messages.` : null}
            </>
          ) : guess > 0 ? (
            <>
              It would have quoted {money(guess)}. Now it knows to check with you on jobs like this.
            </>
          ) : (
            <>Now it knows to check with you on jobs like this.</>
          )}
        </p>
      )}

      <ul
        className={cx(
          'mt-5 divide-y divide-line border-y border-line',
          !run.insights.length && 'hidden',
        )}
      >
        {run.insights.map((item) => (
          <li key={item.id} className="py-3">
            {editing === item.id ? (
              <form
                className="flex gap-2"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void save(item.id);
                }}
              >
                <label htmlFor={`insight-edit-${item.id}`} className="sr-only">
                  Correct this
                </label>
                <TextInput
                  id={`insight-edit-${item.id}`}
                  autoFocus
                  className="h-10"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
                <Button type="submit" size="sm" className="h-10">
                  Save
                </Button>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <p className="text-[15px]">{item.text}</p>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(item.id);
                    setValue(item.text);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 text-sm text-muted hover:text-accent"
                >
                  <Pencil className="size-3.5" aria-hidden /> Fix
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {run.outcome === 'quote' && !run.quote?.note.trim() && (
        <ExplainPrice run={run} onChange={onChange} />
      )}
    </section>
  );
}

/**
 * Why the owner priced it this way, when the quote didn't say. Whatever moved the price, said once
 * here, goes with this job when the Charm works out how they price.
 */
function ExplainPrice({
  run,
  onChange,
}: {
  run: PracticeRun;
  onChange: (run: PracticeRun) => void;
}) {
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const id = `explain-${run.id}`;
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-5 flex w-full items-start gap-3 rounded-md border border-dashed border-line-strong px-4 py-3.5 text-left hover:border-accent hover:bg-accent-soft"
      >
        <MessageSquarePlus className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <span>
          <span className="block font-semibold">Add why you priced it this way</span>
          <span className="mt-0.5 block text-sm text-muted">
            What moved the price: the size, a hard reach, the cleanup, a repeat customer. Your Charm
            learns from it.
          </span>
        </span>
      </button>
    );
  async function save() {
    const reason = text.trim();
    if (reason.length < 3 || saving) return;
    setSaving(true);
    try {
      onChange(await explainQuote(run.id, reason));
    } catch (error) {
      notify(errorMessage(error));
      setSaving(false);
    }
  }
  return (
    <form
      className="mt-5 flex flex-col gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id} className="text-sm font-semibold">
        Why this price?
      </label>
      <TextArea
        id={id}
        autoFocus
        rows={3}
        maxLength={600}
        placeholder="Two big oaks over the roof, so it needs a climber and extra cleanup."
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={text.trim().length < 3 || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The one thing the Charm asks about how the owner prices, once a quote has gone: a tap, a few
 * words of their own, or a skip. The answer is saved as one of their notes, which every price
 * follows.
 */
function OwnerQuestion({
  run,
  onChange,
}: {
  run: PracticeRun;
  onChange: (run: PracticeRun) => void;
}) {
  const notify = useToast();
  const [own, setOwn] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const question = run.question;
  if (!question || question.skipped) return null;
  const id = `question-${run.id}`;
  async function send(reply: { answer: string } | { skip: true }) {
    if (saving) return;
    setSaving('answer' in reply ? reply.answer : 'skip');
    try {
      onChange(await answerQuestion(run.id, reply));
    } catch (error) {
      notify(errorMessage(error));
      setSaving(null);
    }
  }
  if (question.answer)
    return (
      <section className="fade-up rounded-md border border-line bg-surface p-5 sm:p-6">
        <p className="t-label text-muted">Your Charm asked</p>
        <p className="mt-2 text-[15px] text-ink-2">{question.ask}</p>
        <p className="mt-3 flex gap-2 text-[15px]">
          <Check className="mt-0.5 size-4 shrink-0 text-go" aria-hidden />
          <span>
            Got it. It follows this on every quote now:{' '}
            <span className="font-semibold">{question.answer}</span>
          </span>
        </p>
      </section>
    );
  return (
    <section
      className="fade-up rounded-md border border-line bg-surface p-5 shadow-1 sm:p-6"
      aria-labelledby={id}
    >
      <p className="t-label text-muted">One question from your Charm</p>
      <h2 id={id} className="t-h2 mt-2">
        {question.ask}
      </h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {question.answers.map((answer) => (
          <Chip
            key={answer}
            selected={saving === answer}
            onClick={() => void send({ answer })}
            className="h-auto min-h-10 py-2 text-left"
          >
            {answer}
          </Chip>
        ))}
        <Chip selected={own} onClick={() => setOwn(true)}>
          Something else
        </Chip>
      </div>
      {own && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (text.trim()) void send({ answer: text.trim() });
          }}
        >
          <label htmlFor={`${id}-own`} className="sr-only">
            Your answer
          </label>
          <TextInput
            id={`${id}-own`}
            autoFocus
            className="h-10"
            maxLength={100}
            placeholder="In a few words"
            // Clear of the bar at the bottom, and the keyboard on a phone.
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center' })}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            className="h-10"
            disabled={!text.trim() || Boolean(saving)}
          >
            Save
          </Button>
        </form>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">It follows your answer on every quote.</p>
        <button
          type="button"
          onClick={() => void send({ skip: true })}
          className="shrink-0 text-sm text-muted hover:text-accent"
        >
          Skip
        </button>
      </div>
    </section>
  );
}

/** Why the Charm didn't guess this one, and when it will. */
function HeldBack({ run }: { run: PracticeRun }) {
  const why = run.shadow?.withheld;
  // How many it still needed before this one. This one counts now.
  const left = Math.max(0, (run.shadow?.toGo ?? 1) - 1);
  if (why === 'learning')
    return left ? (
      <>
        Your Charm doesn&apos;t guess yet. It makes its first guess after{' '}
        <span className="font-semibold text-ink">
          {left} more {left === 1 ? 'customer' : 'customers'}
        </span>
        , once it has enough of your prices to work from.
      </>
    ) : (
      <>
        That&apos;s enough to go on.{' '}
        <span className="font-semibold text-ink">
          From your next customer, it guesses your price before you send yours.
        </span>
      </>
    );
  if (why === 'service')
    return (
      <>
        It hadn&apos;t seen a {run.serviceName?.toLowerCase() ?? 'job like this'} priced yet, so it
        didn&apos;t guess this one. Now it has.
      </>
    );
  if (why === 'working')
    return (
      <>
        It was still working out your prices from your last quote, so it didn&apos;t guess this one.
      </>
    );
  return <>It didn&apos;t have enough to go on to guess this one. Now it does.</>;
}

/** While its guess and what it picked up come in, after the owner has answered. */
function LookingAtIt() {
  const steps = [
    'Reading the job',
    'Working out what it would have charged',
    'Lining it up with yours',
  ];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setStep((current) => Math.min(current + 1, steps.length - 1)),
      2500,
    );
    return () => window.clearInterval(timer);
  }, [steps.length]);
  return (
    <section
      className="fade-up rounded-md border border-line bg-surface p-5 shadow-1 sm:p-6"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="t-label text-muted">Only you see this</p>
      <h2 className="t-h2 mt-2">Your Charm is looking at how you priced it</h2>
      <ol className="mt-5 flex flex-col gap-3">
        {steps.map((label, index) => (
          <li key={label} className="flex items-center gap-3 text-[15px]">
            <span
              className={cx(
                'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
                index < step && 'bg-go text-surface',
                index === step && 'border-2 border-accent border-t-transparent animate-spin',
                index > step && 'border border-line-strong',
              )}
              aria-hidden
            >
              {index < step && <Check className="size-3.5" />}
            </span>
            <span className={index > step ? 'text-muted' : 'text-ink'}>{label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The customer off taking the photo the owner asked for. */
function TakingPhoto({ name, initials, tone }: { name: string; initials: string; tone: Tone }) {
  return (
    <div className="fade-up flex items-end gap-2.5" role="status">
      <div className="w-9 shrink-0 max-sm:hidden">
        <Avatar initials={initials} tone={tone} />
      </div>
      <div className="flex h-11 items-center gap-2 rounded-[16px] rounded-bl-[4px] border border-line bg-surface px-4 text-[15px] text-muted shadow-1">
        <Camera className="size-4 animate-pulse" aria-hidden />
        Taking a photo…<span className="sr-only"> {name} will send it in a moment.</span>
      </div>
    </div>
  );
}

/** After the owner answers, the quote lands first, then the customer replies, then the insights. */
type Reveal = { runId: string; messages: number; insights: boolean };

/**
 * One practice customer: the conversation, the quote or site-visit answer, and what the AI picked
 * up. Setup runs six of these; the Train page runs as many more as the owner likes.
 */
export function PracticeSession({
  business,
  run,
  onRun,
  onState,
  intro,
  done,
  as: Content = 'main',
  className,
  gutter = true,
  closePercent = 15,
}: {
  business: string;
  run: PracticeRun | null;
  /** A newer copy of this run, after the owner sends something. */
  onRun: (run: PracticeRun) => void;
  /** All the practice runs again, after a reload or a retry. */
  onState: (state: PracticeState) => void;
  intro?: ReactNode;
  /** The bottom bar once this customer is done and the owner has seen what the AI learned. */
  done: ReactNode;
  as?: 'main' | 'div';
  className?: string;
  /** Side padding, for pages that don't already have it, or don't on a phone. */
  gutter?: boolean | 'phone';
  /** How close its guess has to come to count, the owner's own setting. */
  closePercent?: number;
}) {
  const notify = useToast();
  const [typing, setTyping] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // While they type on a phone the keyboard needs the room the buttons take. Once what they typed
  // is sent, the buttons are back, so quoting never means closing the keyboard first.
  const [replying, setReplying] = useState(false);
  // A reply sent while the customer takes a photo, which goes once it's there.
  const [queued, setQueued] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  // "We don't do this job", or changing what turning one down saved.
  const [turnDown, setTurnDown] = useState<TurnDownTarget | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [nudge, setNudge] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [slow, setSlow] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const timers = useRef<number[]>([]);

  const later = (task: () => void, ms: number) => {
    timers.current.push(window.setTimeout(task, ms));
  };
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  // While a customer is being written, check back until they're ready.
  useEffect(() => {
    if (run?.status !== 'preparing') {
      setSlow(false);
      return;
    }
    const poll = window.setInterval(() => {
      loadPractice()
        .then(onState)
        .catch(() => {});
    }, 1500);
    const note = window.setTimeout(() => setSlow(true), 2000);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(note);
    };
  }, [run?.status, run?.id, onState]);

  // While the customer takes a photo, check back until it's there.
  const waiting = run?.status === 'ready' && Boolean(run.takingPhoto);
  // Answered, and its guess and what it picked up still coming: check back until they're in.
  const finishing = Boolean(run?.outcome) && !run?.finished;
  useEffect(() => {
    if (!waiting && !finishing) return;
    const poll = window.setInterval(() => {
      loadPractice()
        .then(onState)
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(poll);
  }, [waiting, finishing, run?.id, onState]);

  const visibleMessages = run
    ? reveal?.runId === run.id
      ? run.messages.slice(0, reveal.messages)
      : run.messages
    : [];
  const showInsights = Boolean(run?.finished) && (reveal?.runId !== run?.id || reveal?.insights);

  useEffect(() => {
    if (visibleMessages.length > 1 || typing || pending) scrollToBottom();
  }, [visibleMessages.length, typing, pending, showInsights, run?.takingPhoto]);

  // Every photo in the chat, in order, for the full-screen viewer.
  const viewerPhotos: ViewerPhoto[] = visibleMessages.flatMap((message) =>
    message.from === 'customer'
      ? message.photos.map((photo) => ({
          src: photo.url,
          label: `Photo from ${run?.customer?.name ?? 'your customer'}`,
        }))
      : [],
  );
  const photosBefore = (position: number) =>
    visibleMessages
      .slice(0, position)
      .reduce((sum, message) => sum + (message.from === 'customer' ? message.photos.length : 0), 0);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!run || !text) return;
    // Never a dead tap: while a photo's on its way, the reply waits and goes once it's there.
    if (waiting && !typing && !pending && !run.outcome) {
      setQueued(true);
      return;
    }
    if (busy) return;
    setQueued(false);
    setDraft('');
    if (replyBox.current) replyBox.current.style.height = '';
    setPending(text);
    setTyping(true);
    const started = Date.now();
    try {
      const result = await sendPracticeMessage(run.id, text);
      const reply = result.run.messages.at(-1)?.text ?? '';
      // Keep the typing dots up long enough to read like a reply.
      const wait = Math.max(0, typingDelay(reply) - (Date.now() - started));
      later(() => {
        setTyping(false);
        setPending(null);
        if (result.run.finished) {
          // A second ask to see the job ends this customer. What the AI picked up follows their reply.
          setReveal({
            runId: result.run.id,
            messages: result.run.messages.length,
            insights: false,
          });
          onRun(result.run);
          later(
            () =>
              setReveal({
                runId: result.run.id,
                messages: result.run.messages.length,
                insights: true,
              }),
            600,
          );
          return;
        }
        onRun(result.run);
        if (result.nudge) setNudge(true);
      }, wait);
    } catch (error) {
      setTyping(false);
      setPending(null);
      setDraft(text);
      notify(errorMessage(error));
    }
  }

  function stageReveal(next: PracticeRun) {
    const before = next.messages.length - 1;
    const reply = next.messages.at(-1)?.text ?? '';
    setReveal({ runId: next.id, messages: before, insights: false });
    onRun(next);
    later(() => setTyping(true), 1600);
    later(
      () => {
        setTyping(false);
        setReveal({ runId: next.id, messages: next.messages.length, insights: false });
      },
      1600 + typingDelay(reply),
    );
    later(
      () => setReveal({ runId: next.id, messages: next.messages.length, insights: true }),
      2200 + typingDelay(reply),
    );
  }

  async function sendQuote(quote: QuoteDraft) {
    if (!run) return;
    setSending(true);
    setSendError('');
    try {
      const next = await sendPracticeQuote(run.id, quote);
      setBuilderOpen(false);
      setNudge(false);
      stageReveal(next);
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function retry() {
    if (!run) return;
    try {
      onState(await retryPractice(run.id));
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  function onReplyKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const busy =
    typing || Boolean(pending) || Boolean(run?.outcome) || run?.status !== 'ready' || waiting;
  useEffect(() => {
    // Only when the wait ends; send is this render's own.
    if (queued && !busy) void send();
  }, [queued, busy]);
  const customer = run?.customer;
  const lastQuoteId = [...(run?.messages ?? [])].reverse().find((message) => message.quote)?.id;
  const renderMessage = (message: PracticeMessage, position: number) => {
    if (!customer) return null;
    if (message.quote)
      return (
        <div key={message.id} className="ml-auto w-full max-w-[480px] pr-3 pb-3">
          <QuoteForm
            quote={message.quote}
            business={business}
            stamp="practice"
            animate={reveal?.runId === run?.id && message.id === lastQuoteId}
            footnote="Practice quote. Nothing was sent."
          />
        </div>
      );
    if (message.siteVisit) return <SiteVisitMessage key={message.id} reason={message.siteVisit} />;
    if (message.from === 'owner')
      return <OwnerMessage key={message.id}>{message.text}</OwnerMessage>;
    const following = visibleMessages[position + 1];
    return (
      <CustomerMessage
        key={message.id}
        name={customer.name}
        initials={customer.initials}
        tone={customer.tone}
        photos={message.photos.length ? message.photos.map((photo) => photo.url) : undefined}
        onPhoto={(index) => setViewing(photosBefore(position) + index)}
        showAvatar={!following || following.from !== 'customer'}
        flat
      >
        {message.text}
      </CustomerMessage>
    );
  };

  const sides = gutter === 'phone' ? 'max-sm:gutter' : gutter && 'gutter';

  return (
    <>
      <Content className={cx('mx-auto w-full max-w-[760px] flex-1', sides, className)}>
        {intro}
        {run?.status === 'failed' ? (
          <div className="rounded-md border border-line bg-surface p-5" role="alert">
            <p className="font-semibold">This practice customer didn&apos;t come through.</p>
            <p className="mt-1 text-ink-2">{run.failure}</p>
            <Button className="mt-4" variant="secondary" onClick={() => void retry()}>
              <RotateCw aria-hidden /> Try again
            </Button>
          </div>
        ) : (
          <>
            {/* On a phone this is the header's job (PracticeBar). */}
            <div className="flex items-center gap-3 border-b border-line pb-4 max-sm:hidden">
              {customer ? (
                <Avatar initials={customer.initials} tone={customer.tone} size="lg" />
              ) : (
                <span className="shimmer size-12 shrink-0 rounded-full" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {customer
                    ? [customer.name, customer.place, distanceText(customer.distance)]
                        .filter(Boolean)
                        .join(' · ')
                    : 'Your next practice customer'}
                </p>
                <p className="text-sm text-muted">
                  Pretend customer. Nothing you send here goes anywhere.
                </p>
              </div>
              <Tag tone="accent">Practice</Tag>
            </div>

            <div className="flex flex-col gap-4 sm:mt-6" aria-live="polite">
              {visibleMessages.map(renderMessage)}
              {pending && <OwnerMessage>{pending}</OwnerMessage>}
              {customer && run?.takingPhoto && !typing && (
                <TakingPhoto
                  name={customer.firstName}
                  initials={customer.initials}
                  tone={customer.tone}
                />
              )}
              {(typing || run?.status === 'preparing') && (
                <Typing
                  name={customer?.firstName ?? 'Your customer'}
                  initials={customer?.initials ?? '…'}
                  tone={customer?.tone ?? 'canary'}
                  flat
                />
              )}
              {run && finishing && (reveal?.runId !== run.id || reveal?.insights) && (
                <LookingAtIt />
              )}
              {run && showInsights && (
                <InsightCard
                  run={run}
                  closePercent={closePercent}
                  onChange={onRun}
                  onTurnDown={setTurnDown}
                />
              )}
              {run?.question &&
                (finishing || showInsights) &&
                (reveal?.runId !== run.id || reveal?.insights) && (
                  <OwnerQuestion run={run} onChange={onRun} />
                )}
            </div>
          </>
        )}
      </Content>

      <div
        className="sticky bottom-0 z-30 border-t border-line bg-bg/92 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className={cx('mx-auto max-w-[760px] py-3 max-sm:py-2', sides)}>
          {run?.finished && showInsights ? (
            done
          ) : run?.outcome ? (
            <p className="py-3 text-sm text-muted" role="status">
              {run.outcome === 'quote'
                ? `Quote sent to ${customer?.firstName}.`
                : run.outcome === 'declined'
                  ? `Told ${customer?.firstName} you can’t take it on.`
                  : `Asked ${customer?.firstName} for a visit.`}
            </p>
          ) : (
            <>
              {run?.status === 'preparing' && slow && (
                <p className="pb-2.5 text-sm text-muted max-sm:pb-2" role="status">
                  Your customer is on the way, with photos of the job. This can take about half a
                  minute.
                </p>
              )}
              <div
                className={cx(
                  'flex flex-wrap items-center gap-2 pb-2.5 max-sm:flex-nowrap max-sm:pb-2',
                  replying && draft.trim() && 'max-sm:hidden',
                )}
              >
                <Button
                  variant="quote"
                  onClick={() => {
                    setSendError('');
                    setBuilderOpen(true);
                    if (run) void requestGuess(run.id).catch(() => {});
                  }}
                  disabled={run?.status !== 'ready' || !run.messages.length || waiting}
                  className={cx('max-sm:h-10 max-sm:flex-1', nudge && 'pulse')}
                >
                  <Receipt aria-hidden /> <span className="sm:hidden">Send quote</span>
                  <span className="max-sm:hidden">I have enough to quote</span>
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => run && setTurnDown({ mode: 'decline', run })}
                  disabled={run?.status !== 'ready' || !run.messages.length || busy}
                  className="max-sm:h-10 max-sm:flex-1"
                >
                  <Ban aria-hidden /> <span className="sm:hidden">Turn down</span>
                  <span className="max-sm:hidden">We don’t do this job</span>
                </Button>
              </div>
              <form onSubmit={(event) => void send(event)} className="flex items-end gap-2">
                <label htmlFor="practice-reply" className="sr-only">
                  Reply to {customer?.firstName ?? 'the customer'}
                </label>
                <textarea
                  id="practice-reply"
                  ref={replyBox}
                  rows={1}
                  value={draft}
                  placeholder={
                    customer ? `Ask ${customer.firstName} a question…` : 'Ask a question…'
                  }
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setQueued(false);
                    event.target.style.height = 'auto';
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
                  }}
                  onKeyDown={onReplyKey}
                  onFocus={() => setReplying(true)}
                  onBlur={() => setReplying(false)}
                  className="max-h-36 min-h-12 min-w-0 flex-1 resize-none rounded-sm border border-line-strong bg-surface px-3.5 py-3 text-base leading-6 text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none max-sm:min-h-11 max-sm:py-2"
                />
                <Button
                  type="submit"
                  aria-label="Send"
                  disabled={!draft.trim() || (busy && !waiting) || queued}
                  className="size-12 px-0 max-sm:size-11"
                >
                  <ArrowUp aria-hidden />
                </Button>
              </form>
              {queued && (
                <p className="pt-2 text-sm text-muted" role="status">
                  It goes as soon as the photo comes through.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <TurnDownSheet
        target={turnDown}
        onClose={() => setTurnDown(null)}
        onDeclined={(next) => {
          setTurnDown(null);
          setNudge(false);
          stageReveal(next);
        }}
        onSaved={() => {
          setTurnDown(null);
          notify('Saved. Your Charm follows it from now on.');
          void loadPractice()
            .then(onState)
            .catch(() => {});
        }}
      />
      <PhotoViewer
        photos={viewerPhotos}
        index={viewing !== null && viewing < viewerPhotos.length ? viewing : null}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
      />

      {run && customer && (
        <QuoteBuilder
          open={builderOpen}
          customer={{
            id: run.id,
            name: customer.name,
            firstName: customer.firstName,
            suggestions: run.suggestions,
          }}
          sending={sending}
          sendingNote="Checking it against your Charm’s guess. This takes about 30 seconds."
          error={sendError}
          onClose={() => setBuilderOpen(false)}
          onSend={(quote) => void sendQuote(quote)}
        />
      )}
    </>
  );
}
