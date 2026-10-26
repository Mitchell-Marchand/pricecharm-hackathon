'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarCheck,
  Pencil,
  Receipt,
  RotateCw,
} from 'lucide-react';
import { CustomerMessage, OwnerMessage, SiteVisitMessage, Typing } from '@/components/Chat';
import { QuoteBuilder, SiteVisitSheet } from '@/components/practice/QuoteBuilder';
import { QuoteForm } from '@/components/QuoteForm';
import { SetupLoading } from '@/components/SetupLoading';
import { useToast } from '@/components/Toast';
import { WizardHeader } from '@/components/Wizard';
import { Avatar, Button, Tag, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';
import {
  askForVisit,
  finishPractice,
  fixInsight,
  loadPractice,
  preparePractice,
  requestGuess,
  retryPractice,
  sendPracticeMessage,
  sendPracticeQuote,
  typingDelay,
  type PracticeMessage,
  type PracticeRun,
  type PracticeState,
  type QuoteDraft,
} from '@/lib/practice';
import { total } from '@/lib/quote';
import { cx, money, scrollToBottom } from '@/lib/util';

function gapPercent(guessCents: number, ownerCents: number): number | null {
  return ownerCents > 0 ? Math.round((Math.abs(guessCents - ownerCents) / ownerCents) * 100) : null;
}

function PracticeProgress({
  index,
  finished,
  count,
}: {
  index: number;
  finished: number;
  count: number;
}) {
  return (
    <div className="gutter mx-auto flex max-w-[760px] items-center gap-4 pb-3">
      <p className="shrink-0 text-sm font-semibold">
        Practice quote {Math.min(index + 1, count)} of {count}
      </p>
      <div
        className="flex flex-1 gap-1.5"
        role="progressbar"
        aria-label="Practice quotes finished"
        aria-valuemin={0}
        aria-valuemax={count}
        aria-valuenow={finished}
      >
        {Array.from({ length: count }, (_, slot) => (
          <span
            key={slot}
            className={cx(
              'relative h-2 flex-1 overflow-hidden rounded-full',
              slot === index ? 'bg-line-strong' : 'bg-line',
            )}
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-canary transition-[width] duration-700 ease-out"
              style={{ width: slot < finished ? '100%' : '0%' }}
            />
          </span>
        ))}
      </div>
    </div>
  );
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

function InsightCard({
  run,
  onChange,
}: {
  run: PracticeRun;
  onChange: (run: PracticeRun) => void;
}) {
  const notify = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const ownerCents = run.quote ? total(run.quote) : 0;
  const guess = run.shadow?.cents ?? 0;
  const flagged = Boolean(run.shadow?.siteVisit);
  const reason = run.shadow?.reason ?? '';
  const gap = run.outcome === 'quote' && guess > 0 ? gapPercent(guess, ownerCents) : null;
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
        Here&apos;s what your AI picked up
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
                Before you sent yours, it guessed {money(guess)}.{' '}
                <span className="font-semibold text-ink">{gap}% apart.</span>{' '}
                {gap !== null && gap <= 15
                  ? "That's close. It's learning your pricing."
                  : "It'll get closer with each practice quote."}
              </>
            ) : (
              <>It didn&apos;t have enough to go on to guess this one. Now it does.</>
            )}
            {flagged &&
              ` It would also have asked to see this one first${reason ? `, because of the ${reason}` : ''}.`}
          </p>
        </div>
      )}
      {run.outcome === 'site-visit' && (
        <p className="mt-4 text-[15px] text-ink-2">
          {flagged ? (
            <>
              <span className="font-semibold text-ink">
                Your AI would have asked to see this one too.
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

      <ul className="mt-5 divide-y divide-line border-y border-line">
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
    </section>
  );
}

/** After the owner answers, the quote lands first, then the customer replies, then the insights. */
type Reveal = { runId: string; messages: number; insights: boolean };

export default function PracticeStep() {
  const { state: onboarding, goTo } = useOnboarding();
  const notify = useToast();
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [index, setIndex] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [visitOpen, setVisitOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [nudge, setNudge] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [slow, setSlow] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const timers = useRef<number[]>([]);

  const later = (task: () => void, ms: number) => {
    timers.current.push(window.setTimeout(task, ms));
  };
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const apply = useCallback((next: PracticeState) => {
    setPractice(next);
    setIndex((current) => current ?? next.current);
  }, []);

  useEffect(() => {
    preparePractice()
      .then(apply)
      .catch((error) => setLoadError(errorMessage(error)));
  }, [apply]);

  const run = practice && index !== null ? practice.runs[index] : null;

  // While a customer is being written, check back until they're ready.
  useEffect(() => {
    if (run?.status !== 'preparing') {
      setSlow(false);
      return;
    }
    const poll = window.setInterval(() => {
      loadPractice()
        .then(apply)
        .catch(() => {});
    }, 1500);
    const note = window.setTimeout(() => setSlow(true), 6000);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(note);
    };
  }, [run?.status, run?.id, apply]);

  const visibleMessages = run
    ? reveal?.runId === run.id
      ? run.messages.slice(0, reveal.messages)
      : run.messages
    : [];
  const showInsights = Boolean(run?.finished) && (reveal?.runId !== run?.id || reveal?.insights);

  useEffect(() => {
    if (visibleMessages.length > 1 || typing || pending) scrollToBottom();
  }, [visibleMessages.length, typing, pending, showInsights]);

  if (!onboarding) return <SetupLoading />;
  const business = onboarding.business.name || 'Your business';
  const count = practice?.count ?? 3;
  const finishedCount = practice?.finished ?? 0;

  const replaceRun = (next: PracticeRun) =>
    setPractice((current) =>
      current
        ? {
            ...current,
            runs: current.runs.map((item) => (item.id === next.id ? next : item)),
            finished: current.runs.filter((item) => (item.id === next.id ? next : item).finished)
              .length,
          }
        : current,
    );

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!run || !text || busy) return;
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
        replaceRun(result.run);
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
    replaceRun(next);
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

  async function sendVisit(reason: string) {
    if (!run) return;
    setSending(true);
    setSendError('');
    try {
      const next = await askForVisit(run.id, reason);
      setVisitOpen(false);
      stageReveal(next);
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function next() {
    if (!practice || index === null) return;
    setNudge(false);
    setDraft('');
    setReveal(null);
    if (index < practice.runs.length - 1) {
      setIndex(index + 1);
      window.scrollTo({ top: 0 });
      loadPractice()
        .then(setPractice)
        .catch(() => {});
      return;
    }
    try {
      await finishPractice();
      await goTo('ready');
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  async function retry() {
    if (!run) return;
    try {
      setPractice(await retryPractice(run.id));
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

  const busy = typing || Boolean(pending) || Boolean(run?.outcome) || run?.status !== 'ready';
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
        showAvatar={!following || following.from !== 'customer'}
      >
        {message.text}
      </CustomerMessage>
    );
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={3}>
        <PracticeProgress index={index ?? 0} finished={finishedCount} count={count} />
      </WizardHeader>

      <main className="gutter mx-auto w-full max-w-[760px] flex-1 pt-8 pb-10">
        {index === 0 && (run?.messages.length ?? 0) <= 1 && (
          <div className="mb-8">
            <button
              type="button"
              onClick={() => void goTo('jobs')}
              className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
            >
              <ArrowLeft className="size-4" aria-hidden /> Past jobs
            </button>
            <h1 className="t-h1 mt-4">Answer it like a real lead.</h1>
            <p className="mt-3 text-lg text-ink-2">
              Ask what you&apos;d normally ask, then send a quote. Your AI learns from how you
              handle it.
            </p>
          </div>
        )}

        {loadError && (
          <p className="text-stop" role="alert">
            {loadError}
          </p>
        )}

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
            <div className="flex items-center gap-3 border-b border-line pb-4">
              {customer ? (
                <Avatar initials={customer.initials} tone={customer.tone} size="lg" />
              ) : (
                <span className="shimmer size-12 shrink-0 rounded-full" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {customer
                    ? `${customer.name} · ${customer.place}`
                    : 'Your next practice customer'}
                </p>
                <p className="text-sm text-muted">
                  Pretend customer. Nothing you send here goes anywhere.
                </p>
              </div>
              <Tag tone="accent">Practice</Tag>
            </div>

            <div className="mt-6 flex flex-col gap-4" aria-live="polite">
              {visibleMessages.map(renderMessage)}
              {pending && <OwnerMessage>{pending}</OwnerMessage>}
              {(typing || run?.status === 'preparing') && (
                <Typing
                  name={customer?.firstName ?? 'Your customer'}
                  initials={customer?.initials ?? '…'}
                  tone={customer?.tone ?? 'canary'}
                />
              )}
              {run?.status === 'preparing' && slow && (
                <p className="text-sm text-muted" role="status">
                  Writing a practice customer for your trade, with photos of the job. This takes
                  about half a minute the first time.
                </p>
              )}
              {run && showInsights && <InsightCard run={run} onChange={replaceRun} />}
            </div>
          </>
        )}
      </main>

      <div
        className="sticky bottom-0 z-30 border-t border-line bg-bg/92 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="gutter mx-auto max-w-[760px] py-3">
          {run?.finished && showInsights ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {index !== null && index < count - 1
                  ? `${count - finishedCount} to go. The next one is ready.`
                  : `All ${count === 3 ? 'three' : count} done.`}
              </p>
              <Button size="lg" onClick={() => void next()}>
                {index !== null && index < count - 1
                  ? 'Next practice request'
                  : 'See what your AI learned'}{' '}
                <ArrowRight aria-hidden />
              </Button>
            </div>
          ) : run?.outcome ? (
            <p className="py-3 text-sm text-muted" role="status">
              {run.outcome === 'quote'
                ? `Quote sent to ${customer?.firstName}.`
                : `Asked ${customer?.firstName} for a visit.`}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 pb-2.5">
                <Button
                  variant="quote"
                  onClick={() => {
                    setSendError('');
                    setBuilderOpen(true);
                    if (run) void requestGuess(run.id).catch(() => {});
                  }}
                  disabled={run?.status !== 'ready' || !run.messages.length}
                  className={cx(nudge && 'pulse')}
                >
                  <Receipt aria-hidden /> Create quote
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSendError('');
                    setVisitOpen(true);
                    if (run) void requestGuess(run.id).catch(() => {});
                  }}
                  disabled={run?.status !== 'ready' || !run.messages.length}
                >
                  <CalendarCheck aria-hidden /> <span className="sm:hidden">Visit first</span>
                  <span className="hidden sm:inline">I&apos;d need to see it first</span>
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
                    event.target.style.height = 'auto';
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
                  }}
                  onKeyDown={onReplyKey}
                  className="max-h-36 min-h-12 min-w-0 flex-1 resize-none rounded-sm border border-line-strong bg-surface px-3.5 py-3 text-base leading-6 text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
                />
                <Button
                  type="submit"
                  aria-label="Send"
                  disabled={!draft.trim() || busy}
                  className="size-12 px-0"
                >
                  <ArrowUp aria-hidden />
                </Button>
              </form>
            </>
          )}
        </div>
      </div>

      {run && customer && (
        <>
          <QuoteBuilder
            open={builderOpen}
            customer={{
              id: run.id,
              name: customer.name,
              firstName: customer.firstName,
              suggestions: run.suggestions,
            }}
            sending={sending}
            error={sendError}
            onClose={() => setBuilderOpen(false)}
            onSend={(quote) => void sendQuote(quote)}
          />
          <SiteVisitSheet
            open={visitOpen}
            customer={{
              id: run.id,
              name: customer.name,
              firstName: customer.firstName,
              suggestions: run.suggestions,
            }}
            sending={sending}
            error={sendError}
            onClose={() => setVisitOpen(false)}
            onSend={(reason) => void sendVisit(reason)}
          />
        </>
      )}
    </div>
  );
}
