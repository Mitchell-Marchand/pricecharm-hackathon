'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Camera, ChevronDown, LoaderCircle, Plus, X } from 'lucide-react';
import { JobImports } from '@/components/jobs/JobImports';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toast';
import { Button, Chip, Field, MoneyInput, Segmented, TextArea, TextInput } from '@/components/ui';
import { errorMessage, fieldErrors } from '@/lib/api';
import {
  listJobs,
  removeJob,
  saveJob,
  SIZE_SLOTS,
  uploadJobPhoto,
  type Discount,
  type JobFields,
  type JobPhoto,
  type PastJob,
  type SizeSlot,
} from '@/lib/jobs';
import { article, cx, money, moneyInput, parseMoney } from '@/lib/util';
import { currencySymbol } from '@/lib/currency';

const MAX_PHOTOS = 8;
/** Jobs with a size a service needs before its guesses can be checked against your prices. */
const SIZED_JOBS = 3;

/** What each slot asks for, on the empty slot and at the top of the sheet it opens. */
const SLOTS: Record<
  SizeSlot,
  { label: string; add: string; hint: string; sheet: (service: string) => string }
> = {
  small: {
    label: 'Small',
    add: 'A small one',
    hint: 'Near the low end of what you do',
    sheet: (service) => `A small ${service} job, near the low end of what you do.`,
  },
  usual: {
    label: 'Usual',
    add: 'A usual one',
    hint: 'The kind you do most',
    sheet: (service) => `A usual ${service} job, the kind you do most.`,
  },
  big: {
    label: 'Big',
    add: 'A big one',
    hint: 'One of your biggest',
    sheet: (service) => `One of your bigger ${service} jobs.`,
  },
};

export function blankFields(serviceName: string, slot: SizeSlot | null = null): JobFields {
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
    slot,
  };
}

export type Editing = {
  id: string | null;
  fields: JobFields;
  photos: JobPhoto[];
};

/** A new job for a service, for the slot it's meant to fill. */
export const newJob = (service: string, slot: SizeSlot | null = null): Editing => ({
  id: null,
  fields: blankFields(service, slot),
  photos: [],
});

/**
 * A service's jobs in its small, usual and big slots: each in the slot the owner added it to,
 * then the rest by size. Jobs past the three are listed after them.
 */
function fillSlots(jobs: PastJob[]) {
  const slots: Record<SizeSlot, PastJob | null> = { small: null, usual: null, big: null };
  const rest: PastJob[] = [];
  for (const job of jobs) {
    if (job.slot && !slots[job.slot]) slots[job.slot] = job;
    else rest.push(job);
  }
  const open = SIZE_SLOTS.filter((slot) => !slots[slot]);
  // Smallest first so sizes line up with the slots. Jobs without a size go last.
  const chosen = rest
    .slice(0, open.length)
    .sort((a, b) => (a.quantity ?? Number.MAX_VALUE) - (b.quantity ?? Number.MAX_VALUE));
  // One job takes the middle of the open slots, two take the ends.
  const targets =
    chosen.length === 1 ? [open[Math.floor((open.length - 1) / 2)]] : [open[0], open.at(-1)];
  chosen.forEach((job, index) => {
    const slot = chosen.length === open.length ? open[index] : targets[index];
    if (slot) slots[slot] = job;
  });
  return { slots, extra: rest.slice(open.length) };
}

function discountText(discount: Discount): string {
  const amount =
    discount.kind === 'percent' ? `${discount.value}% off` : `${money(discount.value)} off`;
  return discount.reason ? `${amount}, ${discount.reason.toLowerCase()}` : amount;
}

