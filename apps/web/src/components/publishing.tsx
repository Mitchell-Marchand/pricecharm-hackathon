'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { ApiError, api, cents, errorMessage, json, money, shortDate } from '@/lib/api';
import type {
  Billing,
  Dashboard,
  Evaluation,
  Service,
  ServiceReadiness,
  TestCase,
  User,
} from '@/lib/types';
import { Button, Field, Notice, Select, TextArea } from './ui';

type Props = {
  data: Dashboard;
  user: User;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  automaticOnly?: boolean;
  serviceId?: string;
  onReadinessChange?: (value: ServiceReadiness | undefined) => void;
};

type Requirement = { title: string; detail: string; href: string; action: string };

// Keep these aliases identical to the backend's samePricingUnit readiness check.
function samePricingUnit(left: string, right: string) {
  const key = (value: string) =>
    value
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/square (?:feet|foot)|sq\.?\s*ft\.?|sqft/g, 'sqft')
      .replace(/\b(?:jobs?|projects?)\b/g, 'project')
      .replace(/\b(?:hours?|hrs?)\b/g, 'hour')
      .replace(/\b(?:feet|foot)\b/g, 'foot')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .replace(/(?<!s)s$/, '');
  return key(left) === key(right);
}

export default function Publishing({
  data,
  user,
  refresh,
  notify,
  automaticOnly = false,
  serviceId: chosenServiceId,
  onReadinessChange,
}: Props) {
  const [selectedId, setSelectedId] = useState(chosenServiceId || data.services[0]?.id || '');
  const serviceId = chosenServiceId || selectedId;
  const service = data.services.find((item) => item.id === serviceId);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [loadingCases, setLoadingCases] = useState(true);
  const [readiness, setReadiness] = useState<ServiceReadiness>();
  const [loadingReadiness, setLoadingReadiness] = useState(true);
  const [readinessError, setReadinessError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingLimit, setEditingLimit] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [approved, setApproved] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<{ delivery: string; devToken?: string }>();
  const [billing, setBilling] = useState<Billing>();
  const [billingError, setBillingError] = useState('');
  const [origin, setOrigin] = useState('');
  const [shareTab, setShareTab] = useState<'link' | 'iframe' | 'script'>('link');
  const working = useRef(false);
  const readinessRequest = useRef(0);
  const contextKey = `${serviceId}:${service?.version || 0}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    if (!selectedId && data.services[0]) setSelectedId(data.services[0].id);
  }, [data.services, selectedId]);
  useEffect(() => {
    setReadiness(undefined);
    setApproved(false);
  }, [serviceId, service?.version]);
  useEffect(() => {
    setAdding(false);
    setEditingLimit(false);
    setToolsOpen(false);
  }, [serviceId]);

  const loadReadiness = useCallback(
    async (signal?: AbortSignal) => {
      if (currentContext.current !== contextKey) return;
      const request = ++readinessRequest.current;
      if (!serviceId) {
        setLoadingReadiness(false);
        return;
      }
      setLoadingReadiness(true);
      setReadinessError('');
      setApproved(false);
      try {
        const result = await api<ServiceReadiness>(
          `/services/${encodeURIComponent(serviceId)}/readiness`,
          { signal },
        );
        if (
          !signal?.aborted &&
          currentContext.current === contextKey &&
          request === readinessRequest.current
        ) {
          setReadiness(result);
          return result;
        }
      } catch (cause) {
        if (
          !signal?.aborted &&
          currentContext.current === contextKey &&
          request === readinessRequest.current
        )
          setReadinessError(errorMessage(cause));
      } finally {
        if (
          !signal?.aborted &&
          currentContext.current === contextKey &&
          request === readinessRequest.current
        )
          setLoadingReadiness(false);
      }
    },
    [
      serviceId,
      contextKey,
      service?.mode,
      service?.publishedAt,
      service?.approvedVersion,
      data.business.autoQuoteEnabled,
    ],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadReadiness(controller.signal);
    return () => controller.abort();
  }, [loadReadiness]);

  const loadCases = useCallback(async () => {
    if (!serviceId) {
      setLoadingCases(false);
      return;
    }
    setLoadingCases(true);
    try {
      setCases(await api<TestCase[]>('/services/' + serviceId + '/test-cases'));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingCases(false);
    }
  }, [serviceId]);
  useEffect(() => {
    let active = true;
    setCases([]);
    setLoadingCases(true);
    if (!serviceId) {
      setLoadingCases(false);
      return;
    }
    api<TestCase[]>('/services/' + serviceId + '/test-cases')
      .then((result) => {
        if (active) setCases(result);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoadingCases(false);
      });
    return () => {
      active = false;
    };
  }, [serviceId]);
  const loadBilling = useCallback(async () => {
    setBillingError('');
    try {
      setBilling(await api<Billing>('/billing'));
    } catch (cause) {
      setBillingError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  async function act(name: string, action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(name);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) await refresh();
    } finally {
      working.current = false;
      setBusy('');
    }
  }
  async function evaluate() {
    if (!service) return;
    await act('evaluate', async () => {
      setApproved(false);
      setToolsOpen(false);
      readinessRequest.current += 1;
      setReadiness(undefined);
      try {
        await api<Evaluation>('/services/' + service.id + '/evaluate', { method: 'POST' });
      } catch {
        if (currentContext.current !== contextKey) return;
        const saved = await loadReadiness();
        if (currentContext.current !== contextKey) return;
        if (saved?.evaluationCurrent) {
          await loadBilling();
          notify('Your saved checks are available. Review the results before approving.');
          return;
        }
        throw new Error(
          saved
            ? 'We couldn’t find a current saved result. Review the previous results or choose to run the checks again.'
            : 'We couldn’t confirm whether the checks finished. Load your saved checks before trying again.',
        );
      }
      if (currentContext.current !== contextKey) return;
      await loadReadiness();
      await loadBilling();
    });
  }
  async function saveLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!service) return;
    const form = new FormData(event.currentTarget);
    const nextLimit = cents(String(form.get('maximum')));
    await act('limit', async () => {
      const updated = await api<Service>('/services/' + service.id, {
        method: 'PATCH',
        ...json({ maxAutoQuoteCents: nextLimit, expectedVersion: service.version }),
      });
      if (updated.version === service.version) {
        setEditingLimit(false);
        notify('Quote limit unchanged. Your saved checks are still available.');
        return;
      }
      setReadiness(undefined);
      setApproved(false);
      setEditingLimit(false);
      await refresh();
      notify('Quote limit saved. Run the checks before turning on automatic quotes.');
    });
  }
  async function activate() {
    if (!service || !canActivate) return;
    await act('activate', async () => {
      await api('/services/' + service.id + '/publish', {
        method: 'POST',
        ...json({ mode: 'automatic', approveAutomatic: true }),
      });
      try {
        await api('/business', { method: 'PATCH', ...json({ autoQuoteEnabled: true }) });
      } catch (cause) {
        await refresh();
        throw new Error(
          'Your pricing was approved, but automatic quoting is still paused. ' +
            errorMessage(cause),
        );
      }
      setReviewing(false);
      setApproved(false);
      await refresh();
      notify(
        'Automatic quotes are active. Requests outside your approved scope still come to you.',
      );
    });
  }
  async function toggleAutomation() {
    await act('automation', async () => {
      const enabled = !data.business.autoQuoteEnabled;
      await api('/business', { method: 'PATCH', ...json({ autoQuoteEnabled: enabled }) });
      await refresh();
      notify(
        enabled
          ? 'Automatic issuing enabled for approved services.'
          : 'Automatic issuing paused across your workspace.',
      );
    });
  }
  async function remove(id: string) {
    await act('remove:' + id, async () => {
      await api('/services/' + serviceId + '/test-cases/' + id, { method: 'DELETE' });
      setReadiness(undefined);
      setApproved(false);
      await loadCases();
      await refresh();
    });
  }
  async function requestVerification() {
    await act('verify', async () => {
      const result = await api<{ delivery: string; devToken?: string }>(
        '/auth/request-verification',
        { method: 'POST' },
      );
      setVerification(result);
      notify(
        result.delivery === 'local'
          ? 'Local development verification link is ready.'
          : 'Verification email queued. Check your inbox.',
      );
    });
  }
  async function publishReview() {
    if (!service) return;
    await act('review', async () => {
      await api('/services/' + service.id + '/publish', {
        method: 'POST',
        ...json({ mode: 'review' }),
      });
      await refresh();
      notify('Your link is live. You approve every price.');
    });
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify('Copied.');
    } catch {
      setError('Select the text below and copy it. Clipboard access is unavailable.');
    }
  }

  const serviceExamples = data.examples.filter((item) => item.serviceId === serviceId);
  const examples = serviceExamples.filter(
    (item) => !item.unitLabel || (!!service && samePricingUnit(item.unitLabel, service.unitLabel)),
  );
  const olderUnitCount = serviceExamples.length - examples.length;
  const pricedCases = cases.filter((item) => item.expectedOutcome === 'quote').length;
  const reviewCases = cases.filter((item) => item.expectedOutcome === 'review').length;
  const enoughCases = pricedCases >= 3 && reviewCases >= 1;
  const hasPricing =
    !!service && service.unitPriceCents + service.basePriceCents + service.minimumChargeCents > 0;
  const requirements: Requirement[] = [];
  if (!data.business.description.trim() || !data.business.serviceArea.trim())
    requirements.push({
      title: 'Confirm where you work.',
      detail:
        'Your assistant needs your business description and service area to know which requests you can take.',
      href: '/dashboard/settings',
      action: 'Update business details',
    });
  if (!service?.description.trim() || !service.requiredInputs.length)
    requirements.push({
      title: 'Choose the details a customer must provide.',
      detail:
        'Save the service scope and at least one required customer detail before testing automatic quotes.',
      href: '/dashboard/services',
      action: 'Review service details',
    });
  if (!hasPricing)
    requirements.push({
      title: 'Save the pricing you want it to use.',
      detail:
        'Teach more jobs or review a suggested pricing approach before asking it to quote automatically.',
      href: '/dashboard?service=' + serviceId,
      action: 'Continue teaching',
    });
  if (examples.length < 3)
    requirements.push({
      title: 'Add a few more jobs you have priced.',
      detail:
        examples.length +
        ' of 3 required teaching examples support the current pricing unit (' +
        (service?.unitLabel || 'unit') +
        '). Tests below stay separate from these jobs.',
      href: '/dashboard?service=' + serviceId,
      action: 'Add another job',
    });
  const requirement = requirements[0];
  const matchingReadiness =
    readiness?.serviceId === serviceId && readiness.serviceVersion === service?.version
      ? readiness
      : undefined;
  const approvedPolicy =
    !!service?.publishedAt &&
    service.mode === 'automatic' &&
    service.approvedVersion === service.version &&
    matchingReadiness?.approvalCurrent === true;
  const currentEvaluation = matchingReadiness?.evaluationCurrent
    ? matchingReadiness.evaluation
    : undefined;
  const staleEvaluation =
    matchingReadiness?.evaluation && !matchingReadiness.evaluationCurrent
      ? matchingReadiness.evaluation
      : undefined;
  const ready = !!currentEvaluation?.automaticReady;
  const canActivate =
    ready &&
    approved &&
    user.emailVerified &&
    billing?.canIssue === true &&
    !billingError &&
    !adding &&
    !editingLimit &&
    !busy &&
    !loadingReadiness &&
    !readinessError;
  useEffect(() => {
    onReadinessChange?.(!loadingReadiness && !readinessError ? matchingReadiness : undefined);
    return () => onReadinessChange?.(undefined);
  }, [onReadinessChange, matchingReadiness, loadingReadiness, readinessError]);
  const link = origin + '/q/' + data.business.slug;
  const embed =
    shareTab === 'iframe'
      ? '<iframe src="' +
        origin +
        '/embed/' +
        data.business.slug +
        '" title="Request a quote" width="100%" height="740" style="border:0;border-radius:8px" loading="lazy"></iframe>'
      : '<script src="' +
        origin +
        '/embed.js" data-quotient="' +
        data.business.slug +
        '" defer></script>';

  return (
    <section
      className={'automation-flow' + (automaticOnly ? ' is-contextual' : '')}
      aria-label="Automatic quote setup"
    >
      {!automaticOnly && (
        <header className="automation-heading">
          <h1>Share your assistant.</h1>
          <p>Start with requests you review. Turn on automatic quotes when the tests support it.</p>
        </header>
      )}
      {!automaticOnly && !chosenServiceId && data.services.length > 1 && (
        <Select
          label="Service to validate"
          value={serviceId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {data.services.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {!service ? (
        <div className="automation-task">
          <h2>Start with one job.</h2>
          <p>Teach your assistant about your work before setting up automatic quotes.</p>
          <a className="automation-action-link" href="/dashboard">
            Open your assistant →
          </a>
        </div>
      ) : (
        <>
          {!automaticOnly && (
            <section className="automation-review-link">
              <div>
                <h2>A link you can use now.</h2>
                <p>
                  {service.publishedAt && service.mode === 'automatic'
                    ? !matchingReadiness || loadingReadiness || readinessError
                      ? 'Customers can describe the job through this link.'
                      : approvedPolicy &&
                          matchingReadiness.autoQuoteEnabled &&
                          data.business.autoQuoteEnabled
                        ? 'Approved eligible requests can receive automatic quotes. Everything else comes to you.'
                        : approvedPolicy
                          ? 'Automatic quotes are paused. Requests come to you for review.'
                          : 'Automatic quotes need current checks and approval. Customers can still send requests.'
                    : 'The assistant gathers the job details. You approve every price before it reaches the customer.'}
                </p>
              </div>
              {service.publishedAt ? (
                <>
                  <div className="automation-share-tabs">
                    {(['link', 'iframe', 'script'] as const).map((tab) => (
                      <button
                        type="button"
                        key={tab}
                        className={shareTab === tab ? 'active' : ''}
                        onClick={() => setShareTab(tab)}
                      >
                        {tab === 'link' ? 'Link' : tab === 'iframe' ? 'Iframe' : 'Widget'}
                      </button>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor="automatic-share-code">
                    {shareTab === 'link' ? 'Your public quote link' : 'Website embed code'}
                  </label>
                  <textarea
                    id="automatic-share-code"
                    readOnly
                    value={shareTab === 'link' ? link : embed}
                    rows={shareTab === 'link' ? 1 : 4}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <div className="automation-inline-actions">
                    <Button
                      variant="secondary"
                      onClick={() => void copy(shareTab === 'link' ? link : embed)}
                    >
                      <Copy size={14} />
                      Copy {shareTab === 'link' ? 'link' : 'embed code'}
                    </Button>
                    <a href={link} target="_blank" rel="noreferrer">
                      Open customer view <ExternalLink size={13} />
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <Button
                    loading={busy === 'review'}
                    disabled={
                      !!busy ||
                      !data.business.description.trim() ||
                      !data.business.serviceArea.trim() ||
                      !service.description.trim()
                    }
                    onClick={() => void publishReview()}
                  >
                    Publish with owner review
                  </Button>
                  {(!data.business.description.trim() || !data.business.serviceArea.trim()) && (
                    <a className="automation-action-link" href="/dashboard/settings">
                      Add your business description and service area →
                    </a>
                  )}
                </>
              )}
            </section>
          )}

          <header className="automation-section-heading">
            <div>
              <h2>Automatic quotes</h2>
            </div>
          </header>
          {loadingReadiness && (
            <p className="quiet-loading" role="status">
              Loading saved checks…
            </p>
          )}
          {readinessError && (
            <div className="automation-blocker" role="alert">
              <p>We couldn’t load your saved checks. {readinessError}</p>
              <button
                className="text-button"
                disabled={!!busy || loadingReadiness}
                onClick={() => {
                  setError('');
                  void loadReadiness();
                }}
              >
                Load saved checks again
              </button>
            </div>
          )}
          {readiness && !matchingReadiness && (
            <div className="automation-blocker">
              <p>Your service settings changed. Load the latest settings before continuing.</p>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void act('refresh', refresh)}
              >
                Load latest settings
              </button>
            </div>
          )}
          {staleEvaluation && (
            <section className="automation-blocker" aria-label="Previous checks need updating">
              <p>
                {matchingReadiness?.invalidation === 'model_changed'
                  ? 'The assistant’s model changed since these checks. Run them again before approving automatic quotes.'
                  : matchingReadiness?.invalidation === 'engine_changed'
                    ? 'The quote checks changed. Run them again before approving automatic quotes.'
                    : 'Your pricing, quote limit, or test jobs changed. Run the checks again before approving automatic quotes.'}
              </p>
              <details className="automation-detail">
                <summary>
                  Previous check results <ChevronDown size={13} />
                </summary>
                <ReadinessResults value={staleEvaluation} stale />
              </details>
            </section>
          )}
          {olderUnitCount > 0 && (
            <p className="automation-small">
              {olderUnitCount} older {olderUnitCount === 1 ? 'job stays' : 'jobs stay'} saved in
              their original units. They do not support pricing checks for the current unit,{' '}
              {service.unitLabel}.
            </p>
          )}
          {(data.business.autoQuoteEnabled || approvedPolicy) && (
            <section className="automation-live">
              <div>
                <strong>
                  {data.business.autoQuoteEnabled
                    ? 'Automatic quoting is enabled.'
                    : 'Automatic quoting is paused.'}
                </strong>
                <p>
                  {approvedPolicy
                    ? service.name + ' has an approved policy.'
                    : 'Only services with current approval can issue prices.'}{' '}
                  Missing details and unusual requests still come to you.
                </p>
              </div>
              <Button
                variant="secondary"
                loading={busy === 'automation'}
                disabled={!!busy || (!data.business.autoQuoteEnabled && !approvedPolicy)}
                onClick={() => void toggleAutomation()}
              >
                {data.business.autoQuoteEnabled
                  ? 'Pause automatic quotes'
                  : 'Enable automatic quotes'}
              </Button>
            </section>
          )}

          {approvedPolicy && !reviewing ? (
            <div className="automation-approved">
              <Check size={18} />
              <div>
                <strong>Approved for quotes up to {money(service.maxAutoQuoteCents)}.</strong>
                <p>
                  Changing pricing, examples, tests, or this limit requires a new evaluation and
                  approval.
                </p>
              </div>
              <button className="text-button" onClick={() => setReviewing(true)}>
                Review tests and settings
              </button>
            </div>
          ) : (
            <>
              {requirement ? (
                <section className="automation-task">
                  <span className="automation-task-label">Before testing</span>
                  <h3>{requirement.title}</h3>
                  <p>{requirement.detail}</p>
                  <a className="automation-action-link" href={requirement.href}>
                    {requirement.action} →
                  </a>
                  {requirements.length > 1 && (
                    <details className="automation-detail">
                      <summary>
                        {requirements.length - 1} other{' '}
                        {requirements.length === 2 ? 'requirement' : 'requirements'}{' '}
                        <ChevronDown size={13} />
                      </summary>
                      {requirements.slice(1).map((item) => (
                        <p key={item.title}>
                          <a href={item.href}>{item.title}</a> {item.detail}
                        </p>
                      ))}
                    </details>
                  )}
                </section>
              ) : (
                <>
                  <div className="automation-limit-summary">
                    <span>
                      Automatic quote limit{' '}
                      <strong>
                        {service.maxAutoQuoteCents > 0
                          ? money(service.maxAutoQuoteCents)
                          : 'Not set'}
                      </strong>
                    </span>
                  </div>
                  <div className={'automation-workspace' + (ready ? ' has-current-results' : '')}>
                    <div className="automation-saved-results">
                      {currentEvaluation && <ReadinessResults value={currentEvaluation} />}
                    </div>
                    {ready && (
                      <section className="automation-approval" hidden={adding || editingLimit}>
                        {!user.emailVerified ? (
                          <div className="automation-task">
                            <h3>Verify the email on your account.</h3>
                            <p>We need to confirm who is approving automatic quotes.</p>
                            <Button
                              loading={busy === 'verify'}
                              disabled={!!busy}
                              onClick={() => void requestVerification()}
                            >
                              Send verification email
                            </Button>
                            {verification && (
                              <p>
                                {verification.delivery === 'local'
                                  ? 'Local development only. No email was sent.'
                                  : 'A verification email is queued. Open its link, then return here.'}
                              </p>
                            )}
                            {verification?.delivery === 'local' && verification.devToken && (
                              <a
                                className="automation-action-link"
                                target="_blank"
                                rel="noreferrer"
                                href={
                                  '/verify-email#token=' + encodeURIComponent(verification.devToken)
                                }
                              >
                                Open local verification link →
                              </a>
                            )}
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() => void act('refresh', refresh)}
                            >
                              I’ve verified my email
                            </button>
                          </div>
                        ) : (
                          <>
                            {billingError ? (
                              <div className="automation-blocker">
                                <p>Billing access could not be checked: {billingError}</p>
                                <button className="text-button" onClick={() => void loadBilling()}>
                                  Try again
                                </button>
                              </div>
                            ) : !billing ? (
                              <p className="quiet-loading">Checking trial and billing access…</p>
                            ) : !billing.canIssue ? (
                              <div className="automation-blocker">
                                <h3>Check your trial or billing access.</h3>
                                <p>
                                  {billing.reason ||
                                    'Automatic delivery is currently unavailable for this account.'}
                                </p>
                                <a className="automation-action-link" href="/dashboard/billing">
                                  Open billing →
                                </a>
                                <button className="text-button" onClick={() => void loadBilling()}>
                                  Check again
                                </button>
                              </div>
                            ) : null}
                            {billing?.canIssue && !billingError && (
                              <>
                                <details className="automation-policy">
                                  <summary>
                                    Pricing and scope you’re approving <ChevronDown size={13} />
                                  </summary>
                                  <div>
                                    <p>
                                      {service.unitPriceCents > 0
                                        ? money(service.unitPriceCents) +
                                          ' per ' +
                                          service.unitLabel +
                                          '. '
                                        : ''}
                                      {service.basePriceCents > 0
                                        ? money(service.basePriceCents) + ' base charge. '
                                        : ''}
                                      {service.minimumChargeCents > 0
                                        ? money(service.minimumChargeCents) + ' minimum. '
                                        : ''}
                                      Maximum automatic quote: {money(service.maxAutoQuoteCents)}.
                                    </p>
                                    <p>Required details: {service.requiredInputs.join(', ')}.</p>
                                    <p>
                                      Owner review:{' '}
                                      {service.exclusions.join('; ') ||
                                        'Missing facts, ambiguity, and requests outside the approved scope'}
                                      .
                                    </p>
                                    {service.pricingRules?.map((rule) => (
                                      <p key={rule.id}>
                                        {rule.name}: when {rule.field}{' '}
                                        {rule.operator.replaceAll('_', ' ')} “{rule.value}”,{' '}
                                        {rule.kind === 'review'
                                          ? 'send to owner review'
                                          : rule.kind === 'percent'
                                            ? 'adjust by ' + rule.amount / 100 + '%'
                                            : 'adjust by ' +
                                              money(rule.amount) +
                                              (rule.kind === 'per_unit' ? ' per unit' : '')}
                                        .
                                      </p>
                                    ))}
                                  </div>
                                </details>
                                <label className="checkbox-field">
                                  <input
                                    type="checkbox"
                                    checked={approved}
                                    disabled={!!busy}
                                    onChange={(event) => setApproved(event.target.checked)}
                                  />
                                  <span>
                                    I reviewed the test results and approve this service’s pricing,
                                    required details, exclusions, and quote limit.
                                  </span>
                                </label>
                                <Button
                                  loading={busy === 'activate'}
                                  disabled={!canActivate}
                                  onClick={() => void activate()}
                                >
                                  Activate automatic quotes
                                </Button>
                                <p className="automation-small">
                                  Activation enables automatic quotes for all currently approved
                                  services. You can pause them anytime.
                                </p>
                              </>
                            )}
                          </>
                        )}
                      </section>
                    )}
                    <details
                      className="automation-tools automation-detail"
                      open={!ready || toolsOpen}
                    >
                      <summary
                        hidden={!ready}
                        onClick={(event) => {
                          event.preventDefault();
                          setToolsOpen(!toolsOpen);
                        }}
                      >
                        Edit test jobs or quote limit <ChevronDown size={13} />
                      </summary>
                      <div>
                        {service.maxAutoQuoteCents > 0 && !editingLimit && (
                          <button
                            className="text-button automation-change-limit"
                            disabled={!!busy}
                            onClick={() => {
                              setEditingLimit(true);
                              setToolsOpen(true);
                              setApproved(false);
                            }}
                          >
                            Change limit
                          </button>
                        )}
                        <form
                          key={contextKey}
                          className="automation-task automation-limit"
                          onSubmit={saveLimit}
                          hidden={service.maxAutoQuoteCents > 0 && !editingLimit}
                        >
                          <h3>How much can it quote without you?</h3>
                          <p>
                            Larger requests come to you. Changing this limit needs new checks and
                            approval.
                            {service.mode === 'review' && service.publishedAt
                              ? ' Your current link keeps accepting requests for your review.'
                              : ''}
                          </p>
                          <Field
                            label="Maximum automatic quote ($)"
                            name="maximum"
                            type="number"
                            min="0.01"
                            max="1000000"
                            step="0.01"
                            required
                            defaultValue={
                              service.maxAutoQuoteCents > 0 ? service.maxAutoQuoteCents / 100 : ''
                            }
                          />
                          <div className="automation-inline-actions">
                            <Button type="submit" loading={busy === 'limit'} disabled={!!busy}>
                              Save quote limit
                            </Button>
                            {service.maxAutoQuoteCents > 0 && (
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => setEditingLimit(false)}
                                disabled={!!busy}
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </form>
                        <section
                          className="automation-cases"
                          aria-label="Independent test cases"
                          hidden={editingLimit || service.maxAutoQuoteCents <= 0}
                        >
                          <div className="automation-case-heading">
                            <h3>Set the answers before it tries.</h3>
                            <p>
                              Add three new jobs it should quote and one it should send to you. Set
                              your answers first; these jobs stay separate from teaching.
                            </p>
                          </div>
                          <div className="automation-case-counts">
                            <span>{pricedCases} / 3 quote cases</span>
                            <span>{reviewCases} / 1 owner-review case</span>
                          </div>
                          {loadingCases ? (
                            <p className="quiet-loading">Loading saved tests…</p>
                          ) : (
                            cases.length > 0 && (
                              <div className="automation-case-list">
                                {cases.map((item) => (
                                  <article key={item.id}>
                                    <div>
                                      <strong>{item.title}</strong>
                                      <p>
                                        {item.expectedOutcome === 'review'
                                          ? 'Expected: owner review'
                                          : 'Expected: ' +
                                            money(item.expectedCents) +
                                            ' · ' +
                                            item.quantity +
                                            ' ' +
                                            service.unitLabel}
                                      </p>
                                    </div>
                                    <button
                                      className="icon-button"
                                      type="button"
                                      aria-label={'Delete test case ' + item.title}
                                      disabled={!!busy}
                                      onClick={() => void remove(item.id)}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </article>
                                ))}
                              </div>
                            )
                          )}
                          {adding ? (
                            <TestCaseEditor
                              key={service.id}
                              service={service}
                              onClose={() => setAdding(false)}
                              onSaved={async () => {
                                setAdding(false);
                                setReadiness(undefined);
                                setApproved(false);
                                await loadCases();
                                await refresh();
                                notify('Independent test saved.');
                              }}
                            />
                          ) : (
                            <Button
                              variant={enoughCases ? 'secondary' : 'primary'}
                              disabled={!!busy || loadingCases}
                              onClick={() => {
                                setAdding(true);
                                setToolsOpen(true);
                                setApproved(false);
                              }}
                            >
                              <Plus size={14} />
                              Add a blind test case
                            </Button>
                          )}
                        </section>
                        {!adding && !editingLimit && service.maxAutoQuoteCents > 0 && (
                          <div className="automation-run">
                            {ready ? (
                              <button
                                className="text-button"
                                disabled={!!busy || loadingReadiness || !!readinessError}
                                onClick={() => void evaluate()}
                              >
                                Run checks again
                              </button>
                            ) : (
                              <Button
                                variant={enoughCases ? 'primary' : 'secondary'}
                                loading={busy === 'evaluate'}
                                disabled={
                                  !!busy ||
                                  loadingCases ||
                                  loadingReadiness ||
                                  !!readinessError ||
                                  !matchingReadiness ||
                                  !enoughCases
                                }
                                onClick={() => void evaluate()}
                              >
                                Run independent evaluation
                              </Button>
                            )}
                            <p>
                              {busy === 'evaluate'
                                ? 'Checking prices and customer requests…'
                                : ready
                                  ? 'Saved checks are current. Running again uses AI.'
                                  : !enoughCases
                                    ? 'Save three quote cases and one owner-review case first.'
                                    : 'Checks use AI to test prices and handoffs. No customer quotes are sent.'}
                            </p>
                          </div>
                        )}
                      </div>
                    </details>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function TestCaseEditor({
  service,
  onClose,
  onSaved,
}: {
  service: Service;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<'quote' | 'review'>('quote');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fields = [
    ...new Set([
      'location',
      ...service.requiredInputs,
      ...(service.pricingRules?.map((rule) => rule.field) || []),
    ]),
  ];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError('');
    try {
      await api('/services/' + service.id + '/test-cases', {
        method: 'POST',
        ...json({
          title: form.get('title'),
          description: form.get('description'),
          quantity: Number(form.get('quantity')),
          expectedCents: outcome === 'review' ? 0 : cents(String(form.get('price'))),
          inputs: Object.fromEntries(
            fields
              .map((field, index) => [field, String(form.get('fact-' + index) || '').trim()])
              .filter(([, value]) => value),
          ),
          toleranceCents: cents(String(form.get('tolerance') || '1')),
          tolerancePercent: Number(form.get('percent') || '5'),
          expectedOutcome: outcome,
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <form
      className="automation-test-editor"
      aria-label="New independent test case"
      onSubmit={submit}
    >
      <h4>A job it hasn’t seen before.</h4>
      <p>Write your expected outcome first. Use different details from the jobs you taught it.</p>
      <Field label="Test case title" name="title" required maxLength={160} autoFocus />
      <TextArea label="Customer request" name="description" required maxLength={5000} rows={3} />
      <Select
        label="What should the assistant do?"
        value={outcome}
        onChange={(event) => setOutcome(event.target.value as 'quote' | 'review')}
      >
        <option value="quote">Issue a quote at the expected price</option>
        <option value="review">Hand off for owner review</option>
      </Select>
      <div className="automation-two-fields">
        <Field
          label={'Quantity (' + service.unitLabel + ')'}
          name="quantity"
          type="number"
          min="0.001"
          max="1000000"
          step="0.001"
          required
        />
        {outcome === 'quote' && (
          <Field
            label="Your expected price ($)"
            name="price"
            type="number"
            min="0.01"
            max="1000000"
            step="0.01"
            required
          />
        )}
      </div>
      <fieldset>
        <legend>Facts the customer provides</legend>
        <p>For a review case, include an excluded job or leave a necessary fact unknown.</p>
        {fields.map((field, index) => (
          <Field
            key={field}
            label={field === 'location' ? 'Project location' : field}
            name={'fact-' + index}
            maxLength={1000}
          />
        ))}
      </fieldset>
      <details className="automation-detail">
        <summary>
          Price tolerance <ChevronDown size={13} />
        </summary>
        <p>
          A quoted price passes within the larger of these tolerances. Outcome must always match.
        </p>
        <div className="automation-two-fields">
          <Field
            label="Dollar tolerance ($)"
            name="tolerance"
            type="number"
            min="0"
            max="500"
            step="0.01"
            defaultValue="1"
          />
          <Field
            label="Percentage tolerance (%)"
            name="percent"
            type="number"
            min="0"
            max="20"
            step="0.1"
            defaultValue="5"
          />
        </div>
      </details>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="automation-inline-actions">
        <Button type="submit" loading={loading}>
          Save independent case
        </Button>
        <button className="text-button" type="button" onClick={onClose} disabled={loading}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReadinessResults({ value, stale = false }: { value: Evaluation; stale?: boolean }) {
  const independent = value.cases.filter((item) => item.provenance === 'independent');
  const teaching = value.cases.filter((item) => item.provenance !== 'independent');
  const failed = value.checks.filter((item) => !item.passed);
  return (
    <section className="automation-results" aria-label="Evaluation results">
      <header>
        <strong>
          {stale
            ? 'Previous results · checks need updating'
            : value.automaticReady
              ? 'Independent checks support automatic quotes.'
              : 'Some checks need attention.'}
        </strong>
        <span>Saved {shortDate(value.evaluatedAt)}</span>
      </header>
      {failed.length > 0 && (
        <div className="automation-failed-checks">
          {failed.map((item, index) => (
            <div key={index}>
              <strong>{item.name}</strong>
              <p>{item.detail}</p>
            </div>
          ))}
        </div>
      )}
      {independent.length > 0 && (
        <div className="automation-result-table">
          <div className="automation-result-head">
            <span>Independent case</span>
            <span>Your answer</span>
            <span>Assistant</span>
          </div>
          {independent.map((item, index) => (
            <article className={item.passed ? 'passed' : 'failed'} key={index}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.passed ? 'Pass' : 'Needs review'}</span>
              </div>
              <span>
                {item.expectedOutcome === 'review' ? 'Owner review' : money(item.expectedCents)}
              </span>
              <span>
                {item.actualOutcome === 'review'
                  ? 'Owner review'
                  : item.actualCents >= 0
                    ? money(item.actualCents)
                    : 'Unavailable'}
              </span>
            </article>
          ))}
        </div>
      )}
      <details className="automation-detail">
        <summary>
          Check details and coverage <ChevronDown size={13} />
        </summary>
        {value.checks.map((item, index) => (
          <p key={index}>
            <strong>
              {item.passed ? 'Pass: ' : 'Needs attention: '}
              {item.name}.
            </strong>{' '}
            {item.detail}
          </p>
        ))}
        {teaching.length > 0 && (
          <>
            <h4>Teaching comparisons</h4>
            {teaching.map((item, index) => (
              <p key={index}>
                {item.title}: expected {money(item.expectedCents)}, calculated{' '}
                {item.actualCents >= 0 ? money(item.actualCents) : 'unavailable'}.{' '}
                {item.passed ? 'Pass.' : 'Needs review.'}
              </p>
            ))}
          </>
        )}
        {value.coverage?.map((item, index) => (
          <p key={'coverage-' + index}>{item}</p>
        ))}
      </details>
      <p className="automation-small">
        These results cover your saved cases. They do not guarantee a price for every job; unknown
        or unusual requests still go to you.
      </p>
    </section>
  );
}
