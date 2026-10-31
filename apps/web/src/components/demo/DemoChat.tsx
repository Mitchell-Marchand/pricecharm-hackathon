'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Camera, Check, RotateCcw } from 'lucide-react';
import { CustomerMessage, Typing } from '@/components/Chat';
import { PhotoGrid } from '@/components/Photos';
import { PaperButton, QuoteForm } from '@/components/QuoteForm';
import { Avatar, Tag, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { greeting } from '@/lib/chat';
import { requestDemoQuote, requestDemoTurn, startDemoChat, type DemoMessage } from '@/lib/demo-api';
import { demoQuote, type Demo, type DemoExtra, type DemoOption } from '@/lib/demos';
import { useHumanCheck } from '@/lib/human-check';
import type { Quote } from '@/lib/quote';
import { TRADE_DATA_BY_ID } from '@/lib/trades';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { cx, uid } from '@/lib/util';

/** The API's limits, so the visitor sees them before the server has to say no. */
const MAX_TEXT = 300;
const MAX_MESSAGES = 10;
/** The answers the page adds when the assistant asks for photos. */
const SEND_PHOTOS = 'Send sample photos';
const SKIP_PHOTOS = 'Skip photos';

interface Line {
  id: string;
  from: 'bot' | 'me' | 'note';
  text?: string;
  /** Sample photo keys the visitor sent. */
  photos?: string[];
  quote?: boolean;
}

const photoUrl = (key: string) => `/demo-photos/${key}.jpg`;
/** The scripted version's steps, used when the live demo is busy or unavailable. */
type Step = 'service' | 'size' | 'photo' | 'extra' | 'contact';

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

/**
 * What a customer sees on a business's quote link, with a sample business. The visitor types or
 * taps answers; the live demo's assistant replies and quotes from the sample prices on the
 * server. If the live demo is busy, it carries on as a short scripted version instead.
 * Nothing the visitor types is saved, and there are no uploads: where the sample business has
 * photos of the job, the visitor can send those instead.
 */
export function DemoChat({ demo, className }: { demo: Demo; className?: string }) {
  const services = TRADE_DATA_BY_ID[demo.tradeId]?.services ?? Object.keys(demo.prices);
  const initials = initialsOf(demo.business) || 'Q';
  // The bot check loads only when the visitor first sends something, not for every page view.
  const human = useHumanCheck('demo', false);
  const scroller = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const { toBottom: stickToBottom, showTop } = useStickToBottom(scroller);
  const timers = useRef<number[]>([]);
  const pass = useRef('');

  const [lines, setLines] = useState<Line[]>(() => [
    { id: 'hello', from: 'bot', text: greeting(demo.business, demo.owner) },
  ]);
  const [mode, setMode] = useState<'live' | 'scripted'>('live');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [chips, setChips] = useState<string[]>(services);
  const [ready, setReady] = useState(false);
  const [serviceName, setServiceName] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [done, setDone] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // The scripted version's place and answers.
  const [step, setStep] = useState<Step>('service');
  const [answers, setAnswers] = useState<{
    service?: string;
    size?: DemoOption;
    extra?: DemoExtra;
  }>({});

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  // Like the real chat, the quote follows as soon as it has the details.
  useEffect(() => {
    if (ready && !busy && !quote && !done) void seeQuote();
  });

  // A quote is taller than the chat, so it opens at its top, where the price is, not its buttons.
  useLayoutEffect(() => {
    if (quote && card.current) showTop(card.current);
  }, [quote, showTop]);

  const add = (line: Omit<Line, 'id'>) =>
    setLines((current) => [...current, { id: uid('d'), ...line }]);
  const later = (task: () => void, delay: number) => {
    setBusy(true);
    timers.current.push(
      window.setTimeout(() => {
        setBusy(false);
        task();
      }, delay),
    );
  };
  const asked = lines.filter((line) => line.from === 'me').length;
  const full = asked >= MAX_MESSAGES && !quote;
  const samplePhotos = demo.photos?.items.map((photo) => photo.key) ?? [];
  /** The answers to a request for photos: the sample photos, where they fit the job. */
  const photoChips = (service: string) =>
    demo.photos?.services.includes(service) ? [SEND_PHOTOS, SKIP_PHOTOS] : [];

  /** The chat so far, as the API reads it. */
  function transcript(next?: Pick<Line, 'text' | 'photos'>): DemoMessage[] {
    return [...lines, ...(next ? [{ ...next, from: 'me' as const }] : [])]
      .filter((line) => line.text && (line.from === 'bot' || line.from === 'me'))
      .map((line) => ({
        from: line.from === 'me' ? ('customer' as const) : ('assistant' as const),
        text: line.text!.slice(0, 600),
        ...(line.photos?.length ? { photos: line.photos } : {}),
      }));
  }

  /** The live demo can't go on: say why, and carry on with the scripted version. */
  function fallBack(error: unknown, text: string) {
    if (error instanceof ApiError && ['DEMO_PASS', 'DEMO_CHAT_LIMIT'].includes(error.code)) {
      add({ from: 'note', text: error.message });
      setChips([]);
      setDone(true);
      return;
    }
    if (error instanceof ApiError && error.status === 400) {
      add({ from: 'note', text: 'Keep it to a short message and try again.' });
      return;
    }
    add({ from: 'note', text: 'The live demo is busy right now, so here’s the quick version.' });
    setMode('scripted');
    setStep('service');
    setChips(services);
    // Carry on from what they already picked, when it was one of the services.
    if (services.some((name) => name.toLowerCase() === text.toLowerCase())) sendScripted(text);
  }

  async function sendLive(text: string, photos?: string[]) {
    setBusy(true);
    try {
      if (!pass.current) pass.current = (await startDemoChat(await human.headers())).pass;
      const turn = await requestDemoTurn({
        tradeId: demo.tradeId,
        pass: pass.current,
        serviceName,
        messages: transcript({ text, photos }),
      });
      add({ from: 'bot', text: turn.reply });
      setServiceName(turn.serviceName);
      setReady(turn.ready);
      setChips(
        turn.ready
          ? []
          : turn.askPhoto
            ? [...turn.chips, ...photoChips(turn.serviceName)]
            : turn.chips,
      );
      setBusy(false);
    } catch (error) {
      // Cleared first, so a scripted reply that follows can show its own typing dots.
      setBusy(false);
      fallBack(error, text);
    }
  }

  /** The scripted version: the same questions, answered by tapping. */
  function sendScripted(text: string, photos?: string[]) {
    const pick = <T extends { label: string }>(options: T[]) =>
      options.find((option) => option.label.toLowerCase() === text.toLowerCase());
    const toContact = () =>
      later(() => {
        add({
          from: 'bot',
          text: 'Thanks, that’s everything I need. Putting your quote together now.',
        });
        setStep('contact');
        setChips([]);
        setReady(true);
      }, 700);
    const askExtra = (before = '') => {
      if (!demo.extra) return toContact();
      later(() => {
        add({ from: 'bot', text: `${before}${demo.extra!.ask}` });
        setStep('extra');
        setChips(demo.extra!.options.map((option) => option.label));
      }, 700);
    };
    if (step === 'service') {
      const service = services.find((name) => name.toLowerCase() === text.toLowerCase());
      if (!service) return add({ from: 'note', text: 'Tap one of the answers below.' });
      setAnswers({ service });
      later(() => {
        add({ from: 'bot', text: demo.size.ask });
        setStep('size');
        setChips(demo.size.options.map((option) => option.label));
      }, 700);
    } else if (step === 'size') {
      const size = pick(demo.size.options);
      if (!size) return add({ from: 'note', text: 'Tap one of the answers below.' });
      setAnswers((current) => ({ ...current, size }));
      // Only where there are sample photos of this kind of job to send.
      if (!photoChips(answers.service ?? '').length) return askExtra();
      later(() => {
        add({ from: 'bot', text: 'Could you send a photo or two? It helps price it right.' });
        setStep('photo');
        setChips(photoChips(answers.service ?? ''));
      }, 700);
    } else if (step === 'photo') {
      const shown =
        photos?.length && demo.photos?.shows
          ? demo.extra?.options.find((option) => option.label === demo.photos?.shows?.answer)
          : undefined;
      if (!shown) return askExtra(photos?.length ? 'Thanks, those help. ' : '');
      // The photos already answer the last question.
      setAnswers((current) => ({ ...current, extra: shown }));
      later(() => {
        add({ from: 'bot', text: demo.photos!.shows!.reply });
        toContact();
      }, 900);
    } else if (step === 'extra') {
      const extra = pick(demo.extra?.options ?? []);
      if (!extra) return add({ from: 'note', text: 'Tap one of the answers below.' });
      setAnswers((current) => ({ ...current, extra }));
      toContact();
    }
  }

  function send(text: string, photos?: string[]) {
    const trimmed = text.trim().slice(0, MAX_TEXT);
    if (!trimmed || busy || full || done) return;
    setDraft('');
    add({ from: 'me', text: trimmed, photos });
    stickToBottom();
    if (quote) {
      // After the quote, a real customer's messages go to the owner, not the assistant.
      later(
        () =>
          add({
            from: 'bot',
            text: `In the real chat, this goes straight to ${demo.owner}, who replies by email.`,
          }),
        600,
      );
      return;
    }
    setChips([]);
    if (mode === 'live') void sendLive(trimmed, photos);
    else sendScripted(trimmed, photos);
  }

  function answerChip(chip: string) {
    if (chip === SEND_PHOTOS) send('Here are a couple of photos.', samplePhotos);
    else send(chip);
  }

  async function seeQuote() {
    if (busy) return;
    setReady(false);
    stickToBottom();
    setBusy(true);
    let card: Quote | null = null;
    let visit: string | null = null;
    if (mode === 'live') {
      try {
        const result = await requestDemoQuote({
          tradeId: demo.tradeId,
          pass: pass.current,
          serviceName,
          // Up to the customer's last answer, which is where the API reads from.
          messages: (() => {
            const said = transcript();
            return said.slice(0, said.map((line) => line.from).lastIndexOf('customer') + 1);
          })(),
        });
        card = result.quote;
        visit = result.visit;
      } catch {
        // Quote from the sample prices here instead.
      }
    }
    if (!card && !visit) {
      const service =
        answers.service ?? (services.includes(serviceName) ? serviceName : services[0]);
      const size =
        answers.size ??
        demo.size.options.find((option) => option.factor === 1) ??
        demo.size.options[0];
      card = demoQuote(demo, { service, size, extra: answers.extra });
    }
    later(() => {
      if (card) {
        setQuote(card);
        add({ from: 'bot', text: 'Here’s your quote.' });
        add({ from: 'bot', quote: true });
      } else {
        add({
          from: 'bot',
          text: `${demo.owner} would want to see this one in person first (${visit}). In the real chat, they’d get in touch to set up a visit.`,
        });
        setDone(true);
      }
    }, 900);
  }

  function restart() {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    pass.current = '';
    setLines([{ id: uid('d'), from: 'bot', text: greeting(demo.business, demo.owner) }]);
    setMode('live');
    setBusy(false);
    setDraft('');
    setChips(services);
    setReady(false);
    setServiceName('');
    setQuote(null);
    setDone(false);
    setAccepted(false);
    setStep('service');
    setAnswers({});
  }

  const decide = (text: string, finish: boolean) => {
    stickToBottom();
    later(() => {
      add({ from: 'bot', text });
      if (finish) setDone(true);
    }, 600);
  };

  return (
    <div
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-2',
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar initials={initials} tone="ink" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{demo.business}</p>
          <p className="text-xs text-muted">Usually quotes in about 2 minutes</p>
        </div>
        <Tag>Demo</Tag>
      </header>
      <p className="bg-canary-soft px-4 py-2 text-xs text-ink">
        [DEMO] Your Charm will actually chat and quote like you would.
      </p>

      {/* No overscroll containment: past the end of the chat, the page keeps scrolling. */}
      <div ref={scroller} className="chat-scroll min-h-0 flex-1 px-3 py-4" aria-live="polite">
        {/* What visitors type in the demo isn't kept, so recordings mask it too. */}
        <div className="flex flex-col gap-3" data-private>
          {lines.map((line) => {
            if (line.quote && quote)
              return (
                <div key={line.id} ref={card} className="pr-3 pb-3">
                  <QuoteForm
                    quote={quote}
                    business={demo.business}
                    stamp={accepted ? 'accepted' : undefined}
                    animate
                    footnote="Demo quote with sample prices, not an offer from a real business."
                    actions={
                      done ? undefined : (
                        <>
                          <PaperButton
                            primary
                            onClick={() => {
                              setAccepted(true);
                              decide(
                                `You’re all set. ${demo.owner} will be in touch to schedule.`,
                                true,
                              );
                            }}
                          >
                            <Check aria-hidden /> Looks good to me
                          </PaperButton>
                          <p className="basis-full text-center text-[13px] text-paper-muted">
                            No payment now. {demo.owner} will reach out to book a time.
                          </p>
                          <PaperButton
                            onClick={() => {
                              document
                                .getElementById(`demo-message-${demo.tradeId}`)
                                ?.focus({ preventScroll: true });
                            }}
                          >
                            Ask a question
                          </PaperButton>
                          <PaperButton
                            onClick={() =>
                              decide(
                                `Got it. ${demo.owner} will get in touch to set up a visit.`,
                                true,
                              )
                            }
                          >
                            Request a site visit
                          </PaperButton>
                        </>
                      )
                    }
                  />
                </div>
              );
            if (line.from === 'note')
              return (
                <p key={line.id} className="fade-up py-1 text-center text-sm text-muted">
                  {line.text}
                </p>
              );
            if (line.from === 'me')
              return (
                <div key={line.id} className="fade-up flex justify-end">
                  <Mine photos={line.photos?.map(photoUrl)}>{line.text}</Mine>
                </div>
              );
            return (
              <CustomerMessage
                key={line.id}
                name={demo.business}
                initials={initials}
                tone="blue"
                showAvatar={false}
              >
                {line.text}
              </CustomerMessage>
            );
          })}
          {busy && <Typing name={demo.business} initials={initials} tone="blue" />}
        </div>
      </div>

      <footer className="flex flex-col gap-2 border-t border-line bg-surface px-3 py-3">
        {human.slow && <p className="text-sm text-muted">Running a quick security check…</p>}
        <div ref={human.slot} />
        {chips.length > 0 && !busy && !done && !quote && (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => answerChip(chip)}
                className="inline-flex min-h-10 items-center rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent-soft"
              >
                {chip}
              </button>
            ))}
          </div>
        )}
        {full && !done && (
          <p className="text-xs text-muted">
            That’s as far as a demo chat goes. Start over to try again.
          </p>
        )}
        {!done && !full && !(mode === 'scripted' && !quote) && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              send(draft);
            }}
          >
            {/* Uploads are off in the demo. It stays focusable, so the tooltip shows on tab and tap too. */}
            <span className="group relative shrink-0">
              <button
                type="button"
                aria-disabled="true"
                aria-label="Add a photo"
                aria-describedby={`demo-uploads-${demo.tradeId}`}
                onClick={(event) => event.preventDefault()}
                className="inline-flex size-11 items-center justify-center rounded-full text-ink-2 opacity-40"
              >
                <Camera className="size-5" />
              </button>
              <span
                id={`demo-uploads-${demo.tradeId}`}
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-0 mb-2 w-max rounded-sm bg-ink px-2.5 py-1.5 text-xs font-medium text-on-ink opacity-0 shadow-2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
              >
                File uploads disabled for demo
              </span>
            </span>
            <label htmlFor={`demo-message-${demo.tradeId}`} className="sr-only">
              Message
            </label>
            <TextInput
              id={`demo-message-${demo.tradeId}`}
              autoComplete="off"
              enterKeyHint="send"
              maxLength={MAX_TEXT}
              placeholder={quote ? `Ask ${demo.owner} a question` : 'Type your answer'}
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
        {(done || quote || full || mode === 'scripted') && (
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-1.5 self-start text-sm text-accent underline underline-offset-4"
          >
            <RotateCcw className="size-4" aria-hidden /> Start over
          </button>
        )}
      </footer>
    </div>
  );
}

function Mine({ children, photos }: { children: ReactNode; photos?: string[] }) {
  return (
    <div
      className={cx(
        'rounded-[16px] rounded-br-[4px] bg-accent text-on-accent',
        photos?.length ? 'w-full max-w-[340px] p-1.5' : 'max-w-[80%] px-3.5 py-2.5',
      )}
    >
      {photos?.length ? <PhotoGrid photos={photos} label="Sample photos" /> : null}
      <p
        className={cx('text-[15px] whitespace-pre-line', photos?.length ? 'px-2 pt-1.5 pb-1' : '')}
      >
        {children}
      </p>
    </div>
  );
}
