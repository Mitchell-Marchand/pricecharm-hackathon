import { useRef, useState, type DragEvent } from 'react';
import { Camera, ChevronDown, FileText, ImagePlus, Plus, Upload, X } from 'lucide-react';
import { photoSrc } from '../assets/photos';
import { Sheet } from '../components/Sheet';
import { BottomBar, WizardHeader } from '../components/Wizard';
import { Button, Chip, Field, MoneyInput, Segmented, TextArea, TextInput } from '../components/ui';
import { invoiceJob, sampleJob } from '../data/samples';
import { TRADES_BY_ID } from '../data/trades';
import { useStore } from '../lib/store';
import type { Discount, Job } from '../lib/types';
import { cx, money, moneyInput, parseMoney, readPhoto, uid } from '../lib/util';

const MAX_PHOTOS = 8;

function blankJob(serviceName: string): Job {
  return {
    id: uid('job'),
    serviceName,
    description: '',
    priceCents: null,
    photos: [],
    size: '',
    duration: '',
    when: '',
    materialsCents: null,
    discount: null,
    notes: '',
    source: 'manual',
  };
}

function discountText(discount: Discount): string {
  const amount = discount.kind === 'percent' ? `${discount.value}% off` : `${money(discount.value)} off`;
  return discount.reason ? `${amount}, ${discount.reason.toLowerCase()}` : amount;
}

