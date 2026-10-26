'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Camera,
  ChevronDown,
  FileText,
  ImagePlus,
  LoaderCircle,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toast';
import { Button, Chip, Field, MoneyInput, Segmented, TextArea, TextInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  listJobs,
  readDocument,
  removeJob,
  saveJob,
  uploadJobPhoto,
  type Discount,
  type JobFields,
  type JobPhoto,
  type PastJob,
} from '@/lib/jobs';
import { cx, money, moneyInput, parseMoney } from '@/lib/util';

const MAX_PHOTOS = 8;

function blankFields(serviceName: string): JobFields {
  return {
    serviceName,
    description: '',
    priceCents: null,
    size: '',
    duration: '',
    when: '',
    materialsCents: null,
    discount: null,
    notes: '',
    source: 'manual',
  };
}

type Editing = {
  id: string | null;
  fields: JobFields;
  photos: JobPhoto[];
  banner?: string;
  issues?: string[];
};

function discountText(discount: Discount): string {
  const amount =
    discount.kind === 'percent' ? `${discount.value}% off` : `${money(discount.value)} off`;
  return discount.reason ? `${amount}, ${discount.reason.toLowerCase()}` : amount;
}

function JobCard({
  job,
  onEdit,
  onRemove,
}: {
  job: PastJob;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const facts = [job.serviceName, job.size, job.duration, job.when].filter(Boolean).join(' · ');
  return (
    <li className="fade-up flex gap-4 rounded-md border border-line bg-surface p-3 sm:p-4">
      {job.photos[0] ? (
        <img
          src={job.photos[0].url}
          alt=""
          className="size-18 shrink-0 rounded-sm object-cover sm:size-20"
        />
      ) : (
        <span className="inline-flex size-18 shrink-0 flex-col items-center justify-center gap-1 rounded-sm bg-surface-2 text-muted sm:size-20">
          <Camera className="size-5" aria-hidden />
          <span className="text-[11px]">No photos</span>
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 font-semibold">{job.description}</p>
          <p className="tabular shrink-0 font-mono font-semibold">{money(job.priceCents)}</p>
        </div>
        {facts && <p className="mt-1 text-sm text-muted">{facts}</p>}
        {job.discount && <p className="mt-1 text-sm text-go">{discountText(job.discount)}</p>}
        <div className="mt-2 flex gap-4 text-sm">
          <button
            type="button"
            onClick={onEdit}
            className="font-semibold text-accent hover:underline"
          >
            Edit
          </button>
          <button type="button" onClick={onRemove} className="text-muted hover:text-stop">
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

/** The owner's past jobs: the list, adding and editing one, and reading one from an invoice. */
export function PastJobsEditor({
  services,
  jobHint,
  onJobsChange,
}: {
  services: string[];
  jobHint?: string;
  onJobsChange?: (jobs: PastJob[]) => void;
}) {
  const notify = useToast();
  const [jobs, setJobs] = useState<PastJob[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch((error) => setLoadError(errorMessage(error)));
  }, []);
  useEffect(() => {
    if (jobs) onJobsChange?.(jobs);
  }, [jobs, onJobsChange]);

  const count = jobs?.length ?? 0;
  const remove = async (job: PastJob) => {
    setJobs((current) => current?.filter((item) => item.id !== job.id) ?? null);
    try {
      await removeJob(job.id);
    } catch (error) {
      setJobs((current) => (current ? [...current, job] : current));
      notify(errorMessage(error));
    }
  };

  return (
    <>
      {loadError ? (
        <p className="text-stop" role="alert">
          {loadError}
        </p>
      ) : jobs === null ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your jobs">
          <div className="shimmer h-28 rounded-md" />
        </div>
      ) : count === 0 ? (
        <div className="rounded-md border border-dashed border-line-strong bg-surface p-6">
          <ImagePlus className="size-7 text-accent" aria-hidden />
          <h2 className="t-h3 mt-3">Start with a job you remember well</h2>
          <p className="mt-1 text-ink-2">
            What it was, what you charged, and a photo or two if you have them.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              onClick={() => setEditing({ id: null, fields: blankFields(services[0]), photos: [] })}
            >
              <Plus aria-hidden /> Add a job
            </Button>
            <Button variant="secondary" onClick={() => setInvoiceOpen(true)}>
              <Upload aria-hidden /> Upload an old quote or invoice
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-3" aria-label="Your past jobs">
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onEdit={() => setEditing({ id: job.id, fields: job, photos: job.photos })}
                onRemove={() => void remove(job)}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => setEditing({ id: null, fields: blankFields(services[0]), photos: [] })}
            >
              <Plus aria-hidden /> Add another job
            </Button>
            <Button variant="ghost" onClick={() => setInvoiceOpen(true)}>
              <Upload aria-hidden /> Upload an invoice
            </Button>
          </div>
        </>
      )}

      <JobSheet
        key={editing ? `${editing.id ?? 'new'}-${editing.banner ?? ''}` : 'closed'}
        editing={editing}
        services={services}
        placeholder={jobHint ?? 'What you did, how big it was, anything unusual.'}
        onClose={() => setEditing(null)}
        onSaved={(job) => {
          setJobs((current) => {
            const list = current ?? [];
            return list.some((item) => item.id === job.id)
              ? list.map((item) => (item.id === job.id ? job : item))
              : [...list, job];
          });
          setEditing(null);
        }}
      />
      <InvoiceSheet
        open={invoiceOpen}
        onClose={() => setInvoiceOpen(false)}
        onRead={(filename, result) => {
          setInvoiceOpen(false);
          setEditing({
            id: null,
            fields: {
              ...result.job,
              serviceName: services.includes(result.job.serviceName)
                ? result.job.serviceName
                : services[0],
              source: 'invoice',
            },
            photos: [],
            banner: `We filled this in from ${filename}. Check it over, then save.`,
            issues: result.issues,
          });
        }}
      />
    </>
  );
}

function JobSheet({
  editing,
  services,
  placeholder,
  onClose,
  onSaved,
}: {
  editing: Editing | null;
  services: string[];
  placeholder: string;
  onClose: () => void;
  onSaved: (job: PastJob) => void;
}) {
  const start = editing?.fields ?? blankFields(services[0]);
  const [photos, setPhotos] = useState<JobPhoto[]>(editing?.photos ?? []);
  const [uploading, setUploading] = useState(0);
  const [serviceName, setServiceName] = useState(
    services.includes(start.serviceName) ? start.serviceName : services[0],
  );
  const [description, setDescription] = useState(start.description);
  const [price, setPrice] = useState(moneyInput(start.priceCents));
  const [more, setMore] = useState(
    Boolean(
      start.size ||
      start.duration ||
      start.when ||
      start.discount ||
      start.notes ||
      start.materialsCents,
    ),
  );
  const [size, setSize] = useState(start.size);
  const [duration, setDuration] = useState(start.duration);
  const [when, setWhen] = useState(start.when);
  const [materials, setMaterials] = useState(moneyInput(start.materialsCents));
  const [discountKind, setDiscountKind] = useState<Discount['kind']>(
    start.discount?.kind ?? 'amount',
  );
  const [discountValue, setDiscountValue] = useState(
    start.discount
      ? start.discount.kind === 'amount'
        ? moneyInput(start.discount.value)
        : String(start.discount.value)
      : '',
  );
  const [discountReason, setDiscountReason] = useState(start.discount?.reason ?? '');
  const [notes, setNotes] = useState(start.notes);
  const [photoError, setPhotoError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const priceCents = parseMoney(price);
  const valid = description.trim().length > 3 && priceCents !== null && priceCents > 0;

  async function addFiles(files: FileList | File[]) {
    setPhotoError('');
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) {
      setPhotoError('Choose image files, like JPG, PNG or HEIC.');
      return;
    }
    const room = MAX_PHOTOS - photos.length - uploading;
    if (images.length > room) setPhotoError(`You can add up to ${MAX_PHOTOS} photos per job.`);
    const batch = images.slice(0, Math.max(0, room));
    setUploading((value) => value + batch.length);
    await Promise.all(
      batch.map(async (file) => {
        try {
          const uploaded = await uploadJobPhoto(file);
          setPhotos((current) => [...current, uploaded].slice(0, MAX_PHOTOS));
        } catch (error) {
          setPhotoError(errorMessage(error) || "One of those photos couldn't be opened.");
        } finally {
          setUploading((value) => value - 1);
        }
      }),
    );
  }

  async function save() {
    if (!valid || saving) return;
    const discountNumber =
      discountKind === 'amount'
        ? parseMoney(discountValue)
        : Number.parseInt(discountValue, 10) || null;
    setSaving(true);
    setSaveError('');
    try {
      const job = await saveJob(
        editing?.id ?? null,
        {
          serviceName,
          description: description.trim(),
          priceCents,
          size: size.trim(),
          duration: duration.trim(),
          when: when.trim(),
          materialsCents: parseMoney(materials),
          discount:
            discountNumber && discountNumber > 0
              ? { kind: discountKind, value: discountNumber, reason: discountReason.trim() }
              : null,
          notes: notes.trim(),
          source: start.source,
        },
        photos.map((photo) => photo.id),
      );
      onSaved(job);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={Boolean(editing)}
      onClose={onClose}
      title={editing?.banner ? 'Check this job' : editing?.id ? 'Edit job' : 'Add a job'}
      subtitle="Only you and your AI see this."
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className={cx('text-sm', saveError ? 'text-stop' : 'text-muted')} role="status">
            {saveError ||
              (uploading
                ? 'Adding photos…'
                : valid
                  ? 'Ready to save.'
                  : 'Add what the job was and what you charged.')}
          </p>
          <Button onClick={() => void save()} disabled={!valid || saving || uploading > 0}>
            {saving ? 'Saving…' : 'Save job'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {editing?.banner && (
          <div className="flex gap-2.5 rounded-sm bg-accent-soft px-3.5 py-3 text-sm text-ink">
            <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <div>
              <p>{editing.banner}</p>
              {editing.issues && editing.issues.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4 text-ink-2">
                  {editing.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div>
          <p className="text-sm font-semibold">Photos</p>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((photo, index) => (
              <div key={photo.id} className="relative">
                <img
                  src={photo.url}
                  alt={`Job photo ${index + 1}`}
                  className="aspect-square w-full max-w-full rounded-sm object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setPhotos((current) => current.filter((item) => item.id !== photo.id))
                  }
                  aria-label={`Remove photo ${index + 1}`}
                  className="absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded-full bg-ink/80 text-on-ink"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {Array.from({ length: uploading }, (_, index) => (
              <div
                key={`uploading-${index}`}
                className="shimmer flex aspect-square items-center justify-center rounded-sm"
                aria-label="Adding a photo"
              >
                <LoaderCircle className="size-5 animate-spin text-muted" aria-hidden />
              </div>
            ))}
            {photos.length + uploading < MAX_PHOTOS && (
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
                  void addFiles(event.dataTransfer.files);
                }}
                className={cx(
                  'flex aspect-square flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed text-sm text-ink-2 transition-colors',
                  dragging
                    ? 'border-accent bg-accent-soft'
                    : 'border-line-strong bg-surface-2 hover:border-ink/40',
                )}
              >
                <Camera className="size-5" aria-hidden />
                Add photos
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          {photoError && <p className="mt-2 text-sm text-stop">{photoError}</p>}
        </div>

        <div>
          <p className="text-sm font-semibold">Service</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {services.map((name) => (
              <Chip key={name} selected={serviceName === name} onClick={() => setServiceName(name)}>
                {name}
              </Chip>
            ))}
          </div>
        </div>

        <Field label="What was the job?" htmlFor="job-description">
          <TextArea
            id="job-description"
            rows={3}
            placeholder={placeholder}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field label="What did you charge?" htmlFor="job-price" hint="The total the customer paid.">
          <MoneyInput
            id="job-price"
            placeholder="275"
            value={price}
            onChange={setPrice}
            className="max-w-[220px]"
          />
        </Field>

        <div className="border-t border-line pt-5">
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((value) => !value)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span>
              <span className="block font-semibold">More details</span>
              <span className="block text-sm text-muted">
                Size, time, materials, discounts. All optional.
              </span>
            </span>
            <ChevronDown
              className={cx(
                'size-5 shrink-0 text-muted transition-transform',
                more && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
          {more && (
            <div className="fade-up mt-5 flex flex-col gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="How big was it?" htmlFor="job-size">
                  <TextInput
                    id="job-size"
                    placeholder="600 sq ft"
                    value={size}
                    onChange={(event) => setSize(event.target.value)}
                  />
                </Field>
                <Field label="How long did it take?" htmlFor="job-duration">
                  <TextInput
                    id="job-duration"
                    placeholder="3 hours"
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                  />
                </Field>
                <Field label="When was it?" htmlFor="job-when">
                  <TextInput
                    id="job-when"
                    placeholder="June 2026"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                  />
                </Field>
                <Field label="Materials cost" htmlFor="job-materials">
                  <MoneyInput
                    id="job-materials"
                    placeholder="0"
                    value={materials}
                    onChange={setMaterials}
                  />
                </Field>
              </div>
              <fieldset className="flex flex-col gap-3">
                <legend className="text-sm font-semibold">Discount</legend>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="Discount type"
                    value={discountKind}
                    onChange={(kind) => {
                      setDiscountKind(kind);
                      setDiscountValue('');
                    }}
                    options={[
                      { value: 'amount', label: '$ off' },
                      { value: 'percent', label: '% off' },
                    ]}
                  />
                  {discountKind === 'amount' ? (
                    <MoneyInput
                      id="job-discount"
                      aria-label="Discount amount"
                      placeholder="20"
                      value={discountValue}
                      onChange={setDiscountValue}
                      className="w-32"
                    />
                  ) : (
                    <div className="relative w-28">
                      <TextInput
                        id="job-discount"
                        aria-label="Discount percent"
                        inputMode="numeric"
                        placeholder="10"
                        value={discountValue}
                        onChange={(event) =>
                          setDiscountValue(event.target.value.replace(/\D/g, '').slice(0, 2))
                        }
                        className="pr-8 font-mono"
                      />
                      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-muted">
                        %
                      </span>
                    </div>
                  )}
                </div>
                <label htmlFor="job-discount-reason" className="sr-only">
                  Why the discount
                </label>
                <TextInput
                  id="job-discount-reason"
                  placeholder="Why? For example: repeat customer"
                  value={discountReason}
                  onChange={(event) => setDiscountReason(event.target.value)}
                />
              </fieldset>
              <Field label="Anything that made it cost more or less?" htmlFor="job-notes">
                <TextArea
                  id="job-notes"
                  rows={2}
                  placeholder="Steep driveway, extra moss, had to haul water"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function InvoiceSheet({
  open,
  onClose,
  onRead,
}: {
  open: boolean;
  onClose: () => void;
  onRead: (filename: string, result: Awaited<ReturnType<typeof readDocument>>) => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const read = async (file: File) => {
    setReading(file.name);
    setError('');
    try {
      const result = await readDocument(file);
      if (!result.found) {
        setError(
          `We couldn’t find a job in ${file.name}. Try another file, or add the job yourself.`,
        );
        return;
      }
      onRead(file.name, result);
    } catch (readError) {
      setError(errorMessage(readError));
    } finally {
      setReading(null);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Upload a quote or invoice"
      subtitle="A PDF or a photo of one. We'll pull out the job and the price for you to check."
    >
      {reading ? (
        <div className="flex flex-col gap-4" role="status">
          <p className="font-semibold">Reading {reading}…</p>
          <div className="shimmer h-4 w-3/4 rounded-xs" />
          <div className="shimmer h-4 w-1/2 rounded-xs" />
          <div className="shimmer h-4 w-2/3 rounded-xs" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line-strong bg-surface-2 p-6 text-left hover:border-ink/40"
          >
            <Upload className="size-6 text-accent" aria-hidden />
            <span className="font-semibold">Choose a file</span>
            <span className="text-sm text-muted">A PDF up to 4 MB, or a JPG or PNG photo</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void read(file);
              event.target.value = '';
            }}
          />
          {error && (
            <p className="text-sm text-stop" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
