'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, Trash2 } from 'lucide-react';
import { api, ApiError, cents, errorMessage, json, money } from '@/lib/api';
import type { ImportDraft, ImportProject, ImportReceipt } from '@/lib/types';
import { Button, Field, Notice, Select, TextArea } from './ui';
import styles from './import-review.module.css';

function priced(project: ImportProject) {
  return (
    project.currency === 'USD' &&
    !!project.unitLabel?.trim() &&
    project.quantity !== null &&
    Number.isFinite(project.quantity) &&
    project.quantity > 0 &&
    project.finalPriceCents !== null &&
    Number.isFinite(project.finalPriceCents) &&
    project.finalPriceCents >= 0 &&
    !!project.rationale.trim()
  );
}

function sourceAmount(project: ImportProject) {
  if (project.finalPriceCents === null) return 'Price not recorded';
  if (!project.currency) return `${project.finalPriceCents / 100} · currency not recorded`;
  try {
    return money(project.finalPriceCents, project.currency);
  } catch {
    return `${project.finalPriceCents / 100} ${project.currency}`;
  }
}

export function savedImportMessage(receipt: Pick<ImportReceipt, 'imported' | 'notesSaved'>) {
  return (
    [
      receipt.imported > 0 &&
        `${receipt.imported} priced ${receipt.imported === 1 ? 'job' : 'jobs'}`,
      receipt.notesSaved > 0 &&
        `${receipt.notesSaved} job ${receipt.notesSaved === 1 ? 'note' : 'notes'}`,
    ]
      .filter(Boolean)
      .join(' and ') + ' saved.'
  );
}