function JobCard({ job, onEdit, onRemove }: { job: Job; onEdit: () => void; onRemove: () => void }) {
  const facts = [job.serviceName, job.size, job.duration, job.when].filter(Boolean).join(' · ');
  return (
    <li className="fade-up flex gap-4 rounded-md border border-line bg-surface p-3 sm:p-4">
      {job.photos[0] ? (
        <img src={photoSrc(job.photos[0])} alt="" className="size-18 shrink-0 rounded-sm object-cover sm:size-20" />
      ) : (
        <span className="inline-flex size-18 shrink-0 flex-col items-center justify-center gap-1 rounded-sm bg-surface-2 text-muted sm:size-20">
          <Camera className="size-5" aria-hidden />
          <span className="text-[11px]">No photos</span>
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 font-semibold">{job.description}</p>
          <p className="tabular shrink-0 font-mono font-semibold">{job.priceCents != null ? money(job.priceCents) : '—'}</p>
        </div>
        {facts && <p className="mt-1 text-sm text-muted">{facts}</p>}
        {job.discount && <p className="mt-1 text-sm text-go">{discountText(job.discount)}</p>}
        <div className="mt-2 flex gap-4 text-sm">
          <button type="button" onClick={onEdit} className="font-semibold text-accent hover:underline">
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

export function Jobs() {
  const { state, dispatch } = useStore();
  const services = state.business.services.length ? state.business.services : ['General'];
  const trade = state.business.tradeId ? TRADES_BY_ID[state.business.tradeId] : null;
  const [editing, setEditing] = useState<{ job: Job; banner?: string } | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const count = state.jobs.length;

  return (
    <div className="flex min-h-dvh flex-col">
      <WizardHeader step={2} />
      <main className="gutter mx-auto w-full max-w-[680px] flex-1 pt-10 pb-16 sm:pt-14">
        <h1 className="t-h1">Add a few jobs you've already done.</h1>
        <p className="mt-3 text-lg text-ink-2">
          Real jobs teach it your prices. Photos help a lot. Three is a good start.
        </p>

        {count === 0 ? (
          <div className="mt-8 rounded-md border border-dashed border-line-strong bg-surface p-6">
            <ImagePlus className="size-7 text-accent" aria-hidden />
            <h2 className="t-h3 mt-3">Start with a job you remember well</h2>
            <p className="mt-1 text-ink-2">What it was, what you charged, and a photo or two if you have them.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={() => setEditing({ job: blankJob(services[0]) })}>
                <Plus aria-hidden /> Add a job
              </Button>
              <Button variant="secondary" onClick={() => setInvoiceOpen(true)}>
                <Upload aria-hidden /> Upload an old quote or invoice
              </Button>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: 'saveJob', job: sampleJob(uid('job')) })}
              className="mt-4 text-sm text-muted underline underline-offset-4 hover:text-ink"
            >
              Prototype: add a sample job
            </button>
          </div>
        ) : (
          <>
            <ul className="mt-8 flex flex-col gap-3" aria-label="Your past jobs">
              {state.jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onEdit={() => setEditing({ job })}
                  onRemove={() => dispatch({ type: 'removeJob', id: job.id })}
                />
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing({ job: blankJob(services[0]) })}>
                <Plus aria-hidden /> Add another job
              </Button>
              <Button variant="ghost" onClick={() => setInvoiceOpen(true)}>
                <Upload aria-hidden /> Upload an invoice
              </Button>
            </div>
            <div className="mt-8 flex items-center gap-3" aria-label={`${count} of 3 suggested jobs added`}>
              <div className="flex w-28 gap-1" aria-hidden>
                {[0, 1, 2].map((slot) => (
                  <span key={slot} className={cx('h-1.5 flex-1 rounded-full', slot < count ? 'bg-ink' : 'bg-line')} />
                ))}
              </div>
              <p className="text-sm text-muted">
                {count >= 3
                  ? 'Nice. That gives your AI plenty to go on.'
                  : `${count} added. ${3 - count} more will sharpen its quotes, or continue now.`}
              </p>
            </div>
          </>
        )}
      </main>
      <BottomBar
        onBack={() => dispatch({ type: 'go', screen: 'business' })}
        onNext={() => dispatch({ type: 'go', screen: 'practice' })}
        disabled={count === 0}
        hint="Add at least one job to continue."
      />

      <JobSheet
        key={editing?.job.id ?? 'closed'}
        open={Boolean(editing)}
        job={editing?.job ?? null}
        banner={editing?.banner}
        services={services}
        placeholder={trade?.jobHint ?? 'What you did, how big it was, anything unusual.'}
        onClose={() => setEditing(null)}
        onSave={(job) => {
          dispatch({ type: 'saveJob', job });
          setEditing(null);
        }}
      />
      <InvoiceSheet
        open={invoiceOpen}
        onClose={() => setInvoiceOpen(false)}
        onRead={(filename, own) => {
          setInvoiceOpen(false);
          setEditing({
            job: invoiceJob(uid('job')),
            banner: own
              ? `Prototype: we can't read files yet, so this is sample data instead of ${filename}.`
              : `We filled this in from ${filename}. Check it over, then save.`,
          });
        }}
      />
    </div>
  );
}

function JobSheet({
  open,
  job,
  banner,
  services,
  placeholder,
  onClose,
  onSave,
}: {
  open: boolean;
  job: Job | null;
  banner?: string;
  services: string[];
  placeholder: string;
  onClose: () => void;
  onSave: (job: Job) => void;
}) {
  const start = job ?? blankJob(services[0]);
  const [photos, setPhotos] = useState<string[]>(start.photos);
  const [serviceName, setServiceName] = useState(
    services.includes(start.serviceName) ? start.serviceName : services[0],
  );
  const [description, setDescription] = useState(start.description);
  const [price, setPrice] = useState(moneyInput(start.priceCents));
  const [more, setMore] = useState(Boolean(start.size || start.duration || start.when || start.discount || start.notes));
  const [size, setSize] = useState(start.size);
  const [duration, setDuration] = useState(start.duration);
  const [when, setWhen] = useState(start.when);
  const [materials, setMaterials] = useState(moneyInput(start.materialsCents));
  const [discountKind, setDiscountKind] = useState<Discount['kind']>(start.discount?.kind ?? 'amount');
  const [discountValue, setDiscountValue] = useState(
    start.discount ? (start.discount.kind === 'amount' ? moneyInput(start.discount.value) : String(start.discount.value)) : '',
  );
  const [discountReason, setDiscountReason] = useState(start.discount?.reason ?? '');
  const [notes, setNotes] = useState(start.notes);
  const [photoError, setPhotoError] = useState('');
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
    const room = MAX_PHOTOS - photos.length;
    try {
      const read = await Promise.all(images.slice(0, room).map((file) => readPhoto(file)));
      setPhotos((current) => [...current, ...read].slice(0, MAX_PHOTOS));
      if (images.length > room) setPhotoError(`You can add up to ${MAX_PHOTOS} photos per job.`);
    } catch {
      setPhotoError("One of those photos couldn't be opened. Try a JPG or PNG.");
    }
  }

  function save() {
    if (!valid || !job) return;
    const discountNumber =
      discountKind === 'amount' ? parseMoney(discountValue) : Number.parseInt(discountValue, 10) || null;
    onSave({
      ...job,
      photos,
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
    });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={banner ? 'Check this job' : job && job.description ? 'Edit job' : 'Add a job'}
      subtitle="Only you and your AI see this."
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">{valid ? 'Ready to save.' : 'Add what the job was and what you charged.'}</p>
          <Button onClick={save} disabled={!valid}>
            Save job
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {banner && (
          <p className="flex gap-2.5 rounded-sm bg-accent-soft px-3.5 py-3 text-sm text-ink">
            <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            {banner}
          </p>
        )}

        <div>
          <p className="text-sm font-semibold">Photos</p>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((photo, index) => (
              <div key={`${photo.slice(-24)}-${index}`} className="relative">
                <img src={photoSrc(photo)} alt={`Job photo ${index + 1}`} className="aspect-square w-full max-w-full rounded-sm object-cover" />
                <button
                  type="button"
                  onClick={() => setPhotos((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove photo ${index + 1}`}
                  className="absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded-full bg-ink/80 text-on-ink"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
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
                  dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface-2 hover:border-ink/40',
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
          <MoneyInput id="job-price" placeholder="275" value={price} onChange={setPrice} className="max-w-[220px]" />
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
              <span className="block text-sm text-muted">Size, time, materials, discounts. All optional.</span>
            </span>
            <ChevronDown className={cx('size-5 shrink-0 text-muted transition-transform', more && 'rotate-180')} aria-hidden />
          </button>
          {more && (
            <div className="fade-up mt-5 flex flex-col gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="How big was it?" htmlFor="job-size">
                  <TextInput id="job-size" placeholder="600 sq ft" value={size} onChange={(event) => setSize(event.target.value)} />
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
                  <TextInput id="job-when" placeholder="June 2026" value={when} onChange={(event) => setWhen(event.target.value)} />
                </Field>
                <Field label="Materials cost" htmlFor="job-materials">
                  <MoneyInput id="job-materials" placeholder="0" value={materials} onChange={setMaterials} />
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
                        onChange={(event) => setDiscountValue(event.target.value.replace(/\D/g, '').slice(0, 2))}
                        className="pr-8 font-mono"
                      />
                      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-muted">%</span>
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
  onRead: (filename: string, ownFile: boolean) => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const read = (filename: string, own: boolean) => {
    setReading(filename);
    window.setTimeout(() => {
      setReading(null);
      onRead(filename, own);
    }, 1600);
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
            <span className="text-sm text-muted">PDF, JPG or PNG, up to 10 MB</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) read(file.name, true);
              event.target.value = '';
            }}
          />
          <Button variant="link" onClick={() => read('invoice-1187.pdf', false)} className="self-start">
            Prototype: use a sample invoice
          </Button>
        </div>
      )}
    </Sheet>
  );
}
