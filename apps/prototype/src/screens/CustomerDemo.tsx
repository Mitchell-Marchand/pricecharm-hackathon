import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, Check, X } from 'lucide-react';
import { PHOTOS } from '../assets/photos';
import { PaperButton, QuoteForm } from '../components/QuoteForm';
import { CustomerMessage, Typing } from '../components/Chat';
import { Avatar, Button, TextInput } from '../components/ui';
import { learnedRate, previousAddOn } from '../lib/learn';
import { useStore } from '../lib/store';
import type { Quote } from '../lib/types';
import { cx, round5, uid } from '../lib/util';

type Step = 'service' | 'surface' | 'size' | 'photo' | 'treat' | 'contact' | 'code' | 'building' | 'quote' | 'accepted';
interface DemoMessage {
  id: string;
  from: 'bot' | 'me';
  text?: string;
  photos?: string[];
  quote?: boolean;
}

const PHOTO_FOR_DEMO = PHOTOS.planters;

const SIZES = [
  { label: 'Small, under 300 sq ft', sqft: 250 },
  { label: 'Medium, 300 to 700 sq ft', sqft: 500 },
  { label: 'Large, over 700 sq ft', sqft: 900 },
  { label: 'Not sure', sqft: 500 },
];

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((word) => /^[A-Za-z]/.test(word))
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join('') || 'Q'
  );
}

/** What a customer sees on the owner's link or website widget. Scripted with tappable answers. */
export function CustomerDemo({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="panel"
      aria-label="Customer preview"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && <DemoChat onClose={onClose} />}
    </dialog>
  );
}