export default function ImportReview({
  draft,
  onSaved,
  onChooseAnother,
  chooseAnotherLabel = 'Choose another file',
}: {
  draft: ImportDraft;
  onSaved: (count: number, receipt: ImportReceipt) => Promise<void>;
  onChooseAnother?: () => void;
  chooseAnotherLabel?: string;
}) {
  const key = `quotient:import-review:${draft.id}`;
  const [projects, setProjects] = useState<ImportProject[]>(draft.projects);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [receipt, setReceipt] = useState<ImportReceipt | undefined>(draft.confirmation);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      const ids = new Set(draft.projects.map((project) => project.id));
      if (
        saved?.version === 1 &&
        Array.isArray(saved.projects) &&
        saved.projects.every(
          (project: ImportProject) =>
            ids.has(project.id) &&
            typeof project.title === 'string' &&
            typeof project.description === 'string' &&
            typeof project.rationale === 'string',
        )
      )
        setProjects(saved.projects);
    } catch {
      // The server draft remains available when browser storage is unavailable.
    }
    setLoaded(true);
  }, [key]);
  useEffect(() => {
    if (!loaded || receipt) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({ version: 1, projects }));
    } catch {
      /* Keeping the current review does not require browser storage. */
    }
  }, [key, projects, loaded, receipt]);

  function change(id: string, values: Partial<ImportProject>) {
    setProjects((items) =>
      items.map((project) => (project.id === id ? { ...project, ...values } : project)),
    );
  }
  const jobs = projects.filter(priced).length;
  const notes = projects.length - jobs;
  const buttonLabel =
    jobs && notes
      ? `Save ${jobs} ${jobs === 1 ? 'job' : 'jobs'} and ${notes} ${notes === 1 ? 'note' : 'notes'}`
      : jobs
        ? jobs === 1
          ? 'Save this job'
          : 'Save these jobs'
        : notes === 1
          ? 'Save this note'
          : 'Save these notes';

  async function continueToWorkspace(saved: ImportReceipt) {
    try {
      setBusy(true);
      await onSaved(saved.imported + saved.notesSaved, saved);
    } catch (cause) {
      setError(`Your records are saved. ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (busy || !projects.length) return;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const result = await api<ImportReceipt & { draft: ImportDraft }>(
        `/imports/${draft.id}/confirm`,
        {
          method: 'POST',
          ...json({
            projects: projects.map(({ id, issues, ...project }) => ({
              ...project,
              projectId: id,
              saveAsNote: !priced({ id, issues, ...project }),
              finalPriceCents: project.currency === 'USD' ? project.finalPriceCents : null,
            })),
          }),
        },
      );
      setReceipt(result);
      await onSaved(result.imported + result.notesSaved, result);
    } catch (cause) {
      setConflict(
        cause instanceof ApiError &&
          ['IMPORT_CONFIRMATION_CONFLICT', 'IMPORT_ALREADY_CONFIRMED'].includes(cause.code),
      );
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function viewReceipt() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ draft: ImportDraft }>(`/imports/${draft.id}`);
      if (result.draft.confirmation) setReceipt(result.draft.confirmation);
      else
        setError(
          'This import was already saved. Your unsaved edits are still kept in this browser.',
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (receipt)
    return (
      <section className={styles.receipt} aria-label="Import saved receipt">
        <Check size={18} aria-hidden="true" />
        <div>
          <h3>{savedImportMessage(receipt)}</h3>
          {receipt.notesSaved > 0 && (
            <p>Job notes can help with customer questions. They don’t become a standard price.</p>
          )}
          <Button onClick={() => void continueToWorkspace(receipt)} loading={busy}>
            Continue to assistant
          </Button>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      </section>
    );
  return (
    <section className={styles.review} aria-label="Review jobs and notes">
      <p className={styles.source}>
        {draft.sourceBasis === 'exact_owner_text'
          ? 'From the text you provided'
          : `Extracted from ${draft.sourceFilename || draft.filename}`}
      </p>
      {projects.map((project) => {
        const isPriced = priced(project);
        const sourceCurrency = draft.projects.find((item) => item.id === project.id)?.currency;
        return (
          <article
            key={project.id}
            className={styles.project}
            aria-label={project.title || 'Job note'}
          >
            <header>
              <h3>{project.title || 'Job note'}</h3>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${project.title || 'job note'}`}
                disabled={busy}
                onClick={() =>
                  setProjects((items) => items.filter((item) => item.id !== project.id))
                }
              >
                <Trash2 size={15} />
              </button>
            </header>
            <p>{project.description}</p>
            <div className={styles.facts}>
              <strong>{sourceAmount(project)}</strong>
              <span>
                {project.quantity === null
                  ? 'Quantity not recorded'
                  : `${project.quantity.toLocaleString()}${project.unitLabel ? ` ${project.unitLabel}` : ' · unit not recorded'}`}
              </span>
            </div>
            {project.rationale && <p>{project.rationale}</p>}
            <p className={styles.kind}>
              {isPriced
                ? 'Save as a priced job'
                : 'Save as a job note — no standard rate will be assumed.'}
            </p>
            {!isPriced && project.currency !== 'USD' && (
              <p className={styles.currency}>
                The source currency is {project.currency || 'not recorded'}. Its amount stays in the
                source details; it won’t be saved as a USD price.
              </p>
            )}
            <details>
              <summary>
                Edit details <ChevronDown size={14} />
              </summary>
              <div className={styles.editor}>
                <Field
                  label="Job title"
                  value={project.title}
                  maxLength={160}
                  onChange={(event) => change(project.id, { title: event.target.value })}
                />
                <TextArea
                  label="Scope and details"
                  value={project.description}
                  maxLength={5000}
                  onChange={(event) => change(project.id, { description: event.target.value })}
                />
                <div className="form-grid">
                  <Field
                    label="Quantity unit"
                    value={project.unitLabel ?? ''}
                    maxLength={60}
                    placeholder="Leave blank if unknown"
                    onChange={(event) =>
                      change(project.id, {
                        unitLabel: event.target.value.trim() ? event.target.value : null,
                      })
                    }
                  />
                  <Field
                    label="Quantity"
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={project.quantity ?? ''}
                    onChange={(event) =>
                      change(project.id, {
                        quantity: event.target.value === '' ? null : Number(event.target.value),
                      })
                    }
                  />
                  <Select
                    label="Currency"
                    value={project.currency ?? ''}
                    onChange={(event) => {
                      const currency = event.target.value || null;
                      change(project.id, {
                        currency,
                        ...(currency === 'USD' && project.currency !== 'USD'
                          ? { finalPriceCents: null }
                          : {}),
                      });
                    }}
                  >
                    <option value="">Not recorded</option>
                    <option value="USD">USD — I confirm this amount is in US dollars</option>
                    {sourceCurrency && sourceCurrency !== 'USD' && (
                      <option value={sourceCurrency}>
                        {sourceCurrency} — as recorded in the source
                      </option>
                    )}
                  </Select>
                  <Field
                    label={
                      project.currency === 'USD'
                        ? 'Confirmed amount in USD'
                        : 'Amount in source currency'
                    }
                    type="number"
                    min="0"
                    step="0.01"
                    value={project.finalPriceCents === null ? '' : project.finalPriceCents / 100}
                    onChange={(event) =>
                      change(project.id, {
                        finalPriceCents:
                          event.target.value === '' ? null : cents(event.target.value),
                      })
                    }
                  />
                </div>
                <TextArea
                  label="Why this price?"
                  value={project.rationale}
                  maxLength={5000}
                  placeholder="Leave blank if it wasn’t recorded"
                  onChange={(event) => change(project.id, { rationale: event.target.value })}
                />
              </div>
            </details>
          </article>
        );
      })}
      {draft.sourceBasis === 'exact_owner_text' && draft.sourceNotes && (
        <details className={styles.original}>
          <summary>
            Original job note <ChevronDown size={14} />
          </summary>
          <p>{draft.sourceNotes}</p>
        </details>
      )}
      {error && (
        <Notice kind="error">
          {error}
          {conflict && (
            <button
              type="button"
              className="text-button"
              onClick={() => void viewReceipt()}
              disabled={busy}
            >
              View saved receipt
            </button>
          )}
        </Notice>
      )}
      {projects.length === 0 && <p>All jobs were removed from this review.</p>}
      <div className={styles.actions}>
        {onChooseAnother && (
          <button type="button" className="text-button" onClick={onChooseAnother} disabled={busy}>
            {chooseAnotherLabel}
          </button>
        )}
        {projects.length === 0 ? (
          <Button type="button" onClick={() => setProjects(draft.projects)}>
            Restore extracted jobs
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void confirm()}
            loading={busy}
            disabled={
              !loaded ||
              !projects.length ||
              projects.some((project) => !project.title.trim() || !project.description.trim())
            }
          >
            {buttonLabel} <Check size={15} />
          </Button>
        )}
      </div>
    </section>
  );
}