/** The unit most of a service's jobs are sized in. Its rate is worked out in that one. */
function mainUnit(jobs: PastJob[]) {
  const counts = new Map<string, number>();
  for (const job of jobs) if (job.unit) counts.set(job.unit, (counts.get(job.unit) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Why a job doesn't teach it the service's rate yet, if it doesn't. */
function sizeNote(job: PastJob, example: string, unit: string | null) {
  if (!job.quantity)
    return job.size
      ? `It can’t read a size from “${job.size}”. Try something like ${example}.`
      : `Add how big it was, like ${example}, so it can learn your rate.`;
  if (unit && job.unit !== unit)
    return `It read this one as ${job.quantity} ${job.unit}, but your other ${job.serviceName} jobs are in ${unit}. Add its size in ${unit}.`;
  return '';
}

function JobCard({
  job,
  label,
  note,
  onEdit,
  onRemove,
}: {
  job: PastJob;
  label?: string;
  note: string;
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
        {label && <p className="text-xs font-semibold text-muted uppercase">{label}</p>}
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 font-semibold">{job.description}</p>
          <p className="tabular shrink-0 font-mono font-semibold">{money(job.priceCents)}</p>
        </div>
        {facts && <p className="mt-1 text-sm text-muted">{facts}</p>}
        {job.discount && <p className="mt-1 text-sm text-go">{discountText(job.discount)}</p>}
        {note && <p className="mt-1 text-sm text-ink-2">{note}</p>}
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

function EmptySlot({
  slot,
  service,
  onAdd,
}: {
  slot: SizeSlot;
  service: string;
  onAdd: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onAdd}
        aria-label={`Add ${article(slot)} ${slot} ${service} job`}
        className="flex w-full items-center gap-3 rounded-md border border-dashed border-line-strong bg-surface px-4 py-3.5 text-left transition-colors hover:border-ink/40"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Plus className="size-4" aria-hidden />
        </span>
        <span>
          <span className="block font-semibold">{SLOTS[slot].add}</span>
          <span className="block text-sm text-muted">{SLOTS[slot].hint}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The owner's past jobs, by service: a small, a usual and a big one for each service they've
 * started on, plus adding, editing, and reading one from an invoice.
 */
export function PastJobsEditor({
  services,
  jobHint,
  sizeHint,
  onJobsChange,
  addRequest,
}: {
  services: string[];
  jobHint?: string;
  sizeHint?: string;
  onJobsChange?: (jobs: PastJob[]) => void;
  /** Opens the sheet for this service's next empty slot, each time `at` changes. */
  addRequest?: { service: string; at: number } | null;
}) {
  const notify = useToast();
  const [jobs, setJobs] = useState<PastJob[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const sizeExample = sizeHint ?? '600 sq ft';

  useEffect(() => {
    listJobs()
      .then(setJobs)
      .catch((error) => setLoadError(errorMessage(error)));
  }, []);
  useEffect(() => {
    if (jobs) onJobsChange?.(jobs);
  }, [jobs, onJobsChange]);
  const handled = useRef(0);
  useEffect(() => {
    if (!addRequest || !jobs || handled.current === addRequest.at) return;
    handled.current = addRequest.at;
    const { slots } = fillSlots(jobs.filter((job) => job.serviceName === addRequest.service));
    setEditing(newJob(addRequest.service, SIZE_SLOTS.find((slot) => !slots[slot]) ?? null));
  }, [addRequest, jobs]);

  const remove = async (job: PastJob) => {
    setJobs((current) => current?.filter((item) => item.id !== job.id) ?? null);
    try {
      await removeJob(job.id);
    } catch (error) {
      setJobs((current) => (current ? [...current, job] : current));
      notify(errorMessage(error));
    }
  };
  const card = (job: PastJob, unit: string | null, label?: string) => (
    <JobCard
      key={job.id}
      job={job}
      label={label}
      note={sizeNote(job, sizeExample, unit)}
      onEdit={() => setEditing({ id: job.id, fields: job, photos: job.photos })}
      onRemove={() => void remove(job)}
    />
  );

  // The main service always shows its slots. Others do once they have a job.
  const groups = [...new Set([...services, ...(jobs ?? []).map((job) => job.serviceName)])].map(
    (service, index) => {
      const own = (jobs ?? []).filter((job) => job.serviceName === service);
      return { service, jobs: own, open: index === 0 || own.length > 0 };
    },
  );
  const others = groups.filter((group) => !group.open);

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
      ) : (
        <div className="flex flex-col gap-8">
          {groups
            .filter((group) => group.open)
            .map(({ service, jobs: own }) => {
              const { slots, extra } = fillSlots(own);
              const unit = mainUnit(own);
              const sized = own.filter((job) => job.unit && job.unit === unit).length;
              return (
                <section key={service} aria-label={service}>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="t-h3">{service}</h2>
                    <p className={cx('text-sm', sized >= SIZED_JOBS ? 'text-go' : 'text-muted')}>
                      {sized >= SIZED_JOBS
                        ? `${sized} with a size`
                        : `${sized} of ${SIZED_JOBS} with a size`}
                    </p>
                  </div>
                  <ul className="mt-3 flex flex-col gap-3" aria-label={`Your ${service} jobs`}>
                    {SIZE_SLOTS.map((slot) => {
                      const job = slots[slot];
                      return job ? (
                        card(job, unit, SLOTS[slot].label)
                      ) : (
                        <EmptySlot
                          key={slot}
                          slot={slot}
                          service={service}
                          onAdd={() => setEditing(newJob(service, slot))}
                        />
                      );
                    })}
                    {extra.map((job) => card(job, unit))}
                  </ul>
                </section>
              );
            })}

          {others.length > 0 && (
            <section aria-labelledby="other-services">
              <h2 id="other-services" className="font-semibold">
                Your other services
              </h2>
              <p className="mt-1 text-sm text-muted">
                Add these whenever you like. Each one sharpens its prices for that service.
              </p>
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {others.map(({ service }) => (
                  <li key={service} className="flex items-center justify-between gap-3 py-2.5">
                    <span>{service}</span>
                    <button
                      type="button"
                      onClick={() => setEditing(newJob(service))}
                      aria-label={`Add ${article(service)} ${service} job`}
                      className="text-sm font-semibold text-accent hover:underline"
                    >
                      Add a job
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {jobs.length > 0 && (
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => setEditing(newJob(services[0]))}
            >
              <Plus aria-hidden /> Add another job
            </Button>
          )}
          <JobImports services={services} sizeHint={sizeHint} onSaved={setJobs} />
        </div>
      )}

      <JobSheet
        key={
          editing
            ? `${editing.id ?? 'new'}-${editing.fields.serviceName}-${editing.fields.slot ?? ''}`
            : 'closed'
        }
        editing={editing}
        services={services}
        placeholder={jobHint ?? 'What you did, how big it was, anything unusual.'}
        sizeHint={sizeHint}
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
    </>
  );
}

/**
 * The sheet's fields, top to bottom, by the name the API uses for each. The ones under "More
 * details" open it when the API turns them down.
 */
const SHEET_FIELDS = {
  photoIds: { id: null, more: false },
  serviceName: { id: null, more: false },
  description: { id: 'job-description', more: false },
  priceCents: { id: 'job-price', more: false },
  size: { id: 'job-size', more: false },
  duration: { id: 'job-duration', more: true },
  when: { id: 'job-when', more: true },
  materialsCents: { id: 'job-materials', more: true },
  discount: { id: 'job-discount', more: true },
  notes: { id: 'job-notes', more: true },
} as const;
type SheetField = keyof typeof SHEET_FIELDS;

/** Adding or editing one job. A job added for a slot says which size it's after. */
export function JobSheet({
  editing,
  services,
  placeholder,
  sizeHint,
  onClose,
  onSaved,
}: {
  editing: Editing | null;
  services: string[];
  placeholder: string;
  sizeHint?: string;
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
    Boolean(start.duration || start.when || start.discount || start.notes || start.materialsCents),
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
  const [problems, setProblems] = useState<Partial<Record<SheetField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const priceCents = parseMoney(price);
  const valid = description.trim().length > 3 && priceCents !== null && priceCents > 0;

  /** Editing a field the API turned down clears its mark, and the footer once none are left. */
  const fix = (field: SheetField) => {
    if (!problems[field]) return;
    const rest = { ...problems };
    delete rest[field];
    setProblems(rest);
    if (!Object.keys(rest).length) setSaveError('');
  };
  const mark = (field: SheetField) => ({ 'aria-invalid': Boolean(problems[field]) || undefined });

  function showRejected(error: unknown) {
    const found: Partial<Record<SheetField, string>> = {};
    for (const [path, message] of Object.entries(fieldErrors(error))) {
      const field = path.split('.')[0];
      if (field in SHEET_FIELDS) found[field as SheetField] ??= message;
    }
    setProblems(found);
    const first = (Object.keys(SHEET_FIELDS) as SheetField[]).find((field) => found[field]);
    if (!first) {
      setSaveError(errorMessage(error));
      return;
    }
    setSaveError('Check the highlighted fields.');
    if (Object.keys(found).some((field) => SHEET_FIELDS[field as SheetField].more)) setMore(true);
    const id = SHEET_FIELDS[first].id;
    if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 50);
  }

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
    setProblems({});
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
          slot: start.slot,
        },
        photos.map((photo) => photo.id),
      );
      onSaved(job);
    } catch (error) {
      showRejected(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={Boolean(editing)}
      onClose={onClose}
      title={editing?.id ? 'Edit job' : 'Add a job'}
      subtitle={
        start.slot && !editing?.id
          ? `${SLOTS[start.slot].sheet(serviceName)} Other businesses never see this.`
          : 'Other businesses never see this.'
      }
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
          {(photoError || problems.photoIds) && (
            <p className="mt-2 text-sm text-stop">{photoError || problems.photoIds}</p>
          )}
        </div>

        <div>
          <p className="text-sm font-semibold">Service</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {services.map((name) => (
              <Chip
                key={name}
                selected={serviceName === name}
                onClick={() => {
                  setServiceName(name);
                  fix('serviceName');
                }}
              >
                {name}
              </Chip>
            ))}
          </div>
          {problems.serviceName && <p className="mt-2 text-sm text-stop">{problems.serviceName}</p>}
        </div>

        <Field label="What was the job?" htmlFor="job-description" error={problems.description}>
          <TextArea
            id="job-description"
            rows={3}
            placeholder={placeholder}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              fix('description');
            }}
            {...mark('description')}
          />
        </Field>

        <Field
          label="What did you charge?"
          htmlFor="job-price"
          hint="The total the customer paid."
          error={problems.priceCents}
        >
          <MoneyInput
            id="job-price"
            placeholder="275"
            value={price}
            onChange={(value) => {
              setPrice(value);
              fix('priceCents');
            }}
            className="max-w-[220px]"
            {...mark('priceCents')}
          />
        </Field>

        <Field
          label="How big was it?"
          htmlFor="job-size"
          hint="However you price it. This is how it learns your rate."
          error={problems.size}
        >
          <TextInput
            id="job-size"
            placeholder={sizeHint ?? 'Sq ft, rooms, hours'}
            value={size}
            onChange={(event) => {
              setSize(event.target.value);
              fix('size');
            }}
            className="max-w-[320px]"
            {...mark('size')}
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
                Time, materials, discounts. All optional.
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
                <Field
                  label="How long did it take?"
                  htmlFor="job-duration"
                  error={problems.duration}
                >
                  <TextInput
                    id="job-duration"
                    placeholder="3 hours"
                    value={duration}
                    onChange={(event) => {
                      setDuration(event.target.value);
                      fix('duration');
                    }}
                    {...mark('duration')}
                  />
                </Field>
                <Field label="When was it?" htmlFor="job-when" error={problems.when}>
                  <TextInput
                    id="job-when"
                    placeholder="June 2026"
                    value={when}
                    onChange={(event) => {
                      setWhen(event.target.value);
                      fix('when');
                    }}
                    {...mark('when')}
                  />
                </Field>
                <Field
                  label="Materials cost"
                  htmlFor="job-materials"
                  error={problems.materialsCents}
                >
                  <MoneyInput
                    id="job-materials"
                    placeholder="0"
                    value={materials}
                    onChange={(value) => {
                      setMaterials(value);
                      fix('materialsCents');
                    }}
                    {...mark('materialsCents')}
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
                      fix('discount');
                    }}
                    options={[
                      { value: 'amount', label: `${currencySymbol()} off` },
                      { value: 'percent', label: '% off' },
                    ]}
                  />
                  {discountKind === 'amount' ? (
                    <MoneyInput
                      id="job-discount"
                      aria-label="Discount amount"
                      placeholder="20"
                      value={discountValue}
                      onChange={(value) => {
                        setDiscountValue(value);
                        fix('discount');
                      }}
                      className="w-32"
                      {...mark('discount')}
                    />
                  ) : (
                    <div className="relative w-28">
                      <TextInput
                        id="job-discount"
                        aria-label="Discount percent"
                        inputMode="numeric"
                        placeholder="10"
                        value={discountValue}
                        onChange={(event) => {
                          setDiscountValue(event.target.value.replace(/\D/g, '').slice(0, 2));
                          fix('discount');
                        }}
                        className="pr-8 font-mono"
                        {...mark('discount')}
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
                  onChange={(event) => {
                    setDiscountReason(event.target.value);
                    fix('discount');
                  }}
                />
                {problems.discount && <p className="text-sm text-stop">{problems.discount}</p>}
              </fieldset>
              <Field
                label="Anything that made it cost more or less?"
                htmlFor="job-notes"
                error={problems.notes}
              >
                <TextArea
                  id="job-notes"
                  rows={2}
                  placeholder="Steep driveway, extra moss, had to haul water"
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    fix('notes');
                  }}
                  {...mark('notes')}
                />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
