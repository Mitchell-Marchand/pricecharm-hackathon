'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import SubmittedProject from './submitted-project';
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import {
  ArrowRight,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  CircleCheck,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FlaskConical,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
  FileText,
  Play,
  LoaderCircle,
  CircleDollarSign,
  Pause,
  Pencil,
} from 'lucide-react';
import Publish from './publishing';
import PublicWidget from './public-widget';
import { AccountPanel, BillingPanel } from './account-billing';
import { DocumentImport, LearnFromExamples } from './knowledge';
import { savedImportMessage } from './import-review';
import { PricingRulesEditor } from './service-rules';
import ServiceSetup from './service-setup';
import AssistantWorkspace from './assistant-workspace';
import requestStyles from './owner-requests.module.css';
import shellStyles from './dashboard-shell.module.css';
import { api, ApiError, cents, dollars, errorMessage, json, money, shortDate } from '@/lib/api';
import {
  ownerRequestIntent,
  ownerRequestUrl,
  requestFilter,
  validRequestCursor,
  currentDashboardLoginUrl,
} from '@/lib/owner-request';
import type {
  Business,
  Dashboard,
  Evaluation,
  Example,
  Quote,
  QuoteInboxPage,
  PricingRule,
  Service,
  Settings,
  TrainingSession,
  User,
} from '@/lib/types';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Logo,
  Modal,
  Notice,
  PageHeader,
  Select,
  TextArea,
  TextLink,
} from './ui';

type Workspace = {
  data: Dashboard;
  user: User;
  settings: Settings;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
};
const navItems = [
  { id: '', label: 'Overview', icon: LayoutDashboard },
  { id: 'services', label: 'Services & pricing', icon: SlidersHorizontal },
  { id: 'examples', label: 'Project examples', icon: BookOpen },
  { id: 'training', label: 'Practice quotes', icon: MessageSquare },
  { id: 'playground', label: 'Playground', icon: FlaskConical },
  { id: 'quotes', label: 'Quotes', icon: FileText },
  { id: 'publish', label: 'Publish & embed', icon: Globe },
  { id: 'billing', label: 'Billing & usage', icon: CircleDollarSign },
  { id: 'settings', label: 'Business & account', icon: Settings2 },
];

