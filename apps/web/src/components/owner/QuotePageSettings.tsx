'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { BusinessMark } from '@/components/Chat';
import { PaperButton } from '@/components/QuoteForm';
import { useToast } from '@/components/Toast';
import { Button, Chip, Field, Segmented, TextArea, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import {
  loadQuotePage,
  removeLogo,
  saveQuotePage,
  uploadLogo,
  type QuotePage,
  type QuotePageText,
} from '@/lib/owner';

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z0-9]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

/** “Looks good to me”, “Works for me” and “Let’s do it” */
const listed = (items: string[]) =>
  items
    .map((item) => `“${item}”`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');

/** The text boxes as the owner sees them: a message left to the default shows the default. */
function drafts(page: QuotePage) {
  return {
    contactName: page.contactName,
    acceptedMessage: page.acceptedMessage || page.defaults.acceptedMessage,
    visitMessage: page.visitMessage || page.defaults.visitMessage,
    acceptLabel: page.acceptLabel,
  };
}

/**
 * What customers see on the quote link and the website button: the logo, who they hear from, what
 * the chat says after a yes or a visit request, the words on the accept button, and whether they
 * see the price before leaving their details.
 */
export function QuotePageSettings({ business }: { business: string }) {
  const notify = useToast();
  const [page, setPage] = useState<QuotePage | null>(null);
  const [text, setText] = useState<QuotePageText | null>(null);
  const [ownWords, setOwnWords] = useState(false);
  const [unavailable, setUnavailable] = useState('');
  const [logoError, setLogoError] = useState('');
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const show = (next: QuotePage) => {
    setPage(next);
    setText(drafts(next));
  };
  useEffect(() => {
    loadQuotePage()
      .then((loaded) => {
        show(loaded);
        setOwnWords(Boolean(loaded.acceptLabel));
      })
      .catch((loadError) =>
        setUnavailable(
          // An API older than this page, as when web and API deploy a moment apart.
          loadError instanceof ApiError && loadError.status === 404
            ? 'This needs the latest PriceCharm. Refresh the page in a minute.'
            : errorMessage(loadError),
        ),
      );
  }, []);

  if (unavailable) return <p className="text-sm text-muted">{unavailable}</p>;
  if (!page || !text) return <div className="shimmer h-40 rounded-md" />;

  const save = (
    patch: Partial<QuotePageText> & { contactFirst?: boolean; afterPreview?: boolean },
    saved: (next: QuotePage) => string,
  ) =>
    saveQuotePage(patch)
      .then((next) => {
        show(next);
        notify(saved(next));
      })
      .catch((saveError) => {
        setText(drafts(page));
        notify(errorMessage(saveError));
      });
  const name = page.contactName || page.ownerFirstName || business;

  // A message saved as the default follows the name, so the default is sent as empty.
  const saveMessage = (field: 'acceptedMessage' | 'visitMessage', saved: string) => {
    const value = text[field].trim();
    const stored = value === page.defaults[field] ? '' : value;
    if (stored === page[field]) return setText(drafts(page));
    save({ [field]: stored }, () => saved);
  };

  const pickLogo = async (file: File) => {
    setLogoError('');
    setUploading(true);
    try {
      show(await uploadLogo(file));
      notify('Your logo is on your chat and your quotes.');
    } catch (uploadError) {
      setLogoError(errorMessage(uploadError));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <Field
        label="Logo"
        htmlFor="page-logo"
        error={logoError}
        hint="Shows at the top of your chat and on every quote. A PNG, JPG or WebP file."
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-0 items-center gap-3 rounded-md border border-line bg-surface px-4 py-3">
            <BusinessMark initials={initialsOf(business)} logo={page.logo} />
            <div className="min-w-0">
              <p className="truncate font-semibold">{business}</p>
              <p className="text-xs text-muted">Usually quotes in about 2 minutes</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={uploading}
              onClick={() => picker.current?.click()}
            >
              {uploading ? 'Uploading…' : page.logo ? 'Replace' : 'Add your logo'}
            </Button>
            {page.logo && (
              <Button
                variant="ghost"
                disabled={uploading}
                onClick={() =>
                  removeLogo()
                    .then((next) => {
                      show(next);
                      notify('Logo removed. Customers see your initials.');
                    })
                    .catch((removeError) => setLogoError(errorMessage(removeError)))
                }
              >
                Remove
              </Button>
            )}
          </div>
          <input
            ref={picker}
            id="page-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void pickLogo(file);
            }}
          />
        </div>
      </Field>

      <Field
        label="Name customers see"
        htmlFor="page-contact"
        optional
        hint={`Who the chat says will follow up. Leave it empty for ${page.ownerFirstName || 'your first name'}.`}
      >
        <TextInput
          id="page-contact"
          className="max-w-72"
          maxLength={40}
          autoComplete="off"
          placeholder={page.ownerFirstName}
          value={text.contactName}
          onChange={(event) => setText({ ...text, contactName: event.target.value })}
          onBlur={() => {
            const value = text.contactName.trim();
            if (value === page.contactName) return;
            save({ contactName: value }, (next) =>
              next.contactName
                ? `Saved. Customers hear from ${next.contactName}.`
                : `Saved. Customers hear from ${next.ownerFirstName || business}.`,
            );
          }}
        />
      </Field>

      <MessageField
        id="page-accepted"
        label="After a customer accepts"
        value={text.acceptedMessage}
        custom={Boolean(page.acceptedMessage)}
        example={`Say what happens next and when, like “${name === page.ownerFirstName ? 'I’ll' : `${name} will`} text you today to pick a day.”`}
        onChange={(value) => setText({ ...text, acceptedMessage: value })}
        onSave={() =>
          saveMessage('acceptedMessage', 'Saved. Customers see this after they accept.')
        }
        onReset={() =>
          save({ acceptedMessage: '' }, () => 'Back to the usual line after a customer accepts.')
        }
      />
      <MessageField
        id="page-visit"
        label="After they ask for a visit"
        value={text.visitMessage}
        custom={Boolean(page.visitMessage)}
        example="Say when you’ll be in touch to set a time."
        onChange={(value) => setText({ ...text, visitMessage: value })}
        onSave={() =>
          saveMessage('visitMessage', 'Saved. Customers see this after they ask for a visit.')
        }
        onReset={() =>
          save({ visitMessage: '' }, () => 'Back to the usual line after a visit request.')
        }
      />

      <Field
        label="The button customers tap to say yes"
        htmlFor="page-button-choice"
        hint={
          ownWords
            ? 'Keep it a clear yes. Tapping it is how customers accept.'
            : `PriceCharm tries ${listed(page.wordings)} with customers, and leans toward the ones they say yes to most.`
        }
      >
        <div id="page-button-choice">
          <Segmented
            label="The button customers tap to say yes"
            value={ownWords ? 'own' : 'auto'}
            onChange={(value) => {
              setOwnWords(value === 'own');
              if (value === 'auto' && page.acceptLabel)
                save({ acceptLabel: '' }, () => 'Saved. PriceCharm picks the words.');
            }}
            options={[
              { value: 'auto', label: 'Let PriceCharm pick' },
              { value: 'own', label: 'Choose my own' },
            ]}
          />
        </div>
        {ownWords && (
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {page.wordings.map((wording) => (
                <Chip
                  key={wording}
                  selected={page.acceptLabel === wording}
                  onClick={() =>
                    save({ acceptLabel: wording }, () => `Saved. The button says “${wording}”.`)
                  }
                >
                  {wording}
                </Chip>
              ))}
            </div>
            <TextInput
              aria-label="Your own words for the button"
              className="max-w-72"
              maxLength={24}
              autoComplete="off"
              placeholder="Or type your own"
              value={text.acceptLabel}
              onChange={(event) => setText({ ...text, acceptLabel: event.target.value })}
              onBlur={() => {
                const value = text.acceptLabel.trim();
                if (!value || value === page.acceptLabel) return;
                save({ acceptLabel: value }, () => `Saved. The button says “${value}”.`);
              }}
            />
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">On a quote:</span>
              <PaperButton primary sample>
                <Check aria-hidden /> {text.acceptLabel.trim() || page.wordings[0]}
              </PaperButton>
            </div>
          </div>
        )}
      </Field>

      <Field
        label="When customers see the price"
        htmlFor="page-contact-first"
        hint={
          page.contactFirst
            ? 'They give a name and a phone number or email before the price shows. Fewer people get that far, but you hear from everyone who does.'
            : 'Straight away. They leave a phone number or email when they say yes, ask for a visit or want a copy. More people get to a price this way.'
        }
      >
        <div id="page-contact-first">
          <Segmented
            label="When customers see the price"
            value={page.contactFirst ? 'contact' : 'price'}
            onChange={(value) =>
              save({ contactFirst: value === 'contact' }, (next) =>
                next.contactFirst
                  ? 'Saved. Customers leave their details before the price shows.'
                  : 'Saved. Customers see their price straight away.',
              )
            }
            options={[
              { value: 'price', label: 'Show the price first' },
              { value: 'contact', label: 'Ask for contact first' },
            ]}
          />
        </div>
      </Field>

      {page.afterPreview !== undefined && (
        <Field
          label="After picture on quotes"
          htmlFor="page-after-preview"
          hint={
            page.afterPreview
              ? 'Quotes show the customer’s photo next to a picture of the job done, made with AI from that photo.'
              : 'Quotes show the price and the details, without a picture of the job done.'
          }
        >
          <div id="page-after-preview">
            <Segmented
              label="After picture on quotes"
              value={page.afterPreview ? 'on' : 'off'}
              onChange={(value) =>
                save({ afterPreview: value === 'on' }, (next) =>
                  next.afterPreview
                    ? 'Saved. Quotes show an after picture when the customer sent a photo or video.'
                    : 'Saved. Quotes don’t show an after picture.',
                )
              }
              options={[
                { value: 'on', label: 'Show it' },
                { value: 'off', label: 'Don’t show it' },
              ]}
            />
          </div>
        </Field>
      )}
    </div>
  );
}

function MessageField({
  id,
  label,
  value,
  custom,
  example,
  onChange,
  onSave,
  onReset,
}: {
  id: string;
  label: string;
  value: string;
  /** The owner wrote their own, rather than keeping the usual line. */
  custom: boolean;
  example: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        custom ? (
          <button
            type="button"
            onClick={onReset}
            className="text-accent underline underline-offset-4"
          >
            Use the usual line
          </button>
        ) : (
          example
        )
      }
    >
      <TextArea
        id={id}
        rows={2}
        maxLength={280}
        className="min-h-0"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
      />
    </Field>
  );
}
