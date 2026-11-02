'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { FileText, LoaderCircle, Upload } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Button, MoneyInput, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import {
  listImports,
  removeImport,
  saveImports,
  uploadImport,
  type JobImport,
  type PastJob,
  type ReadJob,
} from '@/lib/jobs';
import { cx, money, moneyInput, parseMoney } from '@/lib/util';

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
/** The server reads a couple of files at a time, so a busy moment is worth waiting out. */
const BUSY_RETRIES = 5;

/** What the owner can change on a read job before saving it. Everything else is kept as read. */
type Draft = { serviceName: string; description: string; price: string; size: string };

const draftOf = (job: ReadJob, services: string[]): Draft => ({
  serviceName: services.includes(job.serviceName) ? job.serviceName : services[0],
  description: job.description,
  price: moneyInput(job.priceCents),
  size: job.size,
});
const problem = (draft: Draft) =>
  draft.description.trim().length < 4
    ? 'Add what the job was.'
    : !parseMoney(draft.price)
      ? 'Add what you charged.'
      : '';

/** The rest of what it read, in a line, so the owner knows it's coming along. */
function extras(job: ReadJob) {
  return [
    job.duration,
    job.when,
    job.materialsCents ? `${money(job.materialsCents)} materials` : '',
    job.discount
      ? `${job.discount.kind === 'percent' ? `${job.discount.value}%` : money(job.discount.value)} off${job.discount.reason ? `, ${job.discount.reason.toLowerCase()}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const selectClass =
  'h-12 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none';

/**
 * Old quotes and invoices, as many as the owner drops in. Each is sent as soon as it's picked and
 * read on the server while the owner carries on. What it reads lands on one list to check and
 * save together. The list survives a reload until it's saved or cleared.
 */
export function JobImports({
  services,
  sizeHint,
  onSaved,
}: {
  services: string[];
  sizeHint?: string;
  onSaved: (jobs: PastJob[]) => void;
}) {
  const notify = useToast();
  const [imports, setImports] = useState<JobImport[]>([]);
  const [sending, setSending] = useState<{ key: number; filename: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const nextKey = useRef(0);
  // Saved or dropped here. A list fetched a moment earlier mustn't bring them back.
  const gone = useRef(new Set<string>());

  /** The server's list, plus any this page added that it didn't have yet. */
  const merge = (fresh: JobImport[]) =>
    setImports((current) => [
      ...fresh.filter((item) => !gone.current.has(item.id)),
      ...current.filter(
        (item) => !gone.current.has(item.id) && !fresh.some((other) => other.id === item.id),
      ),
    ]);

  useEffect(() => {
    listImports()
      .then(merge)
      .catch(() => {});
  }, []);
  const reading = imports.some((item) => item.status === 'reading');
  useEffect(() => {
    if (!reading) return;
    const timer = window.setTimeout(() => {
      listImports()
        .then(merge)
        .catch(() => {});
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [reading, imports]);

  async function send(key: number, file: File) {
    for (let attempt = 0; ; attempt++) {
      try {
        const added = await uploadImport(file);
        setImports((current) => [...current, added]);
        break;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UPLOAD_BUSY' && attempt < BUSY_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        notify(`${file.name}: ${errorMessage(error)}`);
        break;
      }
    }
    setSending((current) => current.filter((item) => item.key !== key));
  }

  function addFiles(files: FileList | File[]) {
    const picked = Array.from(files).filter(
      (file) => file.type === 'application/pdf' || file.type.startsWith('image/'),
    );
    if (!picked.length) {
      notify('Choose PDFs or photos of your quotes and invoices.');
      return;
    }
    const entries = picked.map((file) => ({ key: nextKey.current++, file }));
    setSending((current) => [
      ...current,
      ...entries.map(({ key, file }) => ({ key, filename: file.name })),
    ]);
    // One at a time, in the order they were picked.
    for (const { key, file } of entries) queue.current = queue.current.then(() => send(key, file));
  }

  function drop(item: JobImport) {
    gone.current.add(item.id);
    setImports((current) => current.filter((other) => other.id !== item.id));
    removeImport(item.id).catch((error) => {
      gone.current.delete(item.id);
      setImports((current) => [...current, item]);
      notify(errorMessage(error));
    });
  }

  const ready = imports.filter((item) => item.status === 'ready' && item.job);
  const draft = (item: JobImport) => drafts[item.id] ?? draftOf(item.job!, services);
  const edit = (item: JobImport, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [item.id]: { ...draft(item), ...patch } }));

  async function save() {
    setTried(true);
    if (saving || ready.some((item) => problem(draft(item)))) return;
    setSaving(true);
    try {
      const result = await saveImports(
        ready.map((item) => {
          const checked = draft(item);
          return {
            importId: item.id,
            job: {
              ...item.job!,
              serviceName: checked.serviceName,
              description: checked.description.trim(),
              priceCents: parseMoney(checked.price),
              size: checked.size.trim(),
            },
          };
        }),
      );
      for (const item of ready) gone.current.add(item.id);
      merge(result.imports);
      onSaved(result.jobs);
      setTried(false);
      notify(`Saved ${ready.length} ${ready.length === 1 ? 'job' : 'jobs'}.`);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const waiting = sending.length + imports.filter((item) => item.status === 'reading').length;
  // Files with no job in them are left to remove, with nothing to save.
  const saveable = waiting > 0 || ready.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {(imports.length > 0 || sending.length > 0) && (
        <section
          className="rounded-md border border-line-strong bg-surface p-4 sm:p-5"
          aria-labelledby="imports-title"
        >
          <h2 id="imports-title" className="t-h3">
            Check these jobs
          </h2>
          {saveable && (
            <p className="mt-1 text-sm text-ink-2">
              Read from your files. Fix anything that&apos;s off, then save them together.
            </p>
          )}
          <ul className="mt-4 flex flex-col divide-y divide-line" aria-label="Jobs from your files">
            {sending.map((item) => (
              <PendingRow key={`sending-${item.key}`} filename={item.filename} text="Sending…" />
            ))}
            {imports.map((item) =>
              item.status === 'reading' ? (
                <PendingRow key={item.id} filename={item.filename} text="Reading…" />
              ) : item.status === 'ready' && item.job ? (
                <ReadRow
                  key={item.id}
                  item={item}
                  draft={draft(item)}
                  services={services}
                  sizeHint={sizeHint}
                  error={tried ? problem(draft(item)) : ''}
                  onEdit={(patch) => edit(item, patch)}
                  onDrop={() => drop(item)}
                />
              ) : (
                <li key={item.id} className="flex items-start justify-between gap-3 py-3">
                  <p className="flex min-w-0 gap-2 text-[15px]">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                    <span>
                      {item.status === 'empty'
                        ? `We couldn’t find a job in ${item.filename}. Add it yourself if you like.`
                        : `${item.filename}: ${item.failure}`}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => drop(item)}
                    className="shrink-0 text-sm text-muted hover:text-stop"
                  >
                    Remove
                  </button>
                </li>
              ),
            )}
          </ul>
          {saveable && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-sm text-muted" role="status">
                {waiting
                  ? `${waiting} still reading. You can save these now and the rest after.`
                  : ready.length
                    ? 'Saved jobs teach it your prices straight away.'
                    : ''}
              </p>
              <Button onClick={() => void save()} disabled={!ready.length || saving}>
                {saving
                  ? 'Saving…'
                  : ready.length
                    ? `Save ${ready.length} ${ready.length === 1 ? 'job' : 'jobs'}`
                    : 'Save jobs'}
              </Button>
            </div>
          )}
        </section>
      )}

      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        className={cx(
          'flex w-full items-center gap-3 rounded-md border border-dashed px-4 py-4 text-left transition-colors',
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line-strong bg-surface hover:border-ink/40',
        )}
      >
        <Upload className="size-5 shrink-0 text-accent" aria-hidden />
        <span>
          <span className="block font-semibold">Upload old quotes or invoices</span>
          <span className="block text-sm text-muted">
            Drop in as many as you like, PDFs or photos. We&apos;ll read them while you carry on.
          </span>
        </span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

function PendingRow({ filename, text }: { filename: string; text: string }) {
  return (
    <li className="flex items-center gap-3 py-3" aria-busy="true">
      <LoaderCircle className="size-4 shrink-0 animate-spin text-muted" aria-hidden />
      <span className="min-w-0 truncate text-[15px]">{filename}</span>
      <span className="ml-auto shrink-0 text-sm text-muted">{text}</span>
    </li>
  );
}

function ReadRow({
  item,
  draft,
  services,
  sizeHint,
  error,
  onEdit,
  onDrop,
}: {
  item: JobImport;
  draft: Draft;
  services: string[];
  sizeHint?: string;
  error: string;
  onEdit: (patch: Partial<Draft>) => void;
  onDrop: () => void;
}) {
  const id = `import-${item.id}`;
  const more = extras(item.job!);
  return (
    <li className="py-4" aria-label={`Job from ${item.filename}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
          <FileText className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{item.filename}</span>
        </p>
        <button
          type="button"
          onClick={onDrop}
          className="shrink-0 text-sm text-muted hover:text-stop"
        >
          Skip
        </button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px_150px]">
        <div className="sm:col-span-3">
          <label htmlFor={`${id}-description`} className="sr-only">
            What was the job?
          </label>
          <TextInput
            id={`${id}-description`}
            value={draft.description}
            placeholder="What was the job?"
            onChange={(event) => onEdit({ description: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-service`} className="sr-only">
            Service
          </label>
          <select
            id={`${id}-service`}
            value={draft.serviceName}
            onChange={(event) => onEdit({ serviceName: event.target.value })}
            className={selectClass}
          >
            {services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-price`} className="sr-only">
            What did you charge?
          </label>
          <MoneyInput
            id={`${id}-price`}
            placeholder="Charged"
            value={draft.price}
            onChange={(price) => onEdit({ price })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-size`} className="sr-only">
            How big was it?
          </label>
          <TextInput
            id={`${id}-size`}
            value={draft.size}
            placeholder={sizeHint ?? 'Size'}
            onChange={(event) => onEdit({ size: event.target.value })}
          />
        </div>
      </div>
      {more && <p className="mt-2 text-sm text-muted">Also on it: {more}</p>}
      {item.issues.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
          {item.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mt-2 text-sm text-stop" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