export default function DashboardApp({ section = '' }: { section?: string }) {
  const router = useRouter();
  const [state, setState] = useState<{
    data: Dashboard;
    user: User;
    settings: Settings;
  }>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [auth, data, settings] = await Promise.all([
        api<{ user: User; business: Business }>('/auth/me'),
        api<Dashboard>('/dashboard'),
        api<Settings>('/settings'),
      ]);
      setState({ data, user: auth.user, settings });
      setError('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        const target = currentDashboardLoginUrl();
        if (target) router.replace(target);
      } else setError(errorMessage(cause));
    }
  }, [router]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch (cause) {
      setToast(errorMessage(cause));
    }
  }
  const workspace = state ? { ...state, refresh, notify: setToast } : null;
  const active = navItems.find((item) => item.id === section);
  return (
    <div className={shellStyles.shell}>
      <header className={shellStyles.sidebar}>
        <div className={shellStyles.sidebarInner}>
          <Logo href="/dashboard" />
          <nav className={shellStyles.navigation} aria-label="Main workspace navigation">
            <Link
              className={section !== 'quotes' ? shellStyles.active : ''}
              aria-current={section === '' ? 'page' : undefined}
              href="/dashboard"
            >
              <BookOpen size={19} strokeWidth={1.6} aria-hidden="true" />
              Assistant
            </Link>
            <Link
              className={section === 'quotes' ? shellStyles.active : ''}
              aria-current={section === 'quotes' ? 'page' : undefined}
              href="/dashboard/quotes"
            >
              <MessageSquare size={19} strokeWidth={1.6} aria-hidden="true" />
              Requests{' '}
              {!!state?.data.stats.reviewQuotes && <span>{state.data.stats.reviewQuotes}</span>}
            </Link>
          </nav>
          <details className={shellStyles.account}>
            <summary aria-label="Account and settings">
              <span className={shellStyles.initial}>
                {state?.data.business.name.charAt(0).toUpperCase() || 'Q'}
              </span>
              <span>{state?.data.business.name || 'Account'}</span>
              <ChevronDown size={14} />
            </summary>
            <div>
              <Link href="/dashboard/settings">Account & business</Link>
              <Link href="/dashboard/billing">Billing</Link>
              <span className={shellStyles.menuLabel}>More tools</span>
              <Link href="/dashboard/services">Services & pricing</Link>
              <Link href="/dashboard/examples">Past jobs & imports</Link>
              <Link href="/dashboard/playground">Detailed price tests</Link>
              <Link href="/dashboard/publish">Automatic quote settings</Link>
              <button onClick={() => void logout()}>
                Sign out <LogOut size={14} />
              </button>
            </div>
          </details>
        </div>
      </header>
      <main
        className={`app-main ${shellStyles.main} ${section ? 'app-secondary' : ''} ${section === 'quotes' ? `app-requests ${requestStyles.app}` : ''}`}
      >
        {error && (
          <Notice kind="error">
            {error}{' '}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </Notice>
        )}
        {!workspace ? (
          <p className="quiet-loading">Opening your assistant…</p>
        ) : !active ? (
          <EmptyState
            title="This page isn’t here."
            action={<ButtonLink href="/dashboard">Open your assistant</ButtonLink>}
          >
            Open your assistant or requests from the navigation.
          </EmptyState>
        ) : (
          <>
            {section && section !== 'quotes' && (
              <Link className="back-to-assistant" href="/dashboard">
                <ArrowLeft size={14} /> Back to your assistant
              </Link>
            )}
            {section === '' && <AssistantWorkspace {...workspace} />}
            {section === 'services' && <Services {...workspace} />}
            {section === 'examples' && <Examples {...workspace} />}
            {section === 'training' && (
              <Suspense fallback={<p className="quiet-loading">Opening your practice quote…</p>}>
                <LegacyPracticeRedirect data={workspace.data} />
              </Suspense>
            )}
            {section === 'playground' && <Playground {...workspace} />}
            {section === 'quotes' && (
              <Suspense fallback={<p className="quiet-loading">Opening your requests…</p>}>
                <Quotes {...workspace} />
              </Suspense>
            )}
            {section === 'publish' && <Publish {...workspace} />}
            {section === 'settings' && <WorkspaceSettings {...workspace} />}
            {section === 'billing' && <BillingView {...workspace} />}
          </>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  foot,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  foot: string;
}) {
  return (
    <article className="stat-card">
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <small>{foot}</small>
    </article>
  );
}

function Services({ data, refresh, notify }: Workspace) {
  const router = useRouter();
  const [learning, setLearning] = useState<Service>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('new')) setCreating(true);
    if (query.get('advanced')) setEditing('new');
  }, []);
  if (creating && editing !== 'new')
    return (
      <ServiceSetup
        business={data.business}
        onCancel={() => {
          setCreating(false);
          window.history.replaceState(null, '', '/dashboard/services');
        }}
        onAdvanced={() => setEditing('new')}
        onStarted={async ({ service, sessionId }) => {
          await refresh();
          notify(
            sessionId
              ? `${service.name} is ready for your first practice conversation.`
              : `${service.name} is saved.`,
          );
          const query = new URLSearchParams({ service: service.id });
          if (sessionId) query.set('practice', sessionId);
          router.push(`/dashboard?${query.toString()}`);
        }}
      />
    );
  return (
    <>
      <PageHeader
        title="Services & pricing"
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} /> Add a service
          </Button>
        }
      />
      {!data.services.length ? (
        <section className="panel">
          <EmptyState
            title="No services yet"
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus size={16} /> Create your first service
              </Button>
            }
          >
            Add a service or describe a recent job to get started.
          </EmptyState>
        </section>
      ) : (
        <div className="service-grid">
          {data.services.map((service) => (
            <article className="panel service-card" key={service.id}>
              <div className="service-card-top">
                <span className="section-icon">
                  <SlidersHorizontal size={22} />
                </span>
                <Badge tone={service.publishedAt ? 'green' : ''}>
                  {service.publishedAt
                    ? `Published · ${service.mode === 'automatic' ? 'Automatic' : 'Review'}`
                    : 'Draft'}
                </Badge>
              </div>
              <h2>{service.name}</h2>
              <p>
                {service.description ||
                  'Add a description to tell customers what this service covers.'}
              </p>
              {service.unitPriceCents > 0 ||
              service.basePriceCents > 0 ||
              service.minimumChargeCents > 0 ? (
                <>
                  <div className="service-rate">
                    <strong>{money(service.unitPriceCents)}</strong>
                    <span> / {service.unitLabel}</span>
                  </div>
                  <div className="service-pricing-details">
                    <span>
                      Service base <strong>{money(service.basePriceCents)}</strong>
                    </span>
                    <span>
                      Minimum charge <strong>{money(service.minimumChargeCents)}</strong>
                    </span>
                  </div>
                </>
              ) : (
                <div className="service-rate">
                  <strong>No standard pricing saved</strong>
                </div>
              )}
              <div className="service-input-count">
                <Check size={14} /> {service.requiredInputs.length} required details
                <span>Version {service.version}</span>
              </div>
              <Button variant="ghost" onClick={() => setLearning(service)}>
                Learn from my examples
              </Button>
              <div className="service-actions">
                <Button variant="secondary" onClick={() => setEditing(service)}>
                  <Pencil size={14} /> Pricing settings
                </Button>
                <Link href="/dashboard/playground">
                  Test it <ArrowUpRight size={15} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      {learning && (
        <LearnFromExamples
          service={learning}
          onClose={() => setLearning(undefined)}
          onApplied={async () => {
            await refresh();
            notify('Pricing saved. Run the checks before enabling automatic quotes.');
          }}
        />
      )}
      {editing && (
        <ServiceEditor
          service={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setCreating(false);
            window.history.replaceState(null, '', '/dashboard/services');
            await refresh();
            notify('Your service has been saved.');
          }}
        />
      )}
    </>
  );
}

function ServiceEditor({
  service,
  onClose,
  onSaved,
}: {
  service?: Service;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pricingRules, setPricingRules] = useState<PricingRule[]>(service?.pricingRules || []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const lines = (key: string) =>
      String(form.get(key) || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    try {
      await api(`/services${service ? `/${service.id}` : ''}`, {
        method: service ? 'PATCH' : 'POST',
        ...json({
          name: form.get('name'),
          description: form.get('description'),
          unitLabel: form.get('unitLabel'),
          unitPriceCents: cents(String(form.get('unitPrice'))),
          basePriceCents: cents(String(form.get('basePrice'))),
          minimumChargeCents: cents(String(form.get('minimumCharge'))),
          maxAutoQuoteCents: cents(String(form.get('maxAutoQuote'))),
          pricingRules,
          ...(service ? { expectedVersion: service.version } : {}),
          requiredInputs: [
            ...new Set([...lines('requiredInputs'), ...pricingRules.map((rule) => rule.field)]),
          ],
          exclusions: lines('exclusions'),
          mode: 'review',
        }),
      });
      await onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal title={service ? 'Edit service' : 'New service'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field
          label="Service name"
          name="name"
          required
          defaultValue={service?.name}
          placeholder="Driveway cleaning"
          maxLength={160}
        />
        <TextArea
          label="Description"
          name="description"
          defaultValue={service?.description}
          placeholder="What’s included in this service?"
          maxLength={2000}
        />
        <div className="form-grid">
          <Field
            label="Unit name"
            name="unitLabel"
            required
            defaultValue={service?.unitLabel || 'project'}
            placeholder="sq ft, hour, room, vehicle…"
            maxLength={40}
          />
          <Field
            label="Price per unit ($)"
            name="unitPrice"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={dollars(service?.unitPriceCents || 0)}
          />
        </div>
        <div className="form-grid">
          <Field
            label="Service base ($)"
            name="basePrice"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={dollars(service?.basePriceCents || 0)}
            hint="A fixed amount added to each job."
          />
          <Field
            label="Minimum charge ($)"
            name="minimumCharge"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={dollars(service?.minimumChargeCents || 0)}
            hint="The lowest total you will charge."
          />
        </div>
        <Field
          label="Maximum automatic quote ($)"
          name="maxAutoQuote"
          type="number"
          min="0"
          step="0.01"
          required
          defaultValue={dollars(service?.maxAutoQuoteCents ?? 500000)}
          hint="Use zero to keep all quotes in owner review. Larger requests always require your review."
        />
        <div className="formula-note">
          <span>Price calculation</span>
          <p>The higher of your minimum, or your service base + quantity × unit price.</p>
        </div>
        <TextArea
          label="Required customer details"
          name="requiredInputs"
          defaultValue={service?.requiredInputs.join('\n') || ''}
          hint="One detail per line. The assistant uses these to guide the conversation."
          maxLength={3000}
        />
        <TextArea
          label="Exclusions & jobs needing a closer look"
          name="exclusions"
          defaultValue={service?.exclusions.join('\n')}
          placeholder="Roof cleaning\nFragile or damaged surfaces"
          hint="One item per line. These requests should come to you for review."
          maxLength={3000}
        />
        <PricingRulesEditor rules={pricingRules} onChange={setPricingRules} />
        {service?.publishedAt && (
          <Notice>
            Saving changes pauses publication. Run the checks and publish the updated version when
            ready.
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            {service ? 'Save changes' : 'Create service'}
            <ArrowUpRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Examples({ data, refresh, notify }: Workspace) {
  const [examples, setExamples] = useState<Example[]>(data.examples);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [documents, setDocuments] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setExamples(await api<Example[]>('/examples'));
    } catch (error) {
      setError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function remove(id: string) {
    if (!window.confirm('Remove this saved job?')) return;
    setBusy(id);
    try {
      await api(`/examples/${id}`, { method: 'DELETE' });
      await load();
      await refresh();
      notify('Example removed.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <PageHeader
        title="Past jobs"
        action={
          <div className="heading-buttons">
            <Button
              variant="secondary"
              disabled={!data.services.length}
              onClick={() => setDocuments(true)}
            >
              <FileText size={15} /> Import document
            </Button>
            <Button
              variant="secondary"
              onClick={() => setImporting(true)}
              disabled={!data.services.length}
            >
              <BookOpen size={15} /> Import CSV
            </Button>
            <Button onClick={() => setAdding(true)} disabled={!data.services.length}>
              <Plus size={17} /> Add a project
            </Button>
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {!examples.length ? (
        <section className="panel">
          <EmptyState
            title="No past jobs yet"
            action={
              data.services.length ? (
                <Button onClick={() => setAdding(true)}>
                  <Plus size={16} /> Add your first project
                </Button>
              ) : (
                <ButtonLink href="/dashboard/services">
                  Create a service first <ArrowRight size={16} />
                </ButtonLink>
              )
            }
          >
            Add a job, what you charged, and why. Saved practice quotes appear here too.
          </EmptyState>
        </section>
      ) : (
        <div className="examples-grid">
          {examples.map((example) => (
            <article className="panel example-card" key={example.id}>
              <div className="example-top">
                <Badge tone={example.source === 'training' ? 'purple' : ''}>
                  {example.source === 'training' ? 'Practice quote' : 'Past project'}
                </Badge>
                <button
                  className="icon-button"
                  disabled={busy === example.id}
                  aria-label={`Delete ${example.title}`}
                  onClick={() => void remove(example.id)}
                >
                  {busy === example.id ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              </div>
              <span className="example-service">
                {data.services.find((service) => service.id === example.serviceId)?.name ||
                  'Service'}
              </span>
              <h3>{example.title}</h3>
              <p>{example.description}</p>
              <div className="example-price">
                <strong>{money(example.finalPriceCents)}</strong>
                <span>
                  {example.quantity}{' '}
                  {example.unitLabel ||
                    data.services.find((service) => service.id === example.serviceId)?.unitLabel}
                </span>
              </div>
              <div className="example-rationale">
                <span>Reason for price</span>
                <p>{example.rationale}</p>
              </div>
              <small>Added {shortDate(example.createdAt)}</small>
            </article>
          ))}
        </div>
      )}
      {documents && (
        <DocumentImport
          services={data.services}
          onClose={() => setDocuments(false)}
          onSaved={async (count, receipt) => {
            setDocuments(false);
            await load();
            await refresh();
            notify(receipt ? savedImportMessage(receipt) : `${count} reviewed jobs saved.`);
          }}
        />
      )}
      {adding && (
        <ExampleEditor
          services={data.services}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await load();
            await refresh();
            notify('Project saved.');
          }}
        />
      )}
      {importing && (
        <CsvImport
          services={data.services}
          onClose={() => setImporting(false)}
          onSaved={async (count) => {
            setImporting(false);
            await load();
            await refresh();
            notify(`${count} project${count === 1 ? '' : 's'} imported.`);
          }}
        />
      )}
    </>
  );
}

function ExampleEditor({
  services,
  onClose,
  onSaved,
}: {
  services: Service[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id || '');
  const service = services.find((item) => item.id === serviceId);
  const fields = [
    ...new Set([
      'location',
      ...(service?.requiredInputs || []),
      ...(service?.pricingRules?.map((rule) => rule.field) || []),
    ]),
  ];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/examples', {
        method: 'POST',
        ...json({
          serviceId: form.get('serviceId'),
          title: form.get('title'),
          description: form.get('description'),
          quantity: Number(form.get('quantity')),
          finalPriceCents: cents(String(form.get('price'))),
          rationale: form.get('rationale'),
          source: 'historical',
          inputs: Object.fromEntries(
            fields
              .map((field, index) => [field, String(form.get(`fact-${index}`) || '').trim()])
              .filter(([, value]) => value),
          ),
        }),
      });
      await onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal
      title="Add a past job"
      subtitle="Record the work, final price, and reason."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Select
          label="Service"
          name="serviceId"
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
          required
        >
          {services.map((service) => (
            <option value={service.id} key={service.id}>
              {service.name}
            </option>
          ))}
        </Select>
        <Field
          label="Project title"
          name="title"
          required
          placeholder="A large concrete driveway in North Austin"
          maxLength={160}
        />
        <TextArea
          label="What did the job involve?"
          name="description"
          required
          placeholder="Include the scope, condition, access, and anything unusual."
          maxLength={5000}
        />
        <div className="form-grid">
          <Field
            label="Quantity / units"
            name="quantity"
            type="number"
            min="0.001"
            step="0.001"
            required
            placeholder="600"
          />
          <Field
            label="Final price ($)"
            name="price"
            type="number"
            min="0.01"
            step="0.01"
            required
            placeholder="148.00"
          />
        </div>
        <fieldset className="facts-fieldset">
          <legend>Known project facts</legend>
          <p>
            Confirm the facts that explain any conditional extras or discounts. Leave genuinely
            unknown history blank.
          </p>
          {fields.map((field, index) => (
            <Field
              key={field}
              label={field === 'location' ? 'Project location' : field}
              name={`fact-${index}`}
            />
          ))}
        </fieldset>
        <TextArea
          label="Why this price?"
          name="rationale"
          required
          placeholder="We charged our normal area rate, plus the service base. No unusual access or treatment was required…"
          maxLength={5000}
          hint="Mention discounts, exceptions, and what would have changed the price."
        />
        <Notice>
          Add project details you have permission to use. Avoid customer names, addresses, and other
          personal information.
        </Notice>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Save project <ArrowUpRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LegacyPracticeRedirect({ data }: { data: Dashboard }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function openPractice() {
      setError('');
      const previous = new URLSearchParams(query);
      const sessionId = previous.get('session');
      const requestedService = previous.get('service');
      const target = new URLSearchParams();
      try {
        if (sessionId) {
          const session =
            data.trainingSessions.find((item) => item.id === sessionId) ||
            (await api<TrainingSession>(`/training/${encodeURIComponent(sessionId)}`));
          if (!data.services.some((service) => service.id === session.serviceId)) {
            throw new Error('The service for this practice quote is no longer available.');
          }
          target.set('service', session.serviceId);
          target.set('practice', session.id);
        } else if (data.services.some((service) => service.id === requestedService)) {
          target.set('service', requestedService!);
        }
        if (!cancelled) {
          router.replace(`/dashboard${target.size ? `?${target.toString()}` : ''}`);
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) router.replace('/login');
        else setError(errorMessage(cause));
      }
    }
    void openPractice();
    return () => {
      cancelled = true;
    };
  }, [query, data.services, data.trainingSessions, router, attempt]);

  if (error) {
    return (
      <Notice kind="error">
        {error}{' '}
        <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </button>
      </Notice>
    );
  }
  return (
    <p className="quiet-loading" role="status">
      Opening your practice quote…
    </p>
  );
}

function Playground({ data }: Workspace) {
  const [chatMode, setChatMode] = useState(false);
  const [serviceId, setServiceId] = useState(data.services[0]?.id || '');
  const [result, setResult] = useState<{
    quote: Quote;
    calculation: unknown;
    evaluation?: Evaluation;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const service = data.services.find((value) => value.id === serviceId);
  const factFields = [
    ...new Set([
      'location',
      ...(service?.requiredInputs || []),
      ...(service?.pricingRules?.map((rule) => rule.field) || []),
    ]),
  ];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      setResult(
        await api('/playground', {
          method: 'POST',
          ...json({
            serviceId,
            quantity: Number(form.get('quantity')),
            description: form.get('description'),
            inputs: Object.fromEntries(
              factFields.map((field, index) => [
                field,
                String(form.get(`fact-${index}`) || '').trim(),
              ]),
            ),
          }),
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  if (chatMode)
    return (
      <>
        <PageHeader
          title="Test a customer conversation"
          action={
            <Button variant="secondary" onClick={() => setChatMode(false)}>
              Back to calculator
            </Button>
          }
        />
        <div className="private-chat-preview">
          <PublicWidget
            slug={data.business.slug}
            embedded
            previewProfile={{
              business: data.business,
              services: data.services,
            }}
          />
        </div>
      </>
    );
  return (
    <>
      <PageHeader
        title="Test a quote"
        description="Private test. Nothing is sent or billed."
        action={
          <Button variant="secondary" onClick={() => setChatMode(true)}>
            <MessageSquare size={15} /> Try the full conversation
          </Button>
        }
      />
      <div className="playground-layout">
        <section className="panel playground-form">
          <div className="panel-heading">
            <div>
              <h3>Project details</h3>
            </div>
            <Badge>PRIVATE TEST</Badge>
          </div>
          {data.services.length ? (
            <form onSubmit={submit}>
              <Select
                label="Service"
                value={serviceId}
                onChange={(event) => {
                  setServiceId(event.target.value);
                  setResult(undefined);
                }}
              >
                {data.services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </Select>
              <Field
                label={`Quantity (${service?.unitLabel || 'units'})`}
                name="quantity"
                type="number"
                step="0.001"
                min="0.001"
                required
                placeholder="600"
              />
              <fieldset className="facts-fieldset">
                <legend>Known customer facts</legend>
                {factFields.map((field, index) => (
                  <Field
                    key={field}
                    label={field === 'location' ? 'Project location' : field}
                    name={`fact-${index}`}
                  />
                ))}
              </fieldset>
              <TextArea
                label="Describe the request"
                name="description"
                required
                maxLength={5000}
                rows={5}
                placeholder="What does the customer need? Include the condition, access, and anything unusual."
              />
              {error && <Notice kind="error">{error}</Notice>}
              <Button loading={loading} className="full-width" type="submit">
                Calculate a test quote <ArrowUpRight size={17} />
              </Button>
            </form>
          ) : (
            <EmptyState
              title="Add a service to test"
              action={<ButtonLink href="/dashboard/services">Create a service</ButtonLink>}
            >
              Save a service and its pricing before using the calculator.
            </EmptyState>
          )}
        </section>
        <section className={`playground-result ${result ? 'has-result' : ''}`}>
          {result ? (
            <>
              <QuoteCard quote={result.quote} service={service} owner preview />
              <div className="calculation-note">
                <ShieldCheck size={18} />
                <p>
                  This calculator checks your saved pricing. Review the scope and assumptions before
                  using the result.
                </p>
              </div>
              {result.evaluation && <EvaluationResults evaluation={result.evaluation} />}
            </>
          ) : (
            <div className="result-placeholder">
              <h3>No test result yet</h3>
              <p>Enter the project details and calculate a quote.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function QuoteCard({
  quote,
  service,
  owner = false,
  preview = false,
  presentation = 'card',
}: {
  quote: Quote;
  service?: Service;
  owner?: boolean;
  preview?: boolean;
  presentation?: 'card' | 'request';
}) {
  const requestReceipt = presentation === 'request' && owner && !preview;
  const pending = quote.status === 'review' && !owner;
  const assumptions =
    owner && !preview
      ? quote.assumptions.filter(
          (assumption) =>
            assumption !== 'Owner approval is required before this price is issued.' &&
            assumption !== 'Reviewed and approved by the business owner.',
        )
      : quote.assumptions;
  return (
    <article
      className={requestReceipt ? requestStyles.receipt : 'quote-card'}
      aria-label={requestReceipt ? 'Quote receipt' : undefined}
    >
      {!requestReceipt && (
        <div className="quote-card-brand">
          <span>
            {requestReceipt
              ? service?.name || 'Service request'
              : preview
                ? 'Private test'
                : owner
                  ? 'Customer quote'
                  : pending
                    ? 'Request received'
                    : 'Your quote'}
          </span>
          <Badge tone={pending ? '' : 'green'}>
            {preview
              ? 'Private test'
              : quote.status === 'review'
                ? 'Awaiting review'
                : quote.status.charAt(0).toUpperCase() + quote.status.slice(1)}
          </Badge>
        </div>
      )}
      {!requestReceipt && (
        <>
          <span className="eyebrow">{service?.name || 'Service request'}</span>
          <h2>
            {pending
              ? 'Request received'
              : quote.status === 'review'
                ? 'Draft quote'
                : 'Quote details'}
          </h2>
        </>
      )}
      {requestReceipt ? (
        <SubmittedProject
          quote={quote}
          noteLabel="Customer note"
          fallback={
            <>
              <h3 className={requestStyles.projectTitle}>Project details</h3>
              <p className="quote-description">{quote.description}</p>
            </>
          }
        />
      ) : (
        <p className="quote-description">{quote.description}</p>
      )}
      {pending ? (
        <div className="quote-pending">
          <Clock3 size={26} />
          <p>
            The business will review your details before issuing a price. Keep this page open to see
            the quote when it’s approved.
          </p>
        </div>
      ) : (
        <>
          <div className="quote-total">
            <span>
              {preview
                ? 'Calculated draft'
                : owner
                  ? quote.status === 'review'
                    ? 'Draft total'
                    : 'Approved total'
                  : 'Quote total'}
            </span>
            <strong>{money(quote.totalCents, quote.currency)}</strong>
          </div>
          <div className="quote-lines">
            {quote.lineItems.map((line, index) => (
              <div key={index}>
                <span>
                  {line.description}
                  {line.quantity !== 1 && (
                    <small>
                      {line.quantity} × {money(line.unitPriceCents, quote.currency)}
                    </small>
                  )}
                </span>
                <strong>{money(line.totalCents, quote.currency)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
      {assumptions.length > 0 && (
        <div className="quote-assumptions">
          <span>Assumptions</span>
          {assumptions.map((assumption, index) => (
            <p key={index}>{assumption}</p>
          ))}
        </div>
      )}
      <div className={requestReceipt ? requestStyles.receiptFooter : 'quote-card-footer'}>
        {preview
          ? 'A private test. No customer delivery or charge.'
          : owner
            ? quote.status === 'review'
              ? 'This draft needs your approval before it is issued.'
              : quote.status === 'accepted'
                ? 'The customer accepted this quote.'
                : quote.status === 'declined'
                  ? 'The customer declined this quote.'
                  : quote.issuedBy === 'automatic'
                    ? 'Issued automatically.'
                    : 'Issued by your business.'
            : pending
              ? 'Your request is with the business for review.'
              : 'Please contact the business to confirm next steps.'}
      </div>
    </article>
  );
}

function needsOwnerPrice(quote: Quote) {
  return quote.status === 'review' && quote.manualPriceRequired === true;
}

function Quotes({ data, refresh, notify }: Workspace) {
  const router = useRouter();
  const params = useSearchParams();
  const quoteQuery = params.get('quote') || '';
  const quoteId = ownerRequestIntent(params)?.quoteId || '';
  const filter = requestFilter(params.get('filter'));
  const cursor = params.get('cursor') || '';
  const pageKey = JSON.stringify([filter, cursor]);
  const currentPage = useRef({ filter, cursor, key: pageKey });
  currentPage.current = { filter, cursor, key: pageKey };
  const pageRead = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pageRead.current++;
    };
  }, []);
  const [inbox, setInbox] = useState<{
    key: string;
    page?: QuoteInboxPage;
    loading: boolean;
    error?: 'invalid' | 'failed';
  }>();
  const visibleInbox = inbox?.key === pageKey ? inbox : undefined;
  const page = visibleInbox?.page;
  const quotes = page?.quotes || [];
  const [storedSelection, setSelected] = useState<Quote>();
  const selected = storedSelection?.id === quoteId ? storedSelection : undefined;
  const [detailError, setDetailError] = useState<{ id: string; missing: boolean }>();
  const [detailAttempt, setDetailAttempt] = useState(0);
  const openingError = detailError?.id === quoteQuery ? detailError : undefined;
  const currentQuote = useRef(quoteId);
  currentQuote.current = quoteId;
  const openedFromList = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const requestHeading = useRef<HTMLHeadingElement>(null);
  const returnToRequest = useRef('');

  function closeRequest() {
    returnToRequest.current = quoteId;
    const inbox = ownerRequestUrl(undefined, filter, cursor);
    if (openedFromList.current === inbox) {
      openedFromList.current = null;
      router.back();
    } else router.replace(inbox, { scroll: false });
  }

  useEffect(() => {
    let active = true;
    setSelected(undefined);
    setDetailError(undefined);
    setError('');
    setAdjusting(false);
    if (!quoteQuery) return;
    if (!quoteId) {
      setDetailError({ id: quoteQuery, missing: true });
      return;
    }
    void api<Quote>(`/quotes/${encodeURIComponent(quoteId)}`)
      .then((quote) => {
        if (active) setSelected(quote);
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) {
          const target = currentDashboardLoginUrl();
          if (target) router.replace(target);
        } else
          setDetailError({
            id: quoteQuery,
            missing: cause instanceof ApiError && [400, 403, 404].includes(cause.status),
          });
      });
    return () => {
      active = false;
    };
  }, [quoteQuery, quoteId, detailAttempt, router]);
  useEffect(() => {
    if (selected) {
      returnToRequest.current = selected.id;
      requestHeading.current?.focus({ preventScroll: true });
      requestHeading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [selected?.id]);
  useEffect(() => {
    if (quoteQuery || !page || !returnToRequest.current) return;
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-request-id]'),
    ).find((item) => item.dataset.requestId === returnToRequest.current);
    if (button) {
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: 'nearest' });
    }
    returnToRequest.current = '';
  }, [quoteQuery, page]);
  const load = useCallback(
    async (targetId?: string) => {
      if (!mounted.current || (targetId && currentQuote.current !== targetId)) return;
      const context = currentPage.current;
      const sequence = ++pageRead.current;
      if (context.cursor && !validRequestCursor(context.cursor)) {
        setInbox({ key: context.key, loading: false, error: 'invalid' });
        return;
      }
      setInbox((previous) => ({
        key: context.key,
        page: previous?.key === context.key ? previous.page : undefined,
        loading: true,
      }));
      const query = new URLSearchParams({ filter: context.filter });
      if (context.cursor) query.set('cursor', context.cursor);
      try {
        const result = await api<QuoteInboxPage>(`/quotes/page?${query}`);
        if (
          mounted.current &&
          currentPage.current.key === context.key &&
          sequence === pageRead.current
        )
          setInbox({ key: context.key, page: result, loading: false });
      } catch (cause) {
        if (
          !mounted.current ||
          currentPage.current.key !== context.key ||
          sequence !== pageRead.current
        )
          return;
        if (cause instanceof ApiError && cause.status === 401) {
          const destination = currentDashboardLoginUrl();
          if (destination) router.replace(destination);
        } else
          setInbox((previous) => ({
            key: context.key,
            page:
              cause instanceof ApiError && cause.code === 'INVALID_CURSOR'
                ? undefined
                : previous?.key === context.key
                  ? previous.page
                  : undefined,
            loading: false,
            error:
              cause instanceof ApiError && cause.code === 'INVALID_CURSOR' ? 'invalid' : 'failed',
          }));
      }
    },
    [router],
  );
  useEffect(() => {
    void load();
    return () => {
      pageRead.current++;
    };
  }, [load, pageKey]);
  async function approve() {
    if (!mounted.current || !selected || busy) return;
    const targetId = selected.id;
    setBusy(true);
    setError('');
    try {
      const approved = await api<Quote>(`/quotes/${targetId}/approve`, { method: 'POST' });
      if (!mounted.current) return;
      if (currentQuote.current === approved.id) setSelected(approved);
      await load(targetId);
      if (!mounted.current || currentQuote.current !== targetId) return;
      await refresh();
      if (mounted.current && currentQuote.current === targetId) notify('Quote approved.');
    } catch (error) {
      if (mounted.current && currentQuote.current === targetId) setError(errorMessage(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const priceNeeded = selected ? needsOwnerPrice(selected) : false;
  const recoverPage =
    !!cursor &&
    !visibleInbox?.loading &&
    (visibleInbox?.error === 'invalid' || (!!page && !quotes.length));
  return (
    <div className={`${requestStyles.workspace} ${quoteQuery ? requestStyles.hasSelection : ''}`}>
      <section className={requestStyles.listPane} aria-label="Customer requests">
        <PageHeader title="Quote requests" />
        <div className={`filter-tabs ${requestStyles.filters}`}>
          {[
            { id: 'all', label: 'All requests' },
            { id: 'review', label: 'Needs review' },
            { id: 'issued', label: 'Issued' },
          ].map((tab) => (
            <button
              className={filter === tab.id ? 'active' : ''}
              aria-pressed={filter === tab.id}
              key={tab.id}
              onClick={() =>
                router.push(ownerRequestUrl(undefined, requestFilter(tab.id)), { scroll: false })
              }
            >
              {tab.id === 'all' ? (
                <>
                  All<span className="sr-only"> requests</span>
                </>
              ) : (
                tab.label
              )}{' '}
              <span className={requestStyles.count}>
                {page ? page.counts[requestFilter(tab.id)] : ''}
              </span>
            </button>
          ))}
        </div>
        {visibleInbox?.error && (
          <Notice kind="error">
            {visibleInbox.error === 'invalid'
              ? 'This request page isn’t available. Open your newest requests.'
              : 'Your requests could not be loaded. Please try again.'}
            {visibleInbox.error === 'failed' && (
              <button className="text-button" onClick={() => void load()}>
                Try again
              </button>
            )}
          </Notice>
        )}
        {!page && !visibleInbox?.error ? (
          <p className="quiet-loading" role="status">
            Loading your requests…
          </p>
        ) : quotes.length ? (
          <RequestList
            quotes={quotes}
            services={data.services}
            selectedId={quoteId}
            onSelect={(quote) => {
              setError('');
              openedFromList.current = ownerRequestUrl(undefined, filter, cursor);
              router.push(ownerRequestUrl(quote.id, filter, cursor), { scroll: false });
            }}
          />
        ) : (
          !visibleInbox?.error && (
            <EmptyState
              title={
                cursor
                  ? 'No requests on this page'
                  : filter === 'all'
                    ? 'No requests yet'
                    : 'No matching requests'
              }
            >
              {cursor
                ? 'Open your newest requests to continue.'
                : filter === 'all'
                  ? 'Share your quote link to receive customer requests here.'
                  : 'Choose another filter to see more requests.'}
            </EmptyState>
          )
        )}
        {(page?.newerCursor || page?.olderCursor || recoverPage) && (
          <nav className={requestStyles.pagination} aria-label="Request history">
            {page?.newerCursor && (
              <button
                className="text-button"
                disabled={visibleInbox?.loading}
                onClick={() => router.push(ownerRequestUrl(undefined, filter, page.newerCursor!))}
              >
                Newer requests
              </button>
            )}
            {page?.olderCursor && (
              <button
                className="text-button"
                disabled={visibleInbox?.loading}
                onClick={() => router.push(ownerRequestUrl(undefined, filter, page.olderCursor!))}
              >
                Older requests
              </button>
            )}
            {recoverPage && (
              <button
                className="text-button"
                onClick={() => router.push(ownerRequestUrl(undefined, filter))}
              >
                Newest requests
              </button>
            )}
          </nav>
        )}
      </section>

      <div className={requestStyles.detailPane}>
        {quoteQuery && !selected && (
          <div className={requestStyles.opening}>
            {openingError ? (
              <Notice kind="error">
                {openingError.missing
                  ? 'This request isn’t available in this account.'
                  : 'This request could not be loaded. Please try again.'}
                {!openingError.missing && (
                  <button
                    className="text-button"
                    onClick={() => setDetailAttempt((attempt) => attempt + 1)}
                  >
                    Try again
                  </button>
                )}
              </Notice>
            ) : (
              <p role="status">Opening this request…</p>
            )}
            <button className="text-button" onClick={closeRequest}>
              Back to requests
            </button>
          </div>
        )}

        {!quoteQuery && (
          <div className={requestStyles.noSelection}>
            <MessageSquare size={28} aria-hidden="true" />
            <h2>Choose a request</h2>
            <p>Read the conversation, ask a question, or review a price.</p>
          </div>
        )}
        {selected && (
          <section
            key={selected.id}
            className={requestStyles.selectedRequest}
            aria-label={
              priceNeeded
                ? 'Review request'
                : selected.status === 'review'
                  ? 'Review quote'
                  : 'Quote details'
            }
          >
            <header className={requestStyles.requestHeader}>
              <div className={requestStyles.headerTools}>
                <button
                  type="button"
                  className={`text-button ${requestStyles.back}`}
                  aria-label="Back to requests"
                  title="Back to requests"
                  onClick={closeRequest}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  <span className={requestStyles.backLabel}>Back to requests</span>
                </button>
                <a
                  className={requestStyles.projectJump}
                  href={`#request-project-${selected.id}`}
                  onClick={(event) => {
                    const project = document.getElementById(`request-project-${selected.id}`);
                    if (!project) return;
                    event.preventDefault();
                    project.focus({ preventScroll: true });
                    project.scrollIntoView({ block: 'start', behavior: 'instant' });
                  }}
                >
                  Project details
                </a>
              </div>
              <div className={requestStyles.identity}>
                <div className={requestStyles.identityLine}>
                  <h2 ref={requestHeading} tabIndex={-1}>
                    {selected.customerName || 'Customer request'}
                  </h2>
                  <span className={requestStyles.requestStatus}>
                    {priceNeeded
                      ? 'Price needed'
                      : selected.status === 'review'
                        ? 'Awaiting approval'
                        : selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                  </span>
                </div>
                <p className={requestStyles.customerEmail}>
                  <span>{selected.customerEmail}</span>
                  <span>
                    {data.services.find((item) => item.id === selected.serviceId)?.name ||
                      'Service request'}
                  </span>
                </p>
              </div>
            </header>
            <QuoteContext
              key={selected.id}
              quoteId={selected.id}
              closed={selected.status === 'accepted' || selected.status === 'declined'}
              hideReply={adjusting}
              project={
                <>
                  {priceNeeded ? (
                    <section className={requestStyles.details} aria-label="Customer project">
                      <SubmittedProject
                        quote={selected}
                        noteLabel="Customer note"
                        fallback={
                          <>
                            <h3 className={requestStyles.projectTitle}>Project details</h3>
                            <p>{selected.description}</p>
                          </>
                        }
                      />
                    </section>
                  ) : (
                    <QuoteCard
                      quote={selected}
                      service={data.services.find((service) => service.id === selected.serviceId)}
                      owner
                      presentation="request"
                    />
                  )}
                </>
              }
              actions={
                <>
                  {selected.status === 'review' && (
                    <div>
                      <QuoteAdjustment
                        key={selected.id}
                        quote={selected}
                        onEditingChange={setAdjusting}
                        onSaved={async (revised) => {
                          if (!mounted.current || currentQuote.current !== revised.id) return;
                          setSelected(revised);
                          await load(revised.id);
                          if (!mounted.current || currentQuote.current !== revised.id) return;
                          await refresh();
                          if (!mounted.current || currentQuote.current !== revised.id) return;
                          notify(
                            priceNeeded
                              ? 'Price saved. Review it before approving.'
                              : 'Revised draft saved. Review the final total before approving.',
                          );
                        }}
                      />
                      {!priceNeeded && (
                        <div className={requestStyles.approval} hidden={adjusting}>
                          <Button
                            className="full-width"
                            loading={busy}
                            disabled={adjusting || selected.manualPriceRequired === true}
                            onClick={() => void approve()}
                          >
                            Approve this quote
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {error && <Notice kind="error">{error}</Notice>}
                </>
              }
            />
          </section>
        )}
      </div>
    </div>
  );
}

function RequestList({
  quotes,
  services,
  selectedId,
  onSelect,
}: {
  quotes: Quote[];
  services: Service[];
  selectedId: string;
  onSelect: (quote: Quote) => void;
}) {
  return (
    <ul className={requestStyles.list}>
      {quotes.map((quote) => {
        const missingPrice = needsOwnerPrice(quote);
        const action =
          quote.status === 'review'
            ? missingPrice
              ? 'Review request'
              : 'Review quote'
            : 'View quote';
        const status =
          quote.status === 'review'
            ? missingPrice
              ? 'Needs your response'
              : 'Awaiting approval'
            : quote.status.charAt(0).toUpperCase() + quote.status.slice(1);
        return (
          <li key={quote.id}>
            <button
              type="button"
              className={requestStyles.row}
              data-request-id={quote.id}
              aria-current={selectedId === quote.id ? 'true' : undefined}
              aria-label={`${action} for ${quote.customerName || 'Customer request'}`}
              onClick={() => onSelect(quote)}
            >
              <span className={requestStyles.rowTop}>
                <strong>{quote.customerName || 'Customer request'}</strong>
                <span className={requestStyles.price}>
                  {!missingPrice && (
                    <small>{quote.status === 'review' ? 'Draft price' : 'Quote price'}</small>
                  )}
                  <strong>
                    {missingPrice ? 'Price needed' : money(quote.totalCents, quote.currency)}
                  </strong>
                </span>
              </span>
              <span className={requestStyles.service}>
                {services.find((service) => service.id === quote.serviceId)?.name ||
                  'Service request'}
              </span>
              <span className={requestStyles.scope}>{quote.description}</span>
              <span className={requestStyles.rowBottom}>
                <span className={requestStyles.meta}>
                  <span>{status}</span>
                  <time dateTime={quote.createdAt}>{shortDate(quote.createdAt)}</time>
                </span>
                <span className={requestStyles.open}>{action}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EvaluationResults({ evaluation }: { evaluation: Evaluation }) {
  return (
    <div className="evaluation-results">
      <div className={`evaluation-banner ${evaluation.passed ? 'passed' : 'failed'}`}>
        <span>{evaluation.passed ? <CircleCheck size={20} /> : <Clock3 size={20} />}</span>
        <div>
          <strong>
            {evaluation.passed
              ? 'The configured checks passed.'
              : 'A few things need your attention.'}
          </strong>
          <small>Checked {shortDate(evaluation.evaluatedAt)} · Current pricing version</small>
        </div>
      </div>
      <div className="evaluation-checks">
        {evaluation.checks.map((check, index) => (
          <div key={index}>
            <span className={check.passed ? 'check-pass' : 'check-fail'}>
              {check.passed ? <Check size={15} /> : <X size={15} />}
            </span>
            <div>
              <strong>{check.name}</strong>
              <p>{check.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {evaluation.cases.length > 0 && (
        <details className="evaluation-cases">
          <summary>
            {evaluation.cases.length} saved-example comparison
            {evaluation.cases.length === 1 ? '' : 's'}
            <ChevronDown size={14} />
          </summary>
          {evaluation.cases.map((item, index) => (
            <div key={index}>
              <span>
                {item.title}
                <small>
                  Owner: {money(item.expectedCents)} · Formula: {money(item.actualCents)}
                </small>
              </span>
              <Badge tone={item.passed ? 'green' : 'amber'}>
                {item.passed ? 'Within tolerance' : 'Review difference'}
              </Badge>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function BillingView({ data, user, notify }: Workspace) {
  return (
    <>
      <PageHeader title="Billing & usage" />
      <div className="quote-summary">
        <Stat
          label="Quote requests"
          value={data.stats.totalQuotes}
          icon={<MessageSquare size={18} />}
          foot="All-time customer quote requests"
        />
        <Stat
          label="Billable deliveries"
          value={data.usage.billableQuotes}
          icon={<CircleDollarSign size={18} />}
          foot="Qualified automatic deliveries beyond trial"
        />
        <Stat
          label="AI calls"
          value={data.usage.aiCalls}
          icon={<MessageSquare size={18} />}
          foot="Workspace activity across all workflows"
        />
      </div>
      <BillingPanel notify={notify} emailVerified={user.emailVerified} />
    </>
  );
}

function WorkspaceSettings({ data, settings, user, refresh, notify }: Workspace) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<{
    billableQuotes: number;
    aiCalls: number;
    events: unknown[];
  }>();
  useEffect(() => {
    api<{ billableQuotes: number; aiCalls: number; events: unknown[] }>('/usage')
      .then(setUsage)
      .catch((error) => setError(errorMessage(error)));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api('/business', {
        method: 'PATCH',
        ...json(Object.fromEntries(new FormData(event.currentTarget))),
      });
      await refresh();
      notify('Your business details have been updated.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <PageHeader title="Business settings" />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="settings-layout">
        <section className="panel settings-form">
          <div className="panel-heading">
            <div>
              <h3>Business profile</h3>
            </div>
            <Building2 size={21} />
          </div>
          <form onSubmit={submit}>
            <Field
              label="Business name"
              name="name"
              defaultValue={data.business.name}
              required
              maxLength={160}
            />
            <Field
              label="Industry"
              name="industry"
              defaultValue={data.business.industry}
              maxLength={120}
            />
            <TextArea
              label="Business description"
              name="description"
              defaultValue={data.business.description}
              maxLength={2000}
            />
            <Field
              label="Service area"
              name="serviceArea"
              defaultValue={data.business.serviceArea}
              maxLength={500}
            />
            <Field
              label="Workspace address"
              value={data.business.slug}
              readOnly
              hint="Part of your public quote link."
            />
            <div className="settings-account">
              <span>Account owner</span>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
            <Button type="submit" loading={loading}>
              Save business details <Check size={16} />
            </Button>
          </form>
        </section>
        <div className="settings-side">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h3>Your usage</h3>
              </div>
              <BarChart3 size={21} />
            </div>
            <div className="usage-row">
              <span>AI calls</span>
              <strong>{usage?.aiCalls ?? data.usage.aiCalls}</strong>
            </div>
            <div className="usage-row">
              <span>Billable quotes</span>
              <strong>{usage?.billableQuotes ?? data.usage.billableQuotes}</strong>
            </div>
            <div className="usage-row">
              <span>Practice & teaching</span>
              <Badge tone="green">Free</Badge>
            </div>
            <Notice>
              {settings.billingConfigured
                ? 'Delivery fees apply to eligible automatic quotes.'
                : 'Paid delivery is unavailable. Check Billing for your trial allowance.'}
            </Notice>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h3>Assistant connections</h3>
              </div>
            </div>
            <div className="connection-row">
              <span>OpenAI</span>
              <Badge tone={settings.providers.openai ? 'green' : ''}>
                {settings.providers.openai ? 'Connected' : 'Not configured'}
              </Badge>
            </div>
            <div className="connection-row">
              <span>Anthropic</span>
              <Badge tone={settings.providers.anthropic ? 'green' : ''}>
                {settings.providers.anthropic ? 'Connected' : 'Not configured'}
              </Badge>
            </div>
            <Notice>
              {settings.aiMode === 'live'
                ? 'Live AI is enabled.'
                : 'Demo mode is active. Practice replies use scripted scenarios.'}
            </Notice>
          </section>
        </div>
      </div>
      <div className="account-commerce-grid account-only">
        <AccountPanel user={user} business={data.business} refresh={refresh} notify={notify} />
      </div>
    </>
  );
}

function CsvImport({
  services,
  onClose,
  onSaved,
}: {
  services: Service[];
  onClose: () => void;
  onSaved: (count: number) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('csv') as File;
    if (!file?.size) {
      setError('Choose a CSV file to import.');
      return;
    }
    if (file.size > 256 * 1024) {
      setError('Choose a CSV file smaller than 256 KB.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api<{ imported: number }>(
        `/examples/import?serviceId=${encodeURIComponent(String(form.get('serviceId')))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: await file.text(),
        },
      );
      await onSaved(result.imported);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal
      title="Import past jobs"
      subtitle="Import up to 100 projects for one service. All rows are checked before anything is saved."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Select label="Service" name="serviceId" required>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </Select>
        <label className="field">
          <span>Project CSV file</span>
          <input type="file" name="csv" accept=".csv,text/csv" required />
          <small>
            Required columns: title, description, quantity, finalPrice, rationale. Prices are in
            dollars.
          </small>
        </label>
        <a className="text-link" href="/examples-template.csv" download>
          Download the example template <ArrowUpRight size={15} />
        </a>
        <Notice>
          Use current, representative pricing. Remove customer names, addresses, and other personal
          details before importing.
        </Notice>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Import projects <ArrowUpRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function QuoteContext({
  quoteId,
  closed = false,
  hideReply,
  project,
  actions,
}: {
  quoteId: string;
  closed?: boolean;
  hideReply: boolean;
  project: ReactNode;
  actions: ReactNode;
}) {
  const [photos, setPhotos] = useState<{ id: string; filename: string; url: string }[]>([]);
  const [messages, setMessages] = useState<
    { id: string; role: string; content: string; author?: string }[]
  >([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [photoError, setPhotoError] = useState('');
  const [conversationError, setConversationError] = useState('');
  const [photoAttempt, setPhotoAttempt] = useState(0);
  const [conversationAttempt, setConversationAttempt] = useState(0);
  const [error, setError] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const replyFlight = useRef(false);
  const conversationRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    setPhotoError('');
    void api<{ id: string; filename: string; url: string }[]>(`/quotes/${quoteId}/photos`)
      .then((photos) => {
        if (active) setPhotos(photos);
      })
      .catch((cause) => {
        if (active) setPhotoError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [quoteId, photoAttempt]);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    setLoading(true);
    setConversationError('');
    const revision = conversationRevision.current;
    void api<typeof messages>(`/quotes/${quoteId}/conversation`)
      .then((messages) => {
        if (active && revision === conversationRevision.current) setMessages(messages);
      })
      .catch((cause) => {
        if (active) setConversationError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const timer = setInterval(() => {
      if (replyFlight.current) return;
      const revision = conversationRevision.current;
      void api<typeof messages>(`/quotes/${quoteId}/conversation`)
        .then((messages) => {
          if (active && revision === conversationRevision.current) setMessages(messages);
        })
        .catch(() => {});
    }, 8000);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [quoteId, conversationAttempt]);
  useEffect(() => {
    if (following.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages.at(-1)?.id]);
  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (replyFlight.current || !reply.trim()) return;
    replyFlight.current = true;
    conversationRevision.current += 1;
    following.current = true;
    setSending(true);
    setError('');
    try {
      const result = await api<{ messages: typeof messages }>(`/quotes/${quoteId}/messages`, {
        method: 'POST',
        ...json({ content: reply.trim() }),
      });
      if (!mounted.current) return;
      setMessages(result.messages);
      setReply('');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      replyFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }
  return (
    <div className={requestStyles.requestBody}>
      <section className={requestStyles.threadPane} aria-label="Request conversation">
        <h3 className={requestStyles.threadTitle}>Conversation</h3>
        {error && <Notice kind="error">{error}</Notice>}
        {conversationError && (
          <Notice kind="error">
            {conversationError}
            <button
              type="button"
              className="text-button"
              onClick={() => setConversationAttempt((value) => value + 1)}
            >
              Reload conversation
            </button>
          </Notice>
        )}
        <div
          className={`qf-thread ${requestStyles.conversation}`}
          role="log"
          aria-label="Customer conversation"
          aria-live="polite"
          ref={thread}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop < 80;
          }}
        >
          {loading && <p role="status">Opening conversation…</p>}
          {messages.map((message) => (
            <article
              key={message.id}
              data-message-id={message.id}
              className={`qf-message ${message.author === 'owner' ? 'qf-message--outgoing' : ''}`}
            >
              <div className="qf-message-body">
                <span className="qf-message-author">
                  {message.role === 'user'
                    ? 'Customer'
                    : message.author === 'owner'
                      ? 'You'
                      : 'Assistant'}
                </span>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
        </div>
        {!closed && (
          <div className={requestStyles.reply} hidden={hideReply}>
            <form className="qf-composer" onSubmit={sendReply}>
              <label className="sr-only" htmlFor="owner-request-reply">
                Reply directly to the customer
              </label>
              <textarea
                id="owner-request-reply"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                required
                maxLength={5000}
                rows={2}
                placeholder="Ask what you need to know…"
                disabled={sending}
              />
              <div className="qf-composer-actions">
                <p className={requestStyles.hint}>
                  Sending stops automatic replies for this request.
                </p>
                <Button
                  variant="secondary"
                  type="submit"
                  loading={sending}
                  disabled={!reply.trim()}
                >
                  Send reply
                </Button>
              </div>
            </form>
          </div>
        )}
      </section>
      <aside
        id={`request-project-${quoteId}`}
        tabIndex={-1}
        className={requestStyles.projectPane}
        aria-label="Request details"
      >
        {project}
        {(photos.length > 0 || photoError) && (
          <section className={requestStyles.photos} aria-label="Customer project photos">
            <h3>Project photos</h3>
            {photoError && (
              <Notice kind="error">
                {photoError}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setPhotoAttempt((value) => value + 1)}
                >
                  Retry photos
                </button>
              </Notice>
            )}
            <div className={requestStyles.photoGrid}>
              {photos.map((photo) => (
                <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
                  <img src={photo.url} alt={`Customer project: ${photo.filename}`} />
                  <span>{photo.filename}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </aside>
      <div className={requestStyles.pricingPane}>{actions}</div>
    </div>
  );
}

function QuoteAdjustment({
  quote,
  onEditingChange,
  onSaved,
}: {
  quote: Quote;
  onEditingChange: (editing: boolean) => void;
  onSaved: (quote: Quote) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const missingPrice = needsOwnerPrice(quote);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onEditingChange(false);
    };
  }, [onEditingChange]);
  function edit(value: boolean) {
    setEditing(value);
    onEditingChange(value);
    setError('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const revised = await api<Quote>(`/quotes/${quote.id}`, {
        method: 'PATCH',
        ...json({
          totalCents: cents(String(form.get('price'))),
          reason: form.get('reason'),
        }),
      });
      if (!mounted.current) return;
      await onSaved(revised);
      if (mounted.current) edit(false);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <section className={requestStyles.pricing}>
      {!editing ? (
        <Button variant={missingPrice ? 'primary' : 'secondary'} onClick={() => edit(true)}>
          {missingPrice ? 'Set a price' : 'Adjust draft price'}
        </Button>
      ) : (
        <form onSubmit={submit}>
          <h3>{missingPrice ? 'Set a price' : 'Revise draft price'}</h3>
          <p>
            {missingPrice
              ? 'Saving creates a draft. You approve it separately.'
              : 'Save your revision before approving the quote. Your reason stays private.'}
          </p>
          <Field
            label={missingPrice ? 'Quote total ($)' : 'Revised quote total ($)'}
            name="price"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={missingPrice ? '' : dollars(quote.totalCents)}
            disabled={loading}
          />
          <TextArea
            label={
              missingPrice ? 'Private reason for this price' : 'Internal reason for the adjustment'
            }
            name="reason"
            required
            placeholder="Explain how you set this price…"
            maxLength={2000}
            disabled={loading}
          />
          {error && <Notice kind="error">{error}</Notice>}
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={() => edit(false)} disabled={loading}>
              {missingPrice ? 'Cancel' : 'Cancel revision'}
            </Button>
            <Button type="submit" loading={loading}>
              {missingPrice ? 'Save price' : 'Save revised draft'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
