import { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, ExternalLink, Mail, MessageSquareText, Receipt, ShieldCheck, Smartphone } from 'lucide-react';
import { Logo } from '../components/Logo';
import { PrototypeMenu } from '../components/PrototypeMenu';
import { QRCode } from '../components/QRCode';
import { useToast } from '../components/Toast';
import { Button, Field, Segmented, TextInput } from '../components/ui';
import { useStore } from '../lib/store';
import { cx, slugify } from '../lib/util';
import { CustomerDemo } from './CustomerDemo';

const GUIDES: { id: string; name: string; steps: string[] }[] = [
  { id: 'wordpress', name: 'WordPress', steps: ['Open the page in the editor.', 'Add a Custom HTML block.', 'Paste the code, then Update.'] },
  { id: 'squarespace', name: 'Squarespace', steps: ['Edit the page.', 'Add a Code block where you want it.', 'Paste the code, then Save.'] },
  { id: 'wix', name: 'Wix', steps: ['Click Add, then Embed Code.', 'Choose Embed HTML.', 'Paste the code, then Publish.'] },
  { id: 'webflow', name: 'Webflow', steps: ['Drag an Embed element onto the page.', 'Paste the code.', 'Save, then Publish.'] },
  {
    id: 'shopify',
    name: 'Shopify',
    steps: ['Go to Online Store, then Themes, then Customize.', 'Add a Custom Liquid section.', 'Paste the code, then Save.'],
  },
  { id: 'godaddy', name: 'GoDaddy', steps: ['Edit your site and add a section.', 'Choose HTML.', 'Paste the code, then Publish.'] },
];

function domainOf(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
}

function useCopy() {
  const notify = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = (key: string, text: string) => {
    const blocked = () => notify('Copy is blocked here. Select the text and copy it yourself.');
    if (!navigator.clipboard) {
      blocked();
      return;
    }
    navigator.clipboard.writeText(text).then(() => setCopied(key), blocked);
  };
  return { copied, copy };
}

