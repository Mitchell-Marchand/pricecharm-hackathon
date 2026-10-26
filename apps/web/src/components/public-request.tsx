'use client';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, json, money } from '@/lib/api';
import type { PublicService, PublicSession, Quote, Service } from '@/lib/types';
import { Button, Field, Notice, TextArea } from './ui';
import styles from './public-request.module.css';
import SubmittedProject from './submitted-project';

function conversationQuantity(session: PublicSession, unitLabel?: string): number | undefined {
  if (!unitLabel?.trim()) return;
  const unit = unitLabel.trim();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const units = /^(?:square\s+(?:feet|foot)|sq\.?\s*ft\.?|sqft|ft²)$/i.test(unit)
    ? '(?:square\\s+(?:feet|foot)|sq\\.?\\s*ft\\.?|sqft|ft²)'
    : `${escape(unit.replace(/s$/i, ''))}s?`;
  const expression = new RegExp(
    `\\b(\\d+(?:,\\d{3})*(?:\\.\\d{1,3})?)\\s*(?:${units})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  const sourceGroups = [
    session.messages
      .filter((message) => message.role === 'user')
      .slice(-30)
      .map((message) => message.content),
    Object.values(session.collectedInputs || {}),
  ];
  for (const sources of sourceGroups) {
    let matches = 0;
    const quantities: number[] = [];
    for (const text of sources) {
      for (const match of text.matchAll(expression)) {
        matches += 1;
        const before = text.slice(Math.max(0, match.index! - 30), match.index);
        const after = text.slice(
          match.index! + match[0].length,
          match.index! + match[0].length + 30,
        );
        if (
          /[-\d.,–—]\s*$/.test(before) ||
          /(?:\d[\d,.]*\s*(?:by|[x×]))\s*$/i.test(before) ||
          /^\s*(?:by|[x×])\s*\d/i.test(after) ||
          /(?:[$€£]|\b(?:USD|CAD|GBP|EUR))\s*$/i.test(before)
        )
          continue;
        const value = Number(match[1].replaceAll(',', ''));
        if (value >= 0.001 && value <= 10_000_000) quantities.push(value);
      }
    }
    if (matches) return matches === 1 && quantities.length === 1 ? quantities[0] : undefined;
  }
}

const unknownAnswer = /^(?:unknown|not sure|not known|n\/a|not provided)$/i;
const fieldLabel = (field: string) =>
  field === 'location'
    ? 'City or area'
    : field
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^./, (letter) => letter.toUpperCase());
const displayFact = (value: string) =>
  value === 'true' ? 'Yes' : value === 'false' ? 'No' : value;

function summaryFacts(
  fields: string[],
  inputs: Record<string, string>,
  unsureFields: string[] = [],
) {
  const known = (field: string) => {
    const value = inputs[field]?.trim() || '';
    return !unsureFields.includes(field) && value && !unknownAnswer.test(value) ? value : '';
  };
  const knownFields = fields.filter((field) => known(field));
  return {
    known,
    rows: knownFields
      .filter(
        (field) =>
          field !== 'location' ||
          !knownFields.some(
            (other) =>
              other !== field &&
              /\blocation\b/i.test(fieldLabel(other)) &&
              known(other) === known(field),
          ),
      )
      .map((key) => ({ key, label: fieldLabel(key), value: known(key) })),
    unknownFields: fields.filter((field) => !known(field)),
  };
}

export type PublicQuoteSubmission = {
  customerName: string;
  customerEmail: string;
  quantity: number;
  quantityUnknown: boolean;
  description: string;
  inputs: Record<string, string>;
  contactConsent: boolean;
};

export function privateReviewSubmission(
  session: PublicSession,
  description: string,
): PublicQuoteSubmission | undefined {
  if (
    session.source !== 'playground' ||
    session.status !== 'active' ||
    session.quoteMode !== 'review' ||
    session.pricingQuantityRequired !== false ||
    !session.requiredInputs?.length ||
    description.trim().length < 3
  )
    return;
  const facts = summaryFacts(session.requiredInputs, session.collectedInputs || {});
  if (facts.unknownFields.length) return;
  return {
    customerName: 'Private test customer',
    customerEmail: 'preview@example.test',
    quantity: 1,
    quantityUnknown: true,
    description,
    inputs: Object.fromEntries(session.requiredInputs.map((field) => [field, facts.known(field)])),
    contactConsent: true,
  };
}

function coverageUsesUnit(field: string, value: string, unitLabel?: string) {
  if (!value.trim() || unknownAnswer.test(value.trim()) || !unitLabel?.trim()) return false;
  if (!/\bcoverage\b/i.test(fieldLabel(field))) return false;
  const unit = unitLabel
    .trim()
    .replace(/s$/i, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${unit}s?\\b`, 'i').test(`${fieldLabel(field)} ${value}`);
}
type RequestDraft = {
  name: string;
  email: string;
  description: string;
  inputs: Record<string, string>;
  unsureFields: string[];
  quantity: string;
  quantityUnknown: boolean;
  editedInputs: string[];
  descriptionEdited: boolean;
  quantityEdited: boolean;
};

