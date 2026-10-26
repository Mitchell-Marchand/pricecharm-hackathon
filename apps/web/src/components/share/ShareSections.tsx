'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Receipt, ShieldCheck } from 'lucide-react';
import { QRCode } from '@/components/QRCode';
import { useToast } from '@/components/Toast';
import { Button, Field, Segmented, TextInput } from '@/components/ui';
import { saveShare, sendInstructions, type Share } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { cx } from '@/lib/util';

const GUIDES: { id: string; name: string; steps: string[] }[] = [
  {
    id: 'wordpress',
    name: 'WordPress',
    steps: [
      'Open the page in the editor.',
      'Add a Custom HTML block.',
      'Paste the code, then Update.',
    ],
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    steps: ['Edit the page.', 'Add a Code block where you want it.', 'Paste the code, then Save.'],
  },
  {
    id: 'wix',
    name: 'Wix',
    steps: ['Click Add, then Embed Code.', 'Choose Embed HTML.', 'Paste the code, then Publish.'],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    steps: ['Drag an Embed element onto the page.', 'Paste the code.', 'Save, then Publish.'],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    steps: [
      'Go to Online Store, then Themes, then Customize.',
      'Add a Custom Liquid section.',
      'Paste the code, then Save.',
    ],
  },
  {
    id: 'godaddy',
    name: 'GoDaddy',
    steps: ['Edit your site and add a section.', 'Choose HTML.', 'Paste the code, then Publish.'],
  },
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

/** The quote link with its QR code, and the website widget with its code and setup steps. */
export function ShareSections({
  business,
  share,
  onChange: setShare,
}: {
  business: string;
  share: Share;
  onChange: (share: Share) => void;
}) {
  const notify = useToast();
  const { copied, copy } = useCopy();
  const [website, setWebsite] = useState(share.websiteDomain);
  const [websiteError, setWebsiteError] = useState('');
  const [guide, setGuide] = useState(GUIDES[0].id);
  const [helperEmail, setHelperEmail] = useState('');
  const [sendingSteps, setSendingSteps] = useState(false);
  const websiteTimer = useRef<number | undefined>(undefined);
  const domain = domainOf(website);
  const style = share.widgetStyle;
  const link = share.url.replace(/^https?:\/\//, '');

  const persistWebsite = (value: string) => {
    window.clearTimeout(websiteTimer.current);
    if (domainOf(value) === share.websiteDomain) return;
    saveShare({ website: value })
      .then(setShare)
      .catch((error) => setWebsiteError(errorMessage(error)));
  };
  const updateWebsite = (value: string) => {
    setWebsite(value);
    setWebsiteError('');
    window.clearTimeout(websiteTimer.current);
    websiteTimer.current = window.setTimeout(() => persistWebsite(value), 600);
  };

  return (
    <>
      <section
        className="grid gap-8 rounded-md border border-line bg-surface p-5 sm:p-7 md:grid-cols-[minmax(0,1fr)_200px]"
        aria-labelledby="link-title"
      >
        <div className="min-w-0">
          <h2 id="link-title" className="t-h2">
            Your quote link
          </h2>
          <p className="mt-2 text-ink-2">
            Put it in your email signature, texts, Google Business Profile and social bios.
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <p className="flex h-12 min-w-0 flex-1 items-center rounded-sm border border-line-strong bg-surface-2 px-3.5 font-mono text-[15px] select-all">
              <span className="truncate">{link}</span>
            </p>
            <Button size="lg" onClick={() => copy('link', share.url)}>
              {copied === 'link' ? <Check aria-hidden /> : <Copy aria-hidden />}{' '}
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={`/q/${share.slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-sm border border-line-strong bg-surface px-4 text-[15px] font-semibold text-ink hover:border-ink/40 [&_svg]:size-[1.1em]"
            >
              <ExternalLink aria-hidden /> Open it as a customer
            </a>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-center">
          <div className="w-36 rounded-sm border border-line bg-[var(--paper)] p-2 md:w-full">
            <QRCode text={share.url} label={`QR code for the ${business} quote link`} />
          </div>
          <p className="text-sm text-muted">For trucks, flyers and yard signs</p>
        </div>
      </section>

      <section
        className="mt-6 rounded-md border border-line bg-surface p-5 sm:p-7"
        aria-labelledby="widget-title"
      >
        <h2 id="widget-title" className="t-h2">
          Add it to your website
        </h2>
        <p className="mt-2 text-ink-2">
          Pick a style, copy the code, and paste it into your site. It works on any website builder.
        </p>

        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            <Field
              label="What's your website?"
              htmlFor="live-website"
              error={websiteError || undefined}
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
                value={website}
                onChange={(event) => updateWebsite(event.target.value)}
                onBlur={(event) => persistWebsite(event.target.value)}
              />
            </Field>
            <div>
              <p className="text-sm font-semibold">Style</p>
              <div className="mt-2">
                <Segmented
                  label="Widget style"
                  value={style}
                  onChange={(value) => {
                    setShare({ ...share, widgetStyle: value });
                    saveShare({ widgetStyle: value })
                      .then(setShare)
                      .catch((error) => notify(errorMessage(error)));
                  }}
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
                <Button variant="ghost" size="sm" onClick={() => copy('code', share.embedCode)}>
                  {copied === 'code' ? <Check aria-hidden /> : <Copy aria-hidden />}{' '}
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </Button>
              </div>
              <pre className="mt-2 rounded-sm bg-ink p-4 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-on-ink select-all">
                <code>{share.embedCode}</code>
              </pre>
            </div>
          </div>

          <div className="min-w-0">
            <p className="text-sm font-semibold">Preview</p>
            <div
              className="mt-2 overflow-hidden rounded-md border border-line bg-surface-2"
              aria-label="Preview of your website with the widget"
            >
              <div
                className="flex items-center gap-1.5 border-b border-line bg-surface px-3 py-2"
                aria-hidden
              >
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
                    <p className="mt-1 text-xs text-muted">
                      Tell us about the job and add a photo.
                    </p>
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
                  guide === item.id
                    ? 'border-ink bg-ink text-on-ink'
                    : 'border-line-strong text-ink-2 hover:text-ink',
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
              const email = helperEmail.trim();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || sendingSteps) return;
              setSendingSteps(true);
              sendInstructions(email)
                .then(() => {
                  notify(`Sent the steps to ${email}.`);
                  setHelperEmail('');
                })
                .catch((error) => notify(errorMessage(error)))
                .finally(() => setSendingSteps(false));
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
            <Button
              type="submit"
              variant="secondary"
              size="lg"
              disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(helperEmail.trim()) || sendingSteps}
            >
              {sendingSteps ? 'Sending…' : 'Send them the steps'}
            </Button>
          </form>
        </div>
      </section>
    </>
  );
}