export function Live() {
  const { state, dispatch } = useStore();
  const notify = useToast();
  const { copied, copy } = useCopy();
  const [demo, setDemo] = useState(false);
  const [guide, setGuide] = useState(GUIDES[0].id);
  const [helperEmail, setHelperEmail] = useState('');
  const [ended, setEnded] = useState(false);
  const business = state.business.name || 'Your business';
  const slug = slugify(business);
  const link = `pricecharm.com/q/${slug}`;
  const domain = domainOf(state.live.website);
  const style = state.live.style;
  const code =
    style === 'floating'
      ? `<script src="https://get.pricecharm.com/widget.js"\n  data-business="${slug}" async></script>`
      : `<div data-pricecharm="${slug}"></div>\n<script src="https://get.pricecharm.com/widget.js" async></script>`;
  const owner = state.account?.name.split(' ')[0] ?? 'there';
  const email = state.account?.email ?? 'your email';

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo />
        <PrototypeMenu />
      </header>

      <main className="gutter mx-auto max-w-5xl pt-4 pb-20">
        {!state.live.verified && (
          <div className="mb-8 flex flex-col gap-3 rounded-md border border-line bg-canary-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex gap-2.5 text-[15px]">
              <Mail className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>
                We sent a link to <span className="font-semibold">{email}</span>. Verify within 48 hours to keep your quote link
                live.
              </span>
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => notify('Prototype: no email was sent.')}>
                Resend
              </Button>
              <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'live', patch: { verified: true } })}>
                Prototype: mark verified
              </Button>
            </div>
          </div>
        )}

        <p className="inline-flex items-center gap-2 font-semibold text-go">
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-go text-surface">
            <Check className="size-4" aria-hidden />
          </span>
          You're all set, {owner}
        </p>
        <h1 className="t-hero mt-4">You're live.</h1>
        <p className="mt-5 max-w-xl text-lg text-ink-2">
          Customers can get quotes from {business} right now. Share your link, add it to your website, or both.
        </p>

        <section className="mt-12 grid gap-8 rounded-md border border-line bg-surface p-5 sm:p-7 md:grid-cols-[minmax(0,1fr)_200px]" aria-labelledby="link-title">
          <div className="min-w-0">
            <h2 id="link-title" className="t-h2">
              Your quote link
            </h2>
            <p className="mt-2 text-ink-2">Put it in your email signature, texts, Google Business Profile and social bios.</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <p className="flex h-12 min-w-0 flex-1 items-center rounded-sm border border-line-strong bg-surface-2 px-3.5 font-mono text-[15px] select-all">
                <span className="truncate">{link}</span>
              </p>
              <Button size="lg" onClick={() => copy('link', `https://${link}`)}>
                {copied === 'link' ? <Check aria-hidden /> : <Copy aria-hidden />} {copied === 'link' ? 'Copied' : 'Copy link'}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDemo(true)}>
                <ExternalLink aria-hidden /> Open it as a customer
              </Button>
              <Button variant="ghost" onClick={() => notify('Prototype: this would text the link to your phone.')}>
                <Smartphone aria-hidden /> Text it to me
              </Button>
            </div>
          </div>
          <div className="flex flex-col items-start gap-2 md:items-center">
            <div className="w-36 rounded-sm border border-line bg-[var(--paper)] p-2 md:w-full">
              <QRCode text={`PriceCharm prototype: quote link for ${business}`} label={`QR code for the ${business} quote link`} />
            </div>
            <p className="text-sm text-muted">For trucks, flyers and yard signs</p>
          </div>
        </section>

        <section className="mt-6 rounded-md border border-line bg-surface p-5 sm:p-7" aria-labelledby="widget-title">
          <h2 id="widget-title" className="t-h2">
            Add it to your website
          </h2>
          <p className="mt-2 text-ink-2">Pick a style, copy the code, and paste it into your site. It works on any website builder.</p>

          <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <Field
                label="What's your website?"
                htmlFor="live-website"
                hint={
                  domain ? (
                    <span className="inline-flex items-start gap-1.5">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-go" aria-hidden />
                      Only {domain} and www.{domain} can show your widget.
                    </span>
                  ) : (
                    'Only your site will be allowed to show your widget.'
                  )
                }
              >
                <TextInput
                  id="live-website"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="mossandstone.com"
                  value={state.live.website}
                  onChange={(event) => dispatch({ type: 'live', patch: { website: event.target.value } })}
                />
              </Field>
              <div>
                <p className="text-sm font-semibold">Style</p>
                <div className="mt-2">
                  <Segmented
                    label="Widget style"
                    value={style}
                    onChange={(value) => dispatch({ type: 'live', patch: { style: value } })}
                    options={[
                      { value: 'floating', label: 'Floating button' },
                      { value: 'inline', label: 'Section on a page' },
                    ]}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">Your code</p>
                  <Button variant="ghost" size="sm" onClick={() => copy('code', code)}>
                    {copied === 'code' ? <Check aria-hidden /> : <Copy aria-hidden />} {copied === 'code' ? 'Copied' : 'Copy code'}
                  </Button>
                </div>
                <pre className="mt-2 rounded-sm bg-ink p-4 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-on-ink select-all">
                  <code>{code}</code>
                </pre>
              </div>
            </div>

            <div className="min-w-0">
              <p className="text-sm font-semibold">Preview</p>
              <div className="mt-2 overflow-hidden rounded-md border border-line bg-surface-2" aria-label="Preview of your website with the widget">
                <div className="flex items-center gap-1.5 border-b border-line bg-surface px-3 py-2" aria-hidden>
                  <span className="size-2.5 rounded-full bg-line-strong" />
                  <span className="size-2.5 rounded-full bg-line-strong" />
                  <span className="size-2.5 rounded-full bg-line-strong" />
                  <span className="ml-2 truncate rounded-xs bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted">
                    {domain || 'yourwebsite.com'}
                  </span>
                </div>
                <div className="relative h-64 p-4" aria-hidden>
                  <p className="font-display text-lg font-[760] [font-stretch:106%]">{business}</p>
                  <div className="mt-3 flex flex-col gap-2">
                    <span className="h-2 w-4/5 rounded-full bg-line" />
                    <span className="h-2 w-3/5 rounded-full bg-line" />
                  </div>
                  {style === 'inline' ? (
                    <div className="mt-5 rounded-sm border border-line bg-surface p-3 shadow-1">
                      <p className="text-sm font-semibold">Get a quote in about 2 minutes</p>
                      <p className="mt-1 text-xs text-muted">Tell us about the job and add a photo.</p>
                      <span className="mt-3 inline-flex h-8 items-center rounded-xs bg-ink px-3 text-xs font-semibold text-on-ink">
                        Start my quote
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="mt-5 flex flex-col gap-2">
                        <span className="h-2 w-full rounded-full bg-line" />
                        <span className="h-2 w-2/3 rounded-full bg-line" />
                      </div>
                      <span className="absolute right-4 bottom-4 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-on-ink shadow-2">
                        <Receipt className="size-4" /> Get a quote
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-line pt-6">
            <p className="text-sm font-semibold">Step-by-step for your website builder</p>
            <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Website builders">
              {GUIDES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={guide === item.id}
                  onClick={() => setGuide(item.id)}
                  className={cx(
                    'h-9 rounded-full border px-3.5 text-sm font-medium',
                    guide === item.id ? 'border-ink bg-ink text-on-ink' : 'border-line-strong text-ink-2 hover:text-ink',
                  )}
                >
                  {item.name}
                </button>
              ))}
            </div>
            <ol role="tabpanel" className="mt-4 flex flex-col gap-2 text-ink-2">
              {GUIDES.find((item) => item.id === guide)?.steps.map((step, position) => (
                <li key={step} className="flex gap-3">
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-xs text-ink">
                    {position + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            <form
              className="mt-6 flex max-w-lg flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(helperEmail)) return;
                notify('Prototype: no email was sent.');
                setHelperEmail('');
              }}
            >
              <div className="min-w-0 flex-1">
                <Field label="Someone else runs your website?" htmlFor="helper-email">
                  <TextInput
                    id="helper-email"
                    type="email"
                    placeholder="their@email.com"
                    value={helperEmail}
                    onChange={(event) => setHelperEmail(event.target.value)}
                  />
                </Field>
              </div>
              <Button type="submit" variant="secondary" size="lg" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(helperEmail)}>
                Send them the steps
              </Button>
            </form>
          </div>
        </section>

        <section className="mt-12 grid gap-8 md:grid-cols-3" aria-label="What happens next">
          {[
            { icon: Mail, title: 'Every quote lands in your inbox', text: 'You get an email each time a customer receives a quote.' },
            {
              icon: MessageSquareText,
              title: 'Unusual jobs wait for you',
              text: 'Anything outside your usual range comes to you first. One tap to approve.',
            },
            { icon: Receipt, title: 'Your first 10 quotes are free', text: 'After that you pay a small fee per quote a customer receives.' },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon className="size-6 text-accent" aria-hidden />
              <h3 className="t-h3 mt-3">{title}</h3>
              <p className="mt-1.5 text-ink-2">{text}</p>
            </div>
          ))}
        </section>

        <div className="mt-12 flex justify-end border-t border-line pt-8">
          <Button size="lg" onClick={() => setEnded(true)}>
            Go to your dashboard <ArrowRight aria-hidden />
          </Button>
        </div>
        {ended && (
          <div className="fade-up mt-6 rounded-md border border-line bg-surface p-5 sm:p-6" role="status">
            <h2 className="t-h2">That's the end of this prototype.</h2>
            <p className="mt-2 text-ink-2">The dashboard (quotes, training and settings) is the next thing to design.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  dispatch({ type: 'reset' });
                  window.scrollTo({ top: 0 });
                }}
              >
                Start over
              </Button>
              <Button variant="ghost" onClick={() => setEnded(false)}>
                Stay here
              </Button>
            </div>
          </div>
        )}
      </main>
      <CustomerDemo open={demo} onClose={() => setDemo(false)} />
    </div>
  );
}