export function PublicQuoteForm({
  service,
  previewPricing,
  session,
  base,
  token,
  privatePreview = false,
  draftKey,
  initialDescription,
  onCancel,
  onContactVerified,
  onSubmit,
}: {
  service?: PublicService;
  previewPricing?: Pick<
    Service,
    'unitPriceCents' | 'basePriceCents' | 'minimumChargeCents' | 'pricingRules'
  >;
  session: PublicSession;
  base: string;
  token: string;
  privatePreview?: boolean;
  draftKey?: string;
  initialDescription: string;
  onCancel: () => void;
  onContactVerified?: (email: string) => void;
  onSubmit: (data: PublicQuoteSubmission) => Promise<void>;
}) {
  const reviewMode =
    !privatePreview && (session.quoteMode || service?.mode || 'review') === 'review';
  const fields = useMemo(
    () => [
      ...new Set(
        session.requiredInputs || [
          'location',
          ...(service?.requiredInputs || []),
          ...(previewPricing?.pricingRules?.map((rule) => rule.field) || []),
        ],
      ),
    ],
    [service, previewPricing, session.requiredInputs],
  );
  const pricingQuantityRequired =
    session.pricingQuantityRequired ?? service?.pricingQuantityRequired;
  const unconfiguredReview =
    (session.quoteMode || service?.mode || 'review') === 'review' &&
    (pricingQuantityRequired === false ||
      (pricingQuantityRequired === undefined &&
        privatePreview &&
        previewPricing?.unitPriceCents === 0 &&
        previewPricing.basePriceCents === 0 &&
        previewPricing.minimumChargeCents === 0 &&
        !previewPricing.pricingRules?.some((rule) => rule.kind !== 'review' && rule.amount !== 0)));
  const hasInitialCoveragePreference =
    unconfiguredReview &&
    fields.some((field) =>
      coverageUsesUnit(field, session.collectedInputs?.[field] || '', service?.unitLabel),
    );
  const suggestedQuantity = hasInitialCoveragePreference
    ? undefined
    : conversationQuantity(session, service?.unitLabel);
  const defaults = (): RequestDraft => ({
    name: privatePreview ? 'Private test customer' : '',
    email: session.contact?.email || (privatePreview ? 'preview@example.test' : ''),
    description: initialDescription,
    inputs: Object.fromEntries(
      fields.map((field) => [field, session.collectedInputs?.[field] || '']),
    ),
    unsureFields: reviewMode
      ? fields.filter(
          (field) =>
            !session.collectedInputs?.[field]?.trim() ||
            unknownAnswer.test(session.collectedInputs[field].trim()),
        )
      : [],
    quantity: suggestedQuantity === undefined ? '' : String(suggestedQuantity),
    quantityUnknown:
      hasInitialCoveragePreference ||
      ((reviewMode || (privatePreview && unconfiguredReview)) && suggestedQuantity === undefined),
    editedInputs: [],
    descriptionEdited: false,
    quantityEdited: false,
  });
  const [draft, setDraft] = useState<RequestDraft>(defaults);
  const [loadedKey, setLoadedKey] = useState<string | undefined>();
  const [editorFields, setEditorFields] = useState<{
    key: string;
    required: string[];
    unanswered: string[];
    description: boolean;
  }>();
  const cleared = useRef(false);
  const [verifiedEmail, setVerifiedEmail] = useState(
    session.contact?.verified ? session.contact.email || '' : '',
  );
  const [verification, setVerification] = useState<{
    verificationId: string;
    delivery: string;
    devCode?: string;
  }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [editingFacts, setEditingFacts] = useState(false);
  const storageKey =
    draftKey ||
    `quotient:request-draft:${privatePreview ? 'private' : 'live'}:${session.id}:${service?.id || ''}:${service?.version || ''}`;

  useEffect(() => {
    cleared.current = false;
    const current = defaults();
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null');
      if (
        saved?.version === 1 &&
        saved.draft &&
        Date.now() - Number(saved.savedAt) < 7 * 24 * 60 * 60_000
      ) {
        const value = saved.draft;
        const text = (candidate: unknown, fallback: string, limit: number) =>
          typeof candidate === 'string' ? candidate.slice(0, limit) : fallback;
        current.name = text(value.name, current.name, 120);
        current.email = text(value.email, current.email, 254);
        current.descriptionEdited = value.descriptionEdited === true;
        if (current.descriptionEdited)
          current.description = text(value.description, current.description, 5000);
        current.quantityEdited = value.quantityEdited === true;
        if (current.quantityEdited) {
          current.quantity = text(value.quantity, current.quantity, 30);
          current.quantityUnknown =
            typeof value.quantityUnknown === 'boolean'
              ? value.quantityUnknown
              : current.quantityUnknown;
        }
        current.editedInputs = Array.isArray(value.editedInputs)
          ? value.editedInputs.filter(
              (field: unknown): field is string =>
                typeof field === 'string' && fields.includes(field),
            )
          : [];
        for (const field of current.editedInputs) {
          current.inputs[field] = text(value.inputs?.[field], current.inputs[field], 1000);
          current.unsureFields = current.unsureFields.filter((item) => item !== field);
          if (Array.isArray(value.unsureFields) && value.unsureFields.includes(field))
            current.unsureFields.push(field);
        }
      }
    } catch {
      /* The request remains usable if browser storage is unavailable. */
    }
    setDraft(current);
    setEditorFields({
      key: storageKey,
      required: fields,
      unanswered: summaryFacts(fields, current.inputs, current.unsureFields).unknownFields,
      description: !current.description.trim(),
    });
    setEditingFacts(false);
    setLoadedKey(storageKey);
    // Restore only this inquiry's editable details, never codes or consent.
  }, [storageKey]);

  useEffect(() => {
    if (
      loadedKey !== storageKey ||
      editorFields?.key !== storageKey ||
      JSON.stringify(editorFields.required) === JSON.stringify(fields)
    )
      return;
    setEditorFields((current) => {
      if (
        current?.key !== storageKey ||
        JSON.stringify(current.required) === JSON.stringify(fields)
      )
        return current;
      const required = new Set(fields);
      const previous = new Set(current.required);
      const unanswered = new Set(
        summaryFacts(fields, draft.inputs, draft.unsureFields).unknownFields,
      );
      return {
        ...current,
        required: fields,
        unanswered: [
          ...current.unanswered.filter((field) => required.has(field)),
          ...fields.filter((field) => !previous.has(field) && unanswered.has(field)),
        ],
      };
    });
  }, [fields, storageKey, loadedKey, editorFields, draft.inputs, draft.unsureFields]);

  useEffect(() => {
    if (loadedKey !== storageKey || cleared.current) return;
    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({ version: 1, savedAt: Date.now(), draft }),
      );
    } catch {
      /* Storage is optional. */
    }
  }, [draft, loadedKey, storageKey]);

  const email = draft.email;
  const verified =
    privatePreview ||
    (!!email &&
      (email.trim().toLowerCase() === verifiedEmail.trim().toLowerCase() ||
        (session.contact?.verified &&
          email.trim().toLowerCase() === session.contact.email?.trim().toLowerCase())));
  const headers = { Authorization: `Bearer ${token}` };
  const update = <Key extends keyof RequestDraft>(key: Key, value: RequestDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const { known, unknownFields } = summaryFacts(fields, draft.inputs, draft.unsureFields);
  const unansweredEditors = new Set(
    editorFields?.key === storageKey ? editorFields.unanswered : unknownFields,
  );
  const exposedFields =
    editingFacts || !reviewMode
      ? fields.filter((field) => editingFacts || unansweredEditors.has(field))
      : [];
  const descriptionNeeded =
    editorFields?.key === storageKey ? editorFields.description : !draft.description.trim();
  const inlineDescriptionEditor = reviewMode && descriptionNeeded;
  const { rows: summaryRows } = summaryFacts(
    fields.filter((field) => !exposedFields.includes(field)),
    draft.inputs,
    draft.unsureFields,
  );
  const coveragePreferenceOnly =
    unconfiguredReview &&
    !draft.quantityEdited &&
    fields.some((field) => coverageUsesUnit(field, known(field), service?.unitLabel));
  const quantityUnknown = coveragePreferenceOnly || draft.quantityUnknown;
  const unsure = (field: string, value: boolean) =>
    setDraft((current) => ({
      ...current,
      editedInputs: [...new Set([...current.editedInputs, field])],
      unsureFields: value
        ? [...new Set([...current.unsureFields, field])]
        : current.unsureFields.filter((item) => item !== field),
    }));
  async function requestCode() {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setCodeError('Enter a valid email address first.');
      return;
    }
    setBusy('code');
    setCodeError('');
    try {
      setVerification(
        await api(`${base}/sessions/${session.id}/verification`, {
          method: 'POST',
          headers,
          ...json({ email }),
        }),
      );
    } catch (error) {
      setCodeError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  async function verifyCode() {
    if (!verification) return;
    setBusy('verify');
    setCodeError('');
    try {
      const result = await api<{ email: string }>(`${base}/sessions/${session.id}/verify-contact`, {
        method: 'POST',
        headers,
        ...json({ verificationId: verification.verificationId, code }),
      });
      setVerifiedEmail(result.email);
      onContactVerified?.(result.email);
      setCode('');
    } catch (error) {
      setCodeError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('submit');
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (
        !quantityUnknown &&
        (!Number.isFinite(Number(draft.quantity)) ||
          Number(draft.quantity) < 0.001 ||
          Number(draft.quantity) > 10_000_000)
      ) {
        setEditingFacts(true);
        throw new Error('Add a quantity, or choose “I don’t know the quantity or measurement.”');
      }
      await onSubmit({
        customerName: draft.name,
        customerEmail: email,
        quantity: quantityUnknown ? 1 : Number(draft.quantity),
        quantityUnknown,
        description: draft.description,
        inputs: Object.fromEntries(fields.map((field) => [field, known(field) || 'unknown'])),
        contactConsent: privatePreview || form.get('contactConsent') === 'on',
      });
      cleared.current = true;
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  const verificationControls = (
    <>
      <p>
        {reviewMode
          ? 'Verify your email to receive updates and a private link to this request.'
          : 'Verify your email for an automatic quote. You can also send the request for owner review.'}
      </p>
      <Button
        type="button"
        variant="secondary"
        onClick={() => void requestCode()}
        loading={busy === 'code'}
        disabled={!!busy}
      >
        {verification ? 'Send a new code' : 'Send verification code'}
      </Button>
      {codeError && <Notice kind="error">{codeError}</Notice>}
      {verification && (
        <>
          <p>
            {verification.delivery === 'local'
              ? 'Local development email · no email was sent.'
              : `A code has been queued for ${email}. Check your inbox.`}
          </p>
          {verification.delivery === 'local' && verification.devCode && (
            <Notice>
              <strong>Development code: {verification.devCode}</strong>
              <br />
              This code is available only from the local email provider.
            </Notice>
          )}
          <Field
            label="Email verification code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void verifyCode()}
            loading={busy === 'verify'}
            disabled={!code.trim() || !!busy}
          >
            Verify email
          </Button>
        </>
      )}
    </>
  );
  const descriptionEditor = (
    <TextArea
      label="Project description"
      name="description"
      required
      value={draft.description}
      onChange={(event) =>
        setDraft((current) => ({
          ...current,
          description: event.target.value,
          descriptionEdited: true,
        }))
      }
      maxLength={5000}
      rows={2}
    />
  );
  return (
    <form className={`public-request-form ${styles.form}`} onSubmit={submit}>
      {!reviewMode && <h3>{privatePreview ? 'Check the project details' : 'Send your request'}</h3>}
      {!privatePreview && (
        <div className={styles.contacts}>
          <Field
            label="Your name"
            name="customerName"
            required
            autoComplete="name"
            maxLength={120}
            value={draft.name}
            onChange={(event) => update('name', event.target.value)}
          />
          <Field
            label="Email address"
            type="email"
            name="customerEmail"
            required
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(event) => {
              update('email', event.target.value);
              setVerification(undefined);
              setCode('');
              setCodeError('');
            }}
          />
        </div>
      )}
      <section className={styles.summary} aria-label="Your project summary">
        <h4>Your project</h4>
        {inlineDescriptionEditor ? (
          descriptionEditor
        ) : (
          <p className={styles.description}>
            {draft.description || 'Add a description of the work.'}
          </p>
        )}
        {summaryRows.length > 0 && (
          <dl>
            {summaryRows.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{displayFact(row.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {!coveragePreferenceOnly && (
          <p className={styles.measurement}>
            {quantityUnknown || !draft.quantity
              ? 'Measurement: the business will confirm.'
              : `${draft.quantity} ${service?.unitLabel || 'units'}`}
          </p>
        )}
        {reviewMode && unknownFields.length > 0 && (
          <p className={styles.missing}>
            The business can confirm: {unknownFields.map(fieldLabel).join(', ')}.
          </p>
        )}
        <button
          className="text-button"
          type="button"
          aria-expanded={editingFacts}
          onClick={() => {
            if (editingFacts)
              setEditorFields({
                key: storageKey,
                required: fields,
                unanswered: unknownFields,
                description: !draft.description.trim(),
              });
            setEditingFacts((value) => !value);
          }}
        >
          {editingFacts ? 'Done editing details' : 'Edit project details'}
        </button>
      </section>
      {(editingFacts || !reviewMode) && (
        <div className={styles.editor}>
          {exposedFields.length > 0 && (
            <fieldset className={styles.facts}>
              <legend>Project details</legend>
              {exposedFields.map((field) => (
                <div className={styles.fact} key={field}>
                  {!draft.unsureFields.includes(field) && (
                    <Field
                      label={fieldLabel(field)}
                      name={`fact-${fields.indexOf(field)}`}
                      value={draft.inputs[field] || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          inputs: { ...current.inputs, [field]: event.target.value },
                          editedInputs: [...new Set([...current.editedInputs, field])],
                        }))
                      }
                      required={!reviewMode}
                      maxLength={1000}
                      placeholder={
                        field === 'location' ? 'City or postal area' : 'Add what you know'
                      }
                    />
                  )}
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={draft.unsureFields.includes(field)}
                      onChange={(event) => unsure(field, event.target.checked)}
                    />
                    <span>I’m not sure about {fieldLabel(field).toLowerCase()}.</span>
                  </label>
                </div>
              ))}
            </fieldset>
          )}
          {!coveragePreferenceOnly && (
            <>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={draft.quantityUnknown}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      quantityUnknown: event.target.checked,
                      quantityEdited: true,
                    }))
                  }
                />
                <span>I don’t know the quantity or measurement.</span>
              </label>
              {!quantityUnknown && (
                <Field
                  label={`Approximate quantity (${service?.unitLabel || 'units'})`}
                  type="number"
                  name="quantity"
                  value={draft.quantity}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      quantity: event.target.value,
                      quantityEdited: true,
                    }))
                  }
                  min="0.001"
                  max="10000000"
                  step="0.001"
                  required
                  hint={
                    suggestedQuantity === undefined
                      ? 'If you’re unsure, the business can confirm it.'
                      : 'From your conversation. Check before submitting.'
                  }
                />
              )}
            </>
          )}
          {!inlineDescriptionEditor && (editingFacts || descriptionNeeded) && descriptionEditor}
        </div>
      )}
      {!privatePreview && (
        <>
          {verified ? (
            <p className="contact-verified" role="status">
              Email verified for this request.
            </p>
          ) : reviewMode ? (
            <details className={styles.updates}>
              <summary>
                Get email updates <span>(optional)</span>
              </summary>
              {verificationControls}
            </details>
          ) : (
            <div className={styles.verification}>{verificationControls}</div>
          )}
          <label className="checkbox-field">
            <input type="checkbox" name="contactConsent" required />
            <span>
              I agree to share these details and photos with the business for a quote and follow-up.
            </span>
          </label>
          <p className="request-legal-links">
            <a href="/terms" target="_blank" rel="noreferrer">
              Service terms
            </a>{' '}
            ·{' '}
            <a href="/privacy" target="_blank" rel="noreferrer">
              Privacy notice
            </a>
          </p>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={!!busy}>
          Back to chat
        </Button>
        <Button
          type="submit"
          loading={busy === 'submit'}
          disabled={!!busy || !draft.description.trim()}
        >
          {privatePreview ? 'Run this customer test' : 'Send request'}
        </Button>
      </div>
    </form>
  );
}