function DemoChat({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const business = state.business.name || 'Your business';
  const services = state.business.services.length ? state.business.services.slice(0, 4) : ['Patios & pavers'];
  const [step, setStep] = useState<Step>('service');
  const [messages, setMessages] = useState<DemoMessage[]>([
    {
      id: 'hello',
      from: 'bot',
      text: `Hi! I'm the quote assistant for ${business}. I can put a price together for you in a couple of minutes. What do you need done?`,
    },
  ]);
  const [typing, setTyping] = useState(false);
  const [answers, setAnswers] = useState({ service: '', surface: '', sqft: 500, unsure: false, treat: false, photo: false });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, typing, step]);

  function botSays(text: string, nextStep: Step, delay = 900) {
    setTyping(true);
    timers.current.push(
      window.setTimeout(() => {
        setTyping(false);
        setMessages((current) => [...current, { id: uid('d'), from: 'bot', text }]);
        setStep(nextStep);
      }, delay),
    );
  }

  function say(text: string, photos?: string[]) {
    setMessages((current) => [...current, { id: uid('d'), from: 'me', text, photos }]);
  }

  function buildQuote() {
    const runs = state.runs.length;
    const rateCents = learnedRate(state, runs).cents;
    const lines = [
      {
        id: 'q1',
        label: `${answers.service}, about ${answers.sqft} sq ft`,
        amountCents: Math.max(round5(rateCents * answers.sqft), 15000),
      },
    ];
    if (answers.treat) {
      lines.push({
        id: 'q2',
        label: 'Stain pre-treatment',
        amountCents: previousAddOn(state, runs, /stain|pre-?treat|planter|detail/i) ?? 4000,
      });
    }
    const lastQuote = [...state.runs].reverse().find((run) => run.quote)?.quote;
    return {
      number: state.nextQuoteNumber,
      customer: name.trim() || 'You',
      place: state.business.area || 'Your area',
      lines,
      discount: null,
      start: lastQuote?.start || 'Next week',
      duration: lastQuote?.duration || '3 hours',
      included: lastQuote?.included.length ? lastQuote.included : ['Hot-water surface clean', 'Rinse of nearby walls'],
      excluded: answers.unsure ? ['Size confirmed on arrival', 'Sealing'] : ['Sealing'],
      validDays: lastQuote?.validDays ?? 14,
      note: '',
      issuedAt: new Date().toISOString(),
    } satisfies Quote;
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    if (code.replace(/\D/g, '').length !== 6) return;
    say('Code entered');
    setStep('building');
    setTyping(true);
    timers.current.push(
      window.setTimeout(() => {
        setTyping(false);
        setQuote(buildQuote());
        dispatch({ type: 'useQuoteNumber' });
        setMessages((current) => [
          ...current,
          { id: uid('d'), from: 'bot', text: `Here's your quote, ${name.trim().split(' ')[0] || 'there'}. A copy is on its way to your inbox.` },
          { id: uid('d'), from: 'bot', quote: true },
        ]);
        setStep('quote');
      }, 1600),
    );
  }

  const chips: { label: string; onPick: () => void }[] =
    step === 'service'
      ? services.map((service) => ({
          label: service,
          onPick: () => {
            say(service);
            setAnswers((current) => ({ ...current, service }));
            botSays('Got it. What is the surface?', 'surface');
          },
        }))
      : step === 'surface'
        ? ['Concrete', 'Pavers', 'Flagstone', 'Not sure'].map((surface) => ({
            label: surface,
            onPick: () => {
              say(surface);
              setAnswers((current) => ({ ...current, surface }));
              botSays('About how big is it? A rough guess is fine.', 'size');
            },
          }))
        : step === 'size'
          ? SIZES.map((size) => ({
              label: size.label,
              onPick: () => {
                say(size.label);
                setAnswers((current) => ({ ...current, sqft: size.sqft, unsure: size.label === 'Not sure' }));
                botSays('Could you send a photo or two? It helps me spot stains and damage.', 'photo');
              },
            }))
          : step === 'treat'
            ? [
                {
                  label: 'Yes, treat them',
                  onPick: () => {
                    say('Yes, treat them');
                    setAnswers((current) => ({ ...current, treat: true }));
                    botSays('Last thing: where should I send your quote?', 'contact');
                  },
                },
                {
                  label: 'No, just clean it',
                  onPick: () => {
                    say('No, just clean it');
                    botSays('Last thing: where should I send your quote?', 'contact');
                  },
                },
              ]
            : [];

  return (
    <div className="flex h-[min(760px,92dvh)] w-[min(440px,94vw)] flex-col overflow-hidden rounded-lg bg-surface shadow-2">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar initials={initials(business)} tone="ink" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{business}</p>
          <p className="text-xs text-muted">Usually quotes in about 2 minutes</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="inline-flex size-10 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-5" />
        </button>
      </header>
      <p className="bg-canary-soft px-4 py-2 text-xs text-ink">Preview of what your customers see. Nothing is sent.</p>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-4" aria-live="polite">
        {messages.map((message) => {
          if (message.quote && quote) {
            return (
              <div key={message.id} className="pr-3 pb-3">
                <QuoteForm
                  quote={quote}
                  business={business}
                  stamp={step === 'accepted' ? 'accepted' : undefined}
                  animate
                  footnote="Estimate based on the photos and details you shared."
                  actions={
                    step === 'accepted' ? undefined : (
                      <>
                        <PaperButton
                          primary
                          onClick={() => {
                            setStep('accepted');
                            botSays(`You're all set. ${business} will reach out within a day to schedule.`, 'accepted', 700);
                          }}
                        >
                          <Check aria-hidden /> Accept quote
                        </PaperButton>
                        <PaperButton>Ask a question</PaperButton>
                        <PaperButton>Request a site visit</PaperButton>
                      </>
                    )
                  }
                />
              </div>
            );
          }
          if (message.from === 'me') {
            return (
              <div key={message.id} className="fade-up flex justify-end">
                <div className={cx('max-w-[80%] rounded-[16px] rounded-br-[4px] bg-accent text-on-accent', message.photos ? 'p-1.5' : 'px-3.5 py-2.5')}>
                  {message.photos ? (
                    <img src={message.photos[0]} alt="Your photo" className="w-56 max-w-full rounded-[12px]" />
                  ) : (
                    <p className="text-[15px]">{message.text}</p>
                  )}
                </div>
              </div>
            );
          }
          return (
            <CustomerMessage key={message.id} name={business} initials={initials(business)} tone="blue" showAvatar={false}>
              {message.text}
            </CustomerMessage>
          );
        })}
        {typing && <Typing name={business} initials={initials(business)} tone="blue" />}
      </div>

      <footer className="border-t border-line bg-surface px-3 py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}>
        {chips.length > 0 && !typing && (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={chip.onPick}
                className="inline-flex min-h-10 items-center rounded-full border border-accent px-3.5 text-[15px] font-medium text-accent hover:bg-accent-soft"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {step === 'photo' && !typing && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                say('', [PHOTO_FOR_DEMO]);
                setAnswers((current) => ({ ...current, photo: true }));
                botSays('Thanks. I can see dark staining near the planters. Want those spots pre-treated?', 'treat', 1300);
              }}
            >
              <Camera aria-hidden /> Add a photo
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                say('Skip for now');
                botSays('No problem. Any dark stains you want pre-treated?', 'treat');
              }}
            >
              Skip
            </Button>
          </div>
        )}
        {step === 'contact' && !typing && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
              say(`${name.trim()}, ${email.trim()}`);
              botSays(`I sent a 6-digit code to ${email.trim()}. Enter it to see your quote.`, 'code', 800);
            }}
          >
            <label htmlFor="demo-name" className="sr-only">
              Your name
            </label>
            <TextInput id="demo-name" autoComplete="name" placeholder="Your name" value={name} onChange={(event) => setName(event.target.value)} />
            <label htmlFor="demo-email" className="sr-only">
              Your email
            </label>
            <TextInput
              id="demo-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" disabled={!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)}>
              Send me a code
            </Button>
          </form>
        )}
        {step === 'code' && !typing && (
          <form className="flex flex-col gap-2" onSubmit={verify}>
            <label htmlFor="demo-code" className="text-sm text-muted">
              Prototype: any 6 digits work.
            </label>
            <div className="flex gap-2">
              <TextInput
                id="demo-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                className="font-mono tracking-[0.3em]"
              />
              <Button type="submit" disabled={code.length !== 6}>
                See my quote
              </Button>
            </div>
          </form>
        )}
        {(step === 'building' || typing) && <p className="py-2 text-sm text-muted">{step === 'building' ? 'Putting your quote together…' : ' '}</p>}
        {(step === 'quote' || step === 'accepted') && !typing && (
          <p className="py-2 text-sm text-muted">
            {step === 'accepted' ? 'Accepted. The business has been told.' : 'Tap Accept quote, or ask a question.'}
          </p>
        )}
      </footer>
    </div>
  );
}

