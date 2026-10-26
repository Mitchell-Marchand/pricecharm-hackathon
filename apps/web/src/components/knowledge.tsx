'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, FileText, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api, cents, errorMessage, json, money } from '@/lib/api';
import type { ImportDraft, ImportReceipt, PricingRule, Service } from '@/lib/types';
import ImportReview from './import-review';
import { Badge, Button, Field, Modal, Notice, Select, TextArea } from './ui';

type Proposal = {
  id: string;
  serviceId: string;
  serviceVersion: number;
  status: string;
  sourceExampleIds: string[];
  proposal: {
    unitLabel?: string | null;
    unitPriceCents: number;
    basePriceCents: number;
    minimumChargeCents: number;
    requiredInputs: string[];
    exclusions: string[];
    pricingRules: PricingRule[];
    explanation: string;
    uncertainties: string[];
  };
  createdAt: string;
};

export function DocumentImport({
  services,
  onClose,
  onSaved,
}: {
  services: Service[];
  onClose: () => void;
  onSaved: (count: number, receipt?: ImportReceipt) => Promise<void>;
}) {
  const draftKey = `quotient:document-draft:${services[0]?.businessId || 'owner'}:${services
    .map((service) => service.id)
    .sort()
    .join(',')}`;
  const [draft, setDraft] = useState<ImportDraft>();
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  function remember(id?: string) {
    try {
      if (id) sessionStorage.setItem(draftKey, id);
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* Drafts also remain available on the server. */
    }
  }
  async function open(id: string) {
    setBusy('open');
    setError('');
    try {
      const result = await api<{ draft: ImportDraft }>(`/imports/${id}`);
      setDraft(result.draft);
      remember(id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  useEffect(() => {
    let active = true;
    api<{ drafts: ImportDraft[] }>('/imports')
      .then((result) => {
        if (active) setDrafts(result.drafts.filter((item) => item.status === 'pending'));
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    try {
      const remembered = sessionStorage.getItem(draftKey);
      if (remembered) void open(remembered);
    } catch {
      /* Storage is optional. */
    }
    return () => {
      active = false;
    };
  }, [draftKey]);
  async function extract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      file = form.get('file') as File;
    if (file.size > 4 * 1024 * 1024) {
      setError('Choose a document smaller than 4 MB.');
      return;
    }
    setBusy('extract');
    setError('');
    try {
      const result = await api<{ draft: ImportDraft }>('/imports/document', {
        method: 'POST',
        body: form,
      });
      setDraft(result.draft);
      remember(result.draft.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <Modal
      title={draft ? 'Review jobs and notes' : 'Import past jobs'}
      subtitle={
        draft
          ? 'Keep what you know. Missing details can stay unknown.'
          : 'Upload a quote, invoice, note or photo. Review the details before saving.'
      }
      onClose={onClose}
    >
      {draft ? (
        <ImportReview
          key={draft.id}
          draft={draft}
          onSaved={async (count, receipt) => {
            await onSaved(count, receipt);
            remember();
          }}
          onChooseAnother={() => {
            remember();
            setDraft(undefined);
          }}
        />
      ) : (
        <>
          {busy === 'open' && (
            <p className="quiet-loading" role="status">
              Opening your saved draft…
            </p>
          )}
          <form onSubmit={extract}>
            <Select label="Service" name="serviceId" required>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </Select>
            <label className="field">
              <span>Project document</span>
              <input
                name="file"
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,text/plain,.txt"
                required
              />
              <small>
                PDF, JPEG, PNG, WebP, or plain text. Maximum 4 MB. Use files you have permission to
                share.
              </small>
            </label>
            <Button type="submit" loading={busy === 'extract'} disabled={!!busy}>
              Read this document
            </Button>
          </form>
          {drafts.length > 0 && (
            <section className="resume-drafts">
              <h3>Unfinished drafts</h3>
              {drafts.map((item) => (
                <button key={item.id} disabled={!!busy} onClick={() => void open(item.id)}>
                  <FileText size={16} />
                  <span>
                    {item.filename}
                    <small>{item.projects.length} extracted jobs</small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </section>
          )}
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </Modal>
  );
}

export function LearnFromExamples({
  service,
  onClose,
  onApplied,
}: {
  service: Service;
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await api<{ proposals: Proposal[] }>(`/services/${service.id}/proposals`);
      setProposals(result.proposals);
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [service.id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function learn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('learn');
    setError('');
    try {
      const result = await api<{ proposal: Proposal }>(`/services/${service.id}/learn`, {
        method: 'POST',
        ...json({ notes: new FormData(event.currentTarget).get('notes') }),
      });
      setProposals((items) => [result.proposal, ...items]);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  async function apply(item: Proposal) {
    setBusy(item.id);
    setError('');
    try {
      await api(`/proposals/${item.id}/apply`, { method: 'POST', ...json({}) });
      await load();
      await onApplied();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <Modal
      title="Learn from past jobs"
      subtitle={`${service.name} · Suggested rules stay private until you review and apply them.`}
      onClose={onClose}
    >
      <form onSubmit={learn}>
        <TextArea
          label="What should the assistant understand?"
          name="notes"
          placeholder="Explain your exceptions, the examples that matter, and anything you would price differently now."
          maxLength={5000}
        />
        <Button type="submit" loading={busy === 'learn'} disabled={!!busy}>
          Learn from my examples
        </Button>
      </form>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="learn-proposals">
        {proposals.map((item) => (
          <article key={item.id} className="learn-proposal">
            <div className="rule-row-heading">
              <span>BASED ON {item.sourceExampleIds.length} SAVED EXAMPLES</span>
              <Badge tone={item.status === 'applied' ? 'green' : ''}>{item.status}</Badge>
            </div>
            <h3>Suggested pricing</h3>
            <p>{item.proposal.explanation}</p>
            <div className="proposal-rates">
              <span>
                Per {item.proposal.unitLabel || service.unitLabel}
                <strong>{money(item.proposal.unitPriceCents)}</strong>
              </span>
              <span>
                Base<strong>{money(item.proposal.basePriceCents)}</strong>
              </span>
              <span>
                Minimum<strong>{money(item.proposal.minimumChargeCents)}</strong>
              </span>
            </div>
            <div className="proposal-details">
              <strong>Required details</strong>
              <p>{item.proposal.requiredInputs.join(', ') || 'None proposed'}</p>
              <strong>Exclusions</strong>
              <p>{item.proposal.exclusions.join(', ') || 'None proposed'}</p>
              {item.proposal.pricingRules.map((rule) => (
                <p key={rule.id}>
                  <strong>{rule.name}:</strong> when {rule.field}{' '}
                  {rule.operator.replaceAll('_', ' ')} “{rule.value}”,{' '}
                  {rule.kind === 'review'
                    ? 'request owner review'
                    : rule.kind === 'percent'
                      ? `adjust by ${rule.amount / 100}%`
                      : `${rule.amount >= 0 ? 'add' : 'deduct'} ${money(Math.abs(rule.amount))}${rule.kind === 'per_unit' ? ' per unit' : ''}`}
                  .
                </p>
              ))}
            </div>
            {item.proposal.uncertainties?.length > 0 && (
              <Notice>{item.proposal.uncertainties.join(' ')}</Notice>
            )}
            {item.status === 'pending' && (
              <>
                <small>
                  Applying this suggestion changes the service policy and invalidates publication.
                  Test and approve the new version before launching.
                </small>
                <Button
                  variant="secondary"
                  onClick={() => void apply(item)}
                  loading={busy === item.id}
                  disabled={!!busy}
                >
                  <Check size={15} /> Apply this playbook
                </Button>
              </>
            )}
          </article>
        ))}
      </div>
    </Modal>
  );
}
