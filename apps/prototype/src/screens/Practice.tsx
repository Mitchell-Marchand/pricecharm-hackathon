import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, CalendarCheck, Info, Pencil, Receipt } from 'lucide-react';
import { CustomerMessage, OwnerMessage, SiteVisitMessage, Typing } from '../components/Chat';
import { QuoteForm } from '../components/QuoteForm';
import { WizardHeader } from '../components/Wizard';
import { Avatar, Button, Tag, TextInput } from '../components/ui';
import { PRACTICE_COUNT, SCENARIOS_BY_ID, type Scenario } from '../data/scenarios';
import { tradeName } from '../data/trades';
import { practiceReply, typingDelay } from '../lib/bot';
import { gapPercent, total } from '../lib/learn';
import { useStore } from '../lib/store';
import type { Quote, Run } from '../lib/types';
import { cx, money, scrollToBottom, uid } from '../lib/util';
import { QuoteBuilder, SiteVisitSheet } from './QuoteBuilder';

type QuoteDraft = Omit<Quote, 'number' | 'issuedAt'>;

function PracticeProgress({ index, finished }: { index: number; finished: number }) {
  return (
    <div className="gutter mx-auto flex max-w-[760px] items-center gap-4 pb-3">
      <p className="shrink-0 text-sm font-semibold">
        Practice quote {Math.min(index + 1, PRACTICE_COUNT)} of {PRACTICE_COUNT}
      </p>
      <div
        className="flex flex-1 gap-1.5"
        role="progressbar"
        aria-label="Practice quotes finished"
        aria-valuemin={0}
        aria-valuemax={PRACTICE_COUNT}
        aria-valuenow={finished}
      >
        {Array.from({ length: PRACTICE_COUNT }, (_, slot) => (
          <span key={slot} className={cx('relative h-2 flex-1 overflow-hidden rounded-full', slot === index ? 'bg-line-strong' : 'bg-line')}>
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

function ShadowBar({ label, cents, max, tone }: { label: string; cents: number; max: number; tone: 'accent' | 'ink' }) {
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

function InsightCard({ run, index, scenario }: { run: Run; index: number; scenario: Scenario }) {
  const { dispatch } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const ownerCents = run.quote ? total(run.quote) : 0;
  const guess = run.shadowCents ?? 0;
  const gap = run.outcome === 'quote' ? gapPercent(guess, ownerCents) : null;
  const max = Math.max(guess, ownerCents) * 1.08 || 1;
  return (
    <section className="fade-up rounded-md border border-line bg-surface p-5 shadow-1 sm:p-6" aria-labelledby={`insight-${index}`}>
      <p className="t-label text-muted">Only you see this</p>
      <h2 id={`insight-${index}`} className="t-h2 mt-2">
        Here's what your AI picked up
      </h2>

      {run.outcome === 'quote' && (
        <div className="mt-5 flex flex-col gap-3">
          <ShadowBar label="Its guess" cents={guess} max={max} tone="accent" />
          <ShadowBar label="Your quote" cents={ownerCents} max={max} tone="ink" />
          <p className="text-[15px] text-ink-2">
            Before you sent yours, it guessed {money(guess)}.{' '}
            <span className="font-semibold text-ink">{gap}% apart.</span>{' '}
            {gap !== null && gap <= 15 ? "That's close. It's learning your pricing." : "It'll get closer with each practice quote."}
            {run.shadowFlag && ` It would also have asked to see this one first, because of the ${scenario.siteVisitCue}.`}
          </p>
        </div>
      )}
      {run.outcome === 'site-visit' && (
        <p className="mt-4 text-[15px] text-ink-2">
          {run.shadowFlag ? (
            <>
              <span className="font-semibold text-ink">Your AI would have asked to see this one too.</span> It spotted the{' '}
              {scenario.siteVisitCue} in the photos and messages.
            </>
          ) : (
            <>
              It would have quoted {money(guess)}. Now it knows to check with you on jobs like this.
            </>
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
                  if (value.trim()) dispatch({ type: 'editInsight', run: index, id: item.id, text: value.trim() });
                  setEditing(null);
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

export function Practice() {
  const { state, dispatch } = useStore();
  const index = state.current;
  const run = state.runs[index];
  const scenario = SCENARIOS_BY_ID[run.scenarioId];
  const business = state.business.name || 'Your business';
  const finishedCount = state.runs.filter((item) => item.finished).length;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [visitOpen, setVisitOpen] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [nudge, setNudge] = useState(false);
  const timers = useRef<number[]>([]);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const otherTrade = state.business.tradeId !== 'pressure-washing';

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const later = (task: () => void, ms: number) => {
    timers.current.push(window.setTimeout(task, ms));
  };

  // The practice customer sends their request. Later requests were prepared in the background, so they open fast.
  useEffect(() => {
    if (run.messages.length) return;
    setTyping(true);
    const id = window.setTimeout(
      () => {
        setTyping(false);
        dispatch({
          type: 'message',
          run: index,
          message: { id: uid('m'), from: 'customer', text: scenario.opener, photos: [...scenario.photos] },
        });
      },
      index === 0 ? 1500 : 500,
    );
    return () => {
      window.clearTimeout(id);
      setTyping(false);
    };
  }, [index, run.messages.length, dispatch, scenario]);

  useEffect(() => {
    if (run.messages.length > 1 || typing) scrollToBottom();
  }, [run.messages.length, typing, run.finished]);

  const busy = typing || Boolean(run.outcome);

  function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    if (replyBox.current) replyBox.current.style.height = '';
    dispatch({ type: 'message', run: index, message: { id: uid('m'), from: 'owner', text } });
    const turn = run.messages.filter((message) => message.from === 'owner').length;
    const reply = practiceReply(scenario, text, { photoSent: run.photoSent, turn });
    setTyping(true);
    later(
      () => {
        setTyping(false);
        dispatch({
          type: 'message',
          run: index,
          message: { id: uid('m'), from: 'customer', text: reply.text, photos: reply.photos },
          asked: reply.asked,
          photoSent: reply.sentPhoto,
        });
        if (reply.nudgeQuote) setNudge(true);
      },
      typingDelay(reply.text) + (reply.photos ? 700 : 0),
    );
  }

  function finishWithReply(text: string, delay: number) {
    later(() => setTyping(true), delay);
    later(() => {
      setTyping(false);
      dispatch({ type: 'message', run: index, message: { id: uid('m'), from: 'customer', text } });
    }, delay + typingDelay(text));
    later(() => dispatch({ type: 'finishRun', run: index }), delay + typingDelay(text) + 600);
  }

  function sendQuote(quote: QuoteDraft) {
    setBuilderOpen(false);
    setNudge(false);
    setFresh(true);
    dispatch({ type: 'sendQuote', run: index, quote });
    finishWithReply(scenario.acceptReply, 1600);
  }

  function askForVisit(reason: string) {
    setVisitOpen(false);
    dispatch({ type: 'siteVisit', run: index, reason });
    finishWithReply(scenario.siteVisitReply, 500);
  }

  function next() {
    setFresh(false);
    setNudge(false);
    setDraft('');
    if (index < state.runs.length - 1) {
      dispatch({ type: 'nextRun' });
      window.scrollTo({ top: 0 });
    } else {
      dispatch({ type: 'go', screen: 'ready' });
    }
  }

  function onReplyKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const lastQuoteId = [...run.messages].reverse().find((message) => message.quote)?.id;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={3}>
        <PracticeProgress index={index} finished={finishedCount} />
      </WizardHeader>

      <main className="gutter mx-auto w-full max-w-[760px] flex-1 pt-8 pb-10">
        {index === 0 && run.messages.length <= 1 && (
          <div className="mb-8">
            <button
              type="button"
              onClick={() => dispatch({ type: 'go', screen: 'jobs' })}
              className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
            >
              <ArrowLeft className="size-4" aria-hidden /> Past jobs
            </button>
            <h1 className="t-h1 mt-4">Answer it like a real lead.</h1>
            <p className="mt-3 text-lg text-ink-2">
              Ask what you'd normally ask, then send a quote. Your AI learns from how you handle it.
            </p>
          </div>
        )}

        {otherTrade && (
          <p className="mb-6 flex gap-2.5 rounded-sm bg-accent-soft px-3.5 py-3 text-sm text-ink">
            <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            This prototype only has pressure washing customers. The real version writes practice requests for{' '}
            {tradeName(state.business.tradeId, state.business.customTrade).toLowerCase()}.
          </p>
        )}

        <div className="flex items-center gap-3 border-b border-line pb-4">
          <Avatar initials={scenario.initials} tone={scenario.tone} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {scenario.customer} · {scenario.place}
            </p>
            <p className="text-sm text-muted">Pretend customer. Nothing you send here goes anywhere.</p>
          </div>
          <Tag tone="accent">Practice</Tag>
        </div>

        <div className="mt-6 flex flex-col gap-4" aria-live="polite">
          {run.messages.map((message, position) => {
            if (message.quote) {
              return (
                <div key={message.id} className="ml-auto w-full max-w-[480px] pr-3 pb-3">
                  <QuoteForm
                    quote={message.quote}
                    business={business}
                    stamp="practice"
                    animate={fresh && message.id === lastQuoteId}
                    footnote="Practice quote. Nothing was sent."
                  />
                </div>
              );
            }
            if (message.siteVisit) return <SiteVisitMessage key={message.id} reason={message.siteVisit} />;
            if (message.from === 'owner') return <OwnerMessage key={message.id}>{message.text}</OwnerMessage>;
            const previous = run.messages[position + 1];
            return (
              <CustomerMessage
                key={message.id}
                name={scenario.customer}
                initials={scenario.initials}
                tone={scenario.tone}
                photos={message.photos}
                showAvatar={!previous || previous.from !== 'customer'}
              >
                {message.text}
              </CustomerMessage>
            );
          })}
          {typing && <Typing name={scenario.firstName} initials={scenario.initials} tone={scenario.tone} />}
          {run.finished && <InsightCard run={run} index={index} scenario={scenario} />}
        </div>
      </main>

      <div
        className="sticky bottom-0 z-30 border-t border-line bg-bg/92 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="gutter mx-auto max-w-[760px] py-3">
          {run.finished ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {index < PRACTICE_COUNT - 1
                  ? `${PRACTICE_COUNT - finishedCount} to go. The next one is ready.`
                  : 'All three done.'}
              </p>
              <Button size="lg" onClick={next}>
                {index < PRACTICE_COUNT - 1 ? 'Next practice request' : 'See what your AI learned'}{' '}
                <ArrowRight aria-hidden />
              </Button>
            </div>
          ) : run.outcome ? (
            <p className="py-3 text-sm text-muted" role="status">
              {run.outcome === 'quote' ? `Quote sent to ${scenario.firstName}.` : `Asked ${scenario.firstName} for a visit.`}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 pb-2.5">
                <Button
                  variant="quote"
                  onClick={() => setBuilderOpen(true)}
                  disabled={!run.messages.length}
                  className={cx(nudge && 'pulse')}
                >
                  <Receipt aria-hidden /> Create quote
                </Button>
                <Button variant="ghost" onClick={() => setVisitOpen(true)} disabled={!run.messages.length}>
                  <CalendarCheck aria-hidden /> <span className="sm:hidden">Visit first</span>
                  <span className="hidden sm:inline">I'd need to see it first</span>
                </Button>
              </div>
              <form onSubmit={send} className="flex items-end gap-2">
                <label htmlFor="practice-reply" className="sr-only">
                  Reply to {scenario.firstName}
                </label>
                <textarea
                  id="practice-reply"
                  ref={replyBox}
                  rows={1}
                  value={draft}
                  placeholder={`Ask ${scenario.firstName} a question…`}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    event.target.style.height = 'auto';
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
                  }}
                  onKeyDown={onReplyKey}
                  className="max-h-36 min-h-12 min-w-0 flex-1 resize-none rounded-sm border border-line-strong bg-surface px-3.5 py-3 text-base leading-6 text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
                />
                <Button type="submit" aria-label="Send" disabled={!draft.trim() || busy} className="size-12 px-0">
                  <ArrowUp aria-hidden />
                </Button>
              </form>
            </>
          )}
        </div>
      </div>

      <QuoteBuilder open={builderOpen} scenario={scenario} onClose={() => setBuilderOpen(false)} onSend={sendQuote} />
      <SiteVisitSheet open={visitOpen} scenario={scenario} onClose={() => setVisitOpen(false)} onSend={askForVisit} />
    </div>
  );
}