export function PublicQuoteResult({
  quote,
  session,
  photoCount = 0,
  reviewReason,
  privatePreview = false,
  onDecision,
}: {
  quote: Quote;
  session?: Pick<
    PublicSession,
    'collectedInputs' | 'requiredInputs' | 'quoteMode' | 'pricingQuantityRequired'
  >;
  photoCount?: number;
  reviewReason?: string;
  privatePreview?: boolean;
  onDecision: (decision: 'accepted' | 'declined') => Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pending = quote.status === 'review';
  const decided = quote.status === 'accepted' || quote.status === 'declined';
  const privateCalculation = privatePreview && !quote.manualPriceRequired && quote.totalCents > 0;
  const unconfiguredReview =
    privatePreview && session?.quoteMode === 'review' && session.pricingQuantityRequired === false;
  const facts = summaryFacts(
    [...new Set(session?.requiredInputs || Object.keys(session?.collectedInputs || {}))],
    session?.collectedInputs || {},
  );
  const showPrice = privatePreview ? privateCalculation : !pending;
  const assumptions = privatePreview
    ? quote.assumptions.filter(
        (assumption) =>
          assumption !== 'Private owner test. No customer notification or delivery fee.',
      )
    : quote.assumptions;
  async function decide(decision: 'accepted' | 'declined') {
    setBusy(decision);
    setError('');
    try {
      await onDecision(decision);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <article className={`public-quote-result ${pending ? 'pending' : ''}`}>
      <h3>
        {privatePreview
          ? 'Test result'
          : pending
            ? 'Request sent'
            : quote.status === 'accepted'
              ? 'Quote accepted'
              : quote.status === 'declined'
                ? 'Quote declined'
                : 'Your quote'}
      </h3>
      <p>
        {privatePreview
          ? privateCalculation
            ? 'Calculated from your saved prices.'
            : unconfiguredReview
              ? 'This request would come to you for review.'
              : 'This request needs your price or more project details. No price has been issued.'
          : pending
            ? 'The business will review your request and reply here.'
            : decided
              ? 'Your response has been recorded. The business can follow up with the next steps.'
              : 'Review the price, scope, and assumptions before accepting.'}
      </p>
      {showPrice && (
        <>
          <strong className="public-final-price">{money(quote.totalCents, quote.currency)}</strong>
          <div className="quote-lines">
            {quote.lineItems.map((item, index) => (
              <div key={index}>
                <span>{item.description}</span>
                <strong>{money(item.totalCents, quote.currency)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
      {privatePreview && (
        <section className={styles.receipt} aria-label="What you would receive">
          <h4>What you would receive</h4>
          {facts.rows.length > 0 && (
            <dl>
              {facts.rows.map((row) => (
                <div key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{displayFact(row.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {photoCount > 0 && (
            <p>
              {photoCount === 1
                ? '1 project photo attached.'
                : `${photoCount} project photos attached.`}
            </p>
          )}
          {facts.unknownFields.length > 0 && (
            <div className={styles.unknowns}>
              <h4>Still to confirm</h4>
              <ul>
                {facts.unknownFields.map((field) => (
                  <li key={field}>{fieldLabel(field)}</li>
                ))}
              </ul>
            </div>
          )}
          <details className={styles.customerWords}>
            <summary>Customer’s words</summary>
            <p>{quote.description}</p>
          </details>
        </section>
      )}
      {privatePreview && pending && (reviewReason || quote.reviewReason) && (
        <details className="private-test-handoff">
          <summary>What would need your review</summary>
          <p>
            {reviewReason || quote.reviewReason || 'This request would come to you for review.'}
          </p>
        </details>
      )}
      {!privatePreview && (
        <div className="public-request-summary">
          <span>{quote.customerName}</span>
          <span>{quote.customerEmail}</span>
          <SubmittedProject
            quote={quote}
            noteLabel="Your note"
            fallback={<small>{quote.description}</small>}
          />
        </div>
      )}
      {assumptions.length > 0 &&
        (!privatePreview || privateCalculation) &&
        (!pending || privatePreview) &&
        (privatePreview ? (
          <details className="quote-assumptions">
            <summary>Price assumptions</summary>
            {assumptions.map((assumption, index) => (
              <p key={index}>{assumption}</p>
            ))}
          </details>
        ) : (
          <div className="quote-assumptions">
            {assumptions.map((assumption, index) => (
              <p key={index}>{assumption}</p>
            ))}
          </div>
        ))}
      {!privatePreview && quote.status === 'issued' && (
        <div className="quote-decision-actions">
          <Button
            onClick={() => void decide('accepted')}
            loading={busy === 'accepted'}
            disabled={!!busy}
          >
            Accept quote
          </Button>
          <Button
            variant="secondary"
            onClick={() => void decide('declined')}
            loading={busy === 'declined'}
            disabled={!!busy}
          >
            Decline
          </Button>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {!privatePreview && (
        <small className="request-reference">
          Reference {quote.id.slice(0, 8).toUpperCase()} ·{' '}
          {pending ? 'Awaiting business reply' : quote.status}
        </small>
      )}
    </article>
  );
}
