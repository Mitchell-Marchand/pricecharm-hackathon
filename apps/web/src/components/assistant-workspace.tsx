'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, ExternalLink, Plus } from 'lucide-react';
import { api, ApiError, cents, errorMessage, json, money } from '@/lib/api';
import type {
  Business,
  Dashboard,
  Example,
  ImportDraft,
  ImportReceipt,
  JobNote,
  PricingRule,
  Service,
  ServiceReadiness,
  TrainingSession,
  User,
} from '@/lib/types';
import { Button, Field, Notice } from './ui';
import ServiceSetup from './service-setup';
import PublicWidget from './public-widget';
import Publishing from './publishing';
import { DocumentImport } from './knowledge';
import ImportReview, { savedImportMessage } from './import-review';
import PracticePhotos, { PracticePhotoRequest } from './practice-photos';
import workspaceStyles from './assistant-workspace.module.css';

type Props = {
  data: Dashboard;
  user: User;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
};
type Step = 'teach' | 'try' | 'share';
type Teaching = {
  revision: number;
  notes: { id: string; content: string; createdAt: string }[];
};
type Proposal = {
  id: string;
  status: string;
  serviceVersion: number;
  appliedServiceVersion: number | null;
  sourceExampleIds: string[];
  sourceCaseIds?: string[];
  teachingRevision: number;
  parentProposalId: string | null;
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
};

export default function AssistantWorkspace({ data, user, refresh, notify }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const queryString = search.toString();
  const requestedService = search.get('service');
  const service = data.services.find((item) => item.id === requestedService) || data.services[0];
  const serviceId = service?.id || '';
  const step: Step =
    search.get('step') === 'try' || search.get('step') === 'share'
      ? (search.get('step') as Step)
      : 'teach';
  const introducing = search.get('new') === '1' || !data.services.length;
  const requestedPractice = search.get('practice') || '';
  const knownPractice = data.trainingSessions.find((item) => item.id === requestedPractice);
  const mismatchedPractice = Boolean(knownPractice && knownPractice.serviceId !== serviceId);
  const practiceId =
    !mismatchedPractice && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestedPractice)
      ? requestedPractice
      : '';
  const [importing, setImporting] = useState(false);
  const [autoLearn, setAutoLearn] = useState(false);
  const [addingPastJob, setAddingPastJob] = useState(false);
  const [learningRevision, setLearningRevision] = useState(0);
  const [tryReady, setTryReady] = useState('');
  const [contextError, setContextError] = useState('');
  const firstRoute = useRef(true);
  const pendingLearningRoute = useRef('');
  function workspaceUrl(id: string, next: Step, practice = '') {
    const query = new URLSearchParams({ service: id, step: next });
    if (practice) query.set('practice', practice);
    return `/dashboard?${query}`;
  }
  const canonicalUrl = introducing ? '/dashboard?new=1' : workspaceUrl(serviceId, step, practiceId);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      try {
        if (
          !requestedService &&
          !search.get('new') &&
          sessionStorage.getItem('quotient:first-job')
        ) {
          router.replace('/dashboard?new=1', { scroll: false });
          return;
        }
      } catch {
        /* Storage is optional. */
      }
    }
    if (mismatchedPractice)
      setContextError('That practice belongs to another service. Choose it from that service.');
    if (`/dashboard?${queryString}` !== canonicalUrl)
      router.replace(canonicalUrl, { scroll: false });
  }, [canonicalUrl, queryString, requestedService, mismatchedPractice, router, search]);
  useEffect(() => {
    if (pendingLearningRoute.current === canonicalUrl) pendingLearningRoute.current = '';
    else setAutoLearn(false);
    setAddingPastJob(false);
    setImporting(false);
  }, [canonicalUrl]);
  function navigate(next: Step) {
    setContextError('');
    setAutoLearn(false);
    if (service) {
      const url = workspaceUrl(service.id, next, practiceId);
      if (url !== canonicalUrl) router.push(url, { scroll: false });
    }
  }
  function selectService(id: string) {
    setContextError('');
    setAutoLearn(false);
    setAddingPastJob(false);
    const url = workspaceUrl(id, step);
    if (url !== canonicalUrl) router.push(url, { scroll: false });
  }
  const examples = data.examples.filter((item) => item.serviceId === serviceId);
  const jobNotes = (data.jobNotes || []).filter((item) => item.serviceId === serviceId);
  const latestEvidence = [...examples, ...jobNotes].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const latestProject = [
    ...examples,
    ...jobNotes.filter((item) => item.kind !== 'service_notes'),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const practiceHistory = data.trainingSessions.filter((item) => item.serviceId === serviceId);
  const latestPractice = practiceHistory[0];
  const selectedPractice = requestedPractice
    ? practiceHistory.find((item) => item.id === practiceId)
    : latestPractice;
  const focusedPractice = !introducing && step === 'teach' && selectedPractice?.status === 'active';
  const practiceCaseId = jobNotes.find(
    (item) =>
      item.id === (practiceId || latestPractice?.id) &&
      (item.kind === 'practice_quote' || item.kind === 'inspection_required'),
  )?.id;
  return (
    <div
      className={`assistant-workspace ${workspaceStyles.workspace}${focusedPractice ? ` ${workspaceStyles.activePractice}` : ''}${introducing ? ' assistant-introducing' : ''}`}
    >
      {contextError && <Notice kind="error">{contextError}</Notice>}
      {!introducing && (
        <>
          <header className="assistant-heading">
            <h1 className="sr-only">Your assistant</h1>
            <details className="service-menu">
              <summary>
                {service?.name || 'Choose a service'} <ChevronDown size={15} />
              </summary>
              <div>
                {data.services.map((item) => (
                  <button
                    key={item.id}
                    onClick={(event) => {
                      selectService(item.id);
                      event.currentTarget.closest('details')?.removeAttribute('open');
                    }}
                  >
                    {item.name}
                    {item.id === serviceId && <Check size={14} />}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setContextError('');
                    setAutoLearn(false);
                    router.push('/dashboard?new=1', { scroll: false });
                  }}
                >
                  <Plus size={14} /> Add a service
                </button>
              </div>
            </details>
            <span className="assistant-privacy">
              {service?.publishedAt
                ? service.mode === 'automatic'
                  ? 'Requests open'
                  : 'You approve prices'
                : 'Private'}
            </span>
          </header>
          <nav className={`journey-tabs ${workspaceStyles.tabs}`} aria-label="Assistant steps">
            {(['teach', 'try', 'share'] as const).map((item) => (
              <button
                key={item}
                aria-current={step === item ? 'step' : undefined}
                className={step === item ? 'active' : ''}
                onClick={() => navigate(item)}
              >
                {item === 'teach' ? 'Teach' : item === 'try' ? 'Try' : 'Share'}
              </button>
            ))}
          </nav>
        </>
      )}
      {!introducing && step === 'teach' && !focusedPractice && (
        <div className={workspaceStyles.introduction}>
          <h2>Teach it how you quote.</h2>
          <p>Ask what you’d ask a customer. Then give your price and tell it why.</p>
        </div>
      )}
      {introducing ? (
        <ServiceSetup
          business={data.business}
          preferSavedJob
          onCancel={
            data.services.length
              ? () => {
                  navigate('teach');
                }
              : undefined
          }
          onAdvanced={() => {
            window.location.href = '/dashboard/services?advanced=1';
          }}
          onStarted={async ({ service: saved, sessionId }) => {
            await refresh();
            const url = workspaceUrl(saved.id, 'teach', sessionId);
            pendingLearningRoute.current = url;
            setAutoLearn(!sessionId);
            router.replace(url, { scroll: false });
          }}
        />
      ) : !service ? (
        <p className="quiet-loading">Loading your assistant…</p>
      ) : step === 'teach' ? (
        <div className={`teaching-canvas ${workspaceStyles.teaching}`}>
          <div className={workspaceStyles.paper} hidden={addingPastJob}>
            <Practice
              key={`${service.id}:${practiceId}:${learningRevision}`}
              service={service}
              initialId={practiceId}
              exampleCount={examples.length}
              noteCount={jobNotes.length}
              latestJob={latestEvidence}
              readyJob={latestProject || latestEvidence}
              practiceCaseId={practiceCaseId}
              selectedExampleId={selectedPractice?.savedExampleId}
              autoLearn={autoLearn}
              latest={latestPractice}
              onSaved={refresh}
              onTry={() => navigate('try')}
              onPracticeStart={() => setAutoLearn(false)}
              onInvalidPractice={() => {
                setContextError(
                  'That practice belongs to another service. Choose it from that service.',
                );
                router.replace(workspaceUrl(service.id, 'teach'), { scroll: false });
              }}
              onSessionStarted={(id) =>
                router.replace(workspaceUrl(service.id, 'teach', id), { scroll: false })
              }
            />
          </div>
          <details className={`evidence-details ${workspaceStyles.evidence}`}>
            <summary>
              Your saved jobs
              <ChevronDown size={15} />
            </summary>
            <div className="evidence-content">
              {examples.map((item) => (
                <article className="evidence-row" key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                    <small>
                      {item.quantity.toLocaleString()} {item.unitLabel || service.unitLabel} ·{' '}
                      {item.rationale}
                    </small>
                    <OriginalJobNote
                      content={item.sourceNotes}
                      sourceBasis={item.sourceBasis}
                      filename={item.sourceFilename}
                    />
                  </div>
                  <strong>{money(item.finalPriceCents)}</strong>
                </article>
              ))}
              {jobNotes
                .filter((item) => item.kind !== 'practice_quote')
                .map((item) => (
                  <article className="evidence-row case-note-row" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.description}</p>
                      {item.rationale && <small>{item.rationale}</small>}
                      <OriginalJobNote
                        content={item.sourceNotes}
                        sourceBasis={item.sourceBasis}
                        filename={item.sourceFilename}
                      />
                    </div>
                    <strong>
                      {item.kind === 'inspection_required'
                        ? 'Inspection needed'
                        : item.finalPriceCents !== null
                          ? money(item.finalPriceCents)
                          : item.sourcePriceText
                            ? literalJobPrice(item)
                            : 'Note saved'}
                    </strong>
                  </article>
                ))}
              <div className="evidence-actions">
                <button className="text-button" onClick={() => setAddingPastJob((value) => !value)}>
                  <Plus size={14} /> {addingPastJob ? 'Close past job note' : 'Add a past job'}
                </button>
                <button className="text-button" onClick={() => setImporting(true)}>
                  Add an invoice or photo
                </button>
                <a href="/dashboard/examples">
                  Other ways to add jobs <ArrowRight size={14} />
                </a>
              </div>
              {addingPastJob && (
                <PastJobNote
                  service={service}
                  onSaved={async (count, receipt) => {
                    await refresh();
                    setAddingPastJob(false);
                    setAutoLearn(true);
                    setLearningRevision((value) => value + 1);
                    const url = workspaceUrl(service.id, 'teach');
                    pendingLearningRoute.current = url;
                    router.replace(url, { scroll: false });
                    notify(
                      receipt
                        ? savedImportMessage(receipt)
                        : `${count} ${count === 1 ? 'job saved' : 'jobs saved'}.`,
                    );
                  }}
                />
              )}
              {practiceHistory.length > 0 && (
                <div className="saved-practice-quotes">
                  <h3>Practice conversations</h3>
                  <div className="practice-history-list">
                    {practiceHistory.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setAutoLearn(false);
                          router.push(workspaceUrl(service.id, 'teach', item.id), {
                            scroll: false,
                          });
                        }}
                      >
                        <span>{item.scenario.title}</span>
                        <small>
                          {item.status === 'completed'
                            ? item.outcome === 'inspection_required'
                              ? 'Inspection needed'
                              : money(item.finalPriceCents || 0)
                            : 'In progress'}
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </div>
      ) : step === 'try' ? (
        <div className={`try-canvas ${workspaceStyles.test}`}>
          <div className="canvas-intro">
            <h2>Try a customer request</h2>
          </div>
          <div className="try-preview">
            <PublicWidget
              key={service.id + ':' + service.version}
              slug={data.business.slug}
              embedded
              previewProfile={{ business: data.business, services: [service] }}
              initialProject={latestProject?.description}
              onQuoteReady={() => setTryReady(`${service.id}:${service.version}`)}
            />
          </div>
          <div className="canvas-next">
            <button className="text-button" onClick={() => navigate('teach')}>
              <ArrowLeft size={14} /> Back to pricing
            </button>
            {tryReady === `${service.id}:${service.version}` ? (
              <Button onClick={() => navigate('share')}>Get my quote link</Button>
            ) : (
              <button className="text-button" onClick={() => navigate('share')}>
                Get my quote link <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <ShareAssistant key={service.id} service={service} {...{ data, user, refresh, notify }} />
      )}
      {importing && service && (
        <DocumentImport
          services={[service]}
          onClose={() => setImporting(false)}
          onSaved={async (count, receipt) => {
            await refresh();
            setImporting(false);
            setAutoLearn(true);
            setLearningRevision((value) => value + 1);
            const url = workspaceUrl(service.id, 'teach');
            pendingLearningRoute.current = url;
            router.replace(url, { scroll: false });
            notify(
              receipt
                ? savedImportMessage(receipt)
                : `${count} ${count === 1 ? 'job added' : 'jobs added'}.`,
            );
          }}
        />
      )}
    </div>
  );
}

function literalJobPrice(note: JobNote) {
  const price = note.sourcePriceText || '';
  const currency = note.sourceCurrency;
  return `${price}${currency && !price.toUpperCase().includes(currency.toUpperCase()) ? ` ${currency}` : ''} from your note`;
}

function savedEvidenceLabel(item: Example | JobNote) {
  if ('kind' in item) {
    if (item.kind === 'service_notes') return 'Your service notes';
    if (item.kind === 'practice_quote') return 'Your saved practice quote';
    if (item.kind === 'inspection_required') return 'Your saved decision';
  }
  return 'Your saved job';
}

function Practice({
  service,
  initialId,
  latest,
  onSaved,
  onTry,
  onPracticeStart,
  onInvalidPractice,
  onSessionStarted,
  exampleCount,
  noteCount,
  latestJob,
  readyJob,
  practiceCaseId,
  selectedExampleId,
  autoLearn,
}: {
  service: Service;
  exampleCount: number;
  noteCount: number;
  latestJob?: Example | JobNote;
  readyJob?: Example | JobNote;
  practiceCaseId?: string;
  selectedExampleId?: string | null;
  autoLearn: boolean;
  initialId: string;
  latest?: TrainingSession;
  onSaved: () => Promise<void>;
  onTry: () => void;
  onPracticeStart: () => void;
  onInvalidPractice: () => void;
  onSessionStarted: (id: string) => void;
}) {
  const [session, setSession] = useState<TrainingSession>();
  const practiceExampleId = session ? session.savedExampleId : selectedExampleId;
  const practiceDraftKey = `quotient:practice-draft:${service.businessId}:${service.id}:${initialId || latest?.id || 'new'}`;
  const pricingDraftKey = `quotient:pricing-draft:${service.businessId}:${service.id}`;
  const [content, setContent] = useState(() => {
    try {
      return sessionStorage.getItem(practiceDraftKey)?.slice(0, 5000) || '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [quote, setQuote] = useState<{
    outcome?: 'quote' | 'inspection_required' | null;
    finalPriceCents: number | null;
    rationale: string | null;
    reply: string;
    readyToConfirm: boolean;
  }>();
  const [quoteSource, setQuoteSource] = useState('');
  const [proposal, setProposal] = useState<Proposal>();
  const [proposalSaved, setProposalSaved] = useState(false);
  const [correctionExpanded, setCorrectionExpanded] = useState(false);
  const [pricingNotes, setPricingNotes] = useState(() => {
    try {
      return sessionStorage.getItem(pricingDraftKey)?.slice(0, 6000) || '';
    } catch {
      return '';
    }
  });
  const correctionNeedsAttention =
    (!proposal && !proposalSaved) ||
    !!pricingNotes.trim() ||
    !!error ||
    busy === 'learn' ||
    busy === 'apply';
  useEffect(() => {
    try {
      if (pricingNotes) sessionStorage.setItem(pricingDraftKey, pricingNotes);
      else sessionStorage.removeItem(pricingDraftKey);
    } catch {
      /* Browser storage is optional. */
    }
  }, [pricingNotes, pricingDraftKey]);
  useEffect(() => {
    try {
      if (content) sessionStorage.setItem(practiceDraftKey, content);
      else sessionStorage.removeItem(practiceDraftKey);
    } catch {
      /* Browser storage is optional. */
    }
  }, [content, practiceDraftKey]);
  const [teaching, setTeaching] = useState<Teaching>();
  const [showHistory, setShowHistory] = useState(false);
  const [photoBusy, setPhotoBusy] = useState('');
  const [photoActionError, setPhotoActionError] = useState<{
    requestId: string;
    message: string;
  }>();
  const [photoPollingError, setPhotoPollingError] = useState('');
  const [photoNeedsSignIn, setPhotoNeedsSignIn] = useState(false);
  const [photoPollAttempt, setPhotoPollAttempt] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const working = useRef(false);
  const photoWorking = useRef(false);
  const sessionRevision = useRef(0);
  const followConversation = useRef(true);
  const autoLearnStarted = useRef(false);
  const teachingMutation = useRef(0);
  const requestedPractice = useRef(Boolean(initialId));
  const freshPractice = !initialId && !latest && !requestedPractice.current;
  const completedPractice =
    session?.status === 'completed' || (!session && latest?.status === 'completed');
  const preferSuggestion = useRef(false);
  const pendingPhotos =
    session?.messages
      .filter((message) => message.photos?.status === 'pending')
      .map((message) => message.photos!.requestId)
      .join(',') || '';
  const photoState = session?.messages
    .filter((message) => message.photos)
    .map(
      (message) =>
        `${message.photos!.requestId}:${message.photos!.status}:${message.photos!.attachments.length}`,
    )
    .join(',');
  const lastCustomerMessage = session?.messages
    .filter((message) => message.role === 'assistant')
    .at(-1);
  useEffect(() => {
    let active = true;
    const id = initialId || (!autoLearn ? latest?.id : undefined);
    if (id) {
      setBusy('load');
      api<TrainingSession>(`/training/${encodeURIComponent(id)}`)
        .then((result) => {
          if (active && result.serviceId !== service.id) {
            setSession(undefined);
            onInvalidPractice();
            return;
          }
          if (active && !preferSuggestion.current) setSession(result);
        })
        .catch((cause) => {
          if (active) setError(errorMessage(cause));
        })
        .finally(() => {
          if (active) setBusy('');
        });
    }
    return () => {
      active = false;
    };
  }, [initialId]);
  useEffect(() => {
    if (!session?.id || !pendingPhotos) {
      setPhotoPollingError('');
      setPhotoNeedsSignIn(false);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const sessionId = session.id;
    const startedAt = Date.now();
    setPhotoPollingError('');
    setPhotoNeedsSignIn(false);
    async function pollPhotos() {
      if (!active) return;
      if (Date.now() - startedAt > 600_000) {
        setPhotoPollingError('These photos are taking longer than expected.');
        return;
      }
      if (working.current || photoWorking.current) {
        timer = setTimeout(pollPhotos, 2000);
        return;
      }
      const revision = sessionRevision.current;
      try {
        const result = await api<TrainingSession>(`/training/${encodeURIComponent(sessionId)}`);
        if (!active) return;
        failures = 0;
        if (revision === sessionRevision.current) {
          setSession((current) =>
            current?.id === result.id && current.messages.length <= result.messages.length
              ? result
              : current,
          );
        }
        setPhotoPollingError('');
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) {
          setPhotoNeedsSignIn(true);
          setPhotoPollingError('Your session expired. Sign in again to load the photos.');
          return;
        }
        failures += 1;
        if (failures >= 3) {
          setPhotoPollingError('Photo progress couldn’t refresh.');
          return;
        }
      }
      if (active) timer = setTimeout(pollPhotos, 2000);
    }
    timer = setTimeout(pollPhotos, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session?.id, pendingPhotos, photoPollAttempt]);
  useEffect(() => {
    if (followConversation.current)
      log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'auto' });
  }, [session?.messages.length, busy, photoState]);
  useEffect(() => {
    let active = true;
    const revision = teachingMutation.current;
    api<{ proposals: Proposal[]; teaching: Teaching }>(`/services/${service.id}/proposals`)
      .then((result) => {
        if (!active || revision !== teachingMutation.current) return;
        const savedTeaching = result.teaching || { revision: 0, notes: [] };
        setTeaching(savedTeaching);
        const hasPracticeEvidence = !!practiceCaseId || !!practiceExampleId;
        const includesPractice = (item: Proposal) =>
          !hasPracticeEvidence ||
          (!!practiceCaseId && !!item.sourceCaseIds?.includes(practiceCaseId)) ||
          (!!practiceExampleId && item.sourceExampleIds.includes(practiceExampleId));
        const current = result.proposals.find(
          (item) =>
            item.status === 'pending' &&
            item.serviceVersion === service.version &&
            (item.teachingRevision || 0) === savedTeaching.revision &&
            includesPractice(item),
        );
        setProposal(current);
        const savedProposal =
          !current &&
          result.proposals.some(
            (item) =>
              item.status === 'applied' &&
              item.appliedServiceVersion !== null &&
              (hasPracticeEvidence
                ? item.appliedServiceVersion <= service.version
                : item.appliedServiceVersion === service.version) &&
              item.teachingRevision === savedTeaching.revision &&
              includesPractice(item),
          );
        setProposalSaved(savedProposal);
        if ((current || savedProposal) && !requestedPractice.current) {
          preferSuggestion.current = true;
          setSession(undefined);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [service.id, service.version, practiceCaseId, practiceExampleId]);
  async function start() {
    if (working.current || photoWorking.current) return;
    onPracticeStart();
    working.current = true;
    sessionRevision.current += 1;
    followConversation.current = true;
    setBusy('start');
    setError('');
    try {
      const result = await api<TrainingSession>('/training', {
        method: 'POST',
        ...json({ serviceId: service.id }),
      });
      requestedPractice.current = true;
      preferSuggestion.current = false;
      setQuote(undefined);
      setProposal(undefined);
      setProposalSaved(false);
      setSession(result);
      await onSaved();
      onSessionStarted(result.id);
      log.current?.scrollIntoView({ block: 'nearest' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !content.trim() || working.current || photoWorking.current) return;
    working.current = true;
    sessionRevision.current += 1;
    followConversation.current = true;
    setBusy('send');
    setError('');
    setQuote(undefined);
    try {
      setSession(
        await api<TrainingSession>(`/training/${session.id}/messages`, {
          method: 'POST',
          ...json({ content: content.trim() }),
        }),
      );
      setContent('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  async function requestPhotos(requestId?: string) {
    if (!session || photoWorking.current || working.current || pendingPhotos) return;
    photoWorking.current = true;
    sessionRevision.current += 1;
    setPhotoBusy(requestId || 'request');
    setPhotoActionError(undefined);
    setError('');
    try {
      const result = await api<TrainingSession>(
        requestId
          ? `/training/${session.id}/photos/${encodeURIComponent(requestId)}/retry`
          : `/training/${session.id}/photos`,
        { method: 'POST', ...json({}) },
      );
      setSession((current) =>
        current?.id === result.id && current.messages.length <= result.messages.length
          ? result
          : current,
      );
    } catch (cause) {
      if (requestId) setPhotoActionError({ requestId, message: errorMessage(cause) });
      else setError(errorMessage(cause));
    } finally {
      photoWorking.current = false;
      setPhotoBusy('');
    }
  }
  async function draftQuote() {
    const source =
      content.trim() ||
      session?.messages.filter((item) => item.role === 'user').at(-1)?.content ||
      '';
    if (!session || !source || working.current) {
      if (!source) setError('Write your price and reason, or explain why you need a site visit.');
      return;
    }
    working.current = true;
    setBusy('quote');
    setError('');
    try {
      const result = await api<NonNullable<typeof quote>>(`/training/${session.id}/quote-draft`, {
        method: 'POST',
        ...json({ content: source }),
      });
      setQuote(result);
      setQuoteSource(source);
      if (!result.readyToConfirm) setError(result.reply);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  async function complete() {
    if (
      !session ||
      !quote?.readyToConfirm ||
      (quote.outcome !== 'inspection_required' && quote.finalPriceCents === null) ||
      !quote.rationale ||
      working.current ||
      photoWorking.current
    )
      return;
    working.current = true;
    sessionRevision.current += 1;
    setBusy('complete');
    setError('');
    try {
      const quantity = session.scenario.details.quantity?.match(
        /^\s*(\d[\d,]*(?:\.\d{1,3})?)(?:\s|$)/,
      );
      const numericQuantity = quantity ? Number(quantity[1].replaceAll(',', '')) : NaN;
      const result = await api<TrainingSession>(`/training/${session.id}/complete`, {
        method: 'POST',
        ...json({
          ...(quote.outcome === 'inspection_required' ? { outcome: 'inspection_required' } : {}),
          finalPriceCents: quote.finalPriceCents,
          rationale: quote.rationale,
          saveAsExample:
            quote.outcome !== 'inspection_required' &&
            Number.isFinite(numericQuantity) &&
            numericQuantity > 0 &&
            numericQuantity <= 1000000,
        }),
      });
      teachingMutation.current += 1;
      setProposal(undefined);
      setProposalSaved(false);
      setSession(result);
      setContent('');
      setQuote(undefined);
      await onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  async function learn(notes = '') {
    if (working.current || photoWorking.current) return;
    working.current = true;
    teachingMutation.current += 1;
    setBusy('learn');
    setError('');
    try {
      let savedTeaching = teaching;
      let previous = proposal;
      if (!savedTeaching) {
        const loaded = await api<{ proposals: Proposal[]; teaching: Teaching }>(
          `/services/${service.id}/proposals`,
        );
        savedTeaching = loaded.teaching || { revision: 0, notes: [] };
        setTeaching(savedTeaching);
        previous = loaded.proposals.find(
          (item) =>
            item.status === 'pending' &&
            item.serviceVersion === service.version &&
            (item.teachingRevision || 0) === savedTeaching!.revision,
        );
      }
      if (
        previous &&
        (previous.serviceVersion !== service.version ||
          (previous.teachingRevision || 0) !== savedTeaching.revision)
      )
        previous = undefined;
      const result = await api<{ proposal: Proposal; teaching: Teaching }>(
        `/services/${service.id}/learn`,
        {
          method: 'POST',
          ...json({
            notes,
            expectedTeachingRevision: savedTeaching.revision,
            ...(previous ? { previousProposalId: previous.id } : {}),
          }),
        },
      );
      setProposal(result.proposal);
      setTeaching(result.teaching || savedTeaching);
      setProposalSaved(false);
      setPricingNotes('');
      requestedPractice.current = false;
      preferSuggestion.current = true;
      if (session?.status !== 'completed') setSession(undefined);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        ['TEACHING_CHANGED', 'STALE_PROPOSAL'].includes(cause.code)
      ) {
        try {
          const loaded = await api<{ proposals: Proposal[]; teaching: Teaching }>(
            `/services/${service.id}/proposals`,
          );
          const savedTeaching = loaded.teaching || { revision: 0, notes: [] };
          setTeaching(savedTeaching);
          setProposal(
            loaded.proposals.find(
              (item) =>
                item.status === 'pending' &&
                item.serviceVersion === service.version &&
                (item.teachingRevision || 0) === savedTeaching.revision,
            ),
          );
        } catch {
          /* Keep the owner's unsent correction if the refresh also fails. */
        }
      }
      let savedMessage = 'Your notes are saved.';
      if (latestJob) {
        savedMessage =
          'kind' in latestJob && latestJob.kind === 'inspection_required'
            ? 'Your decision is saved.'
            : 'kind' in latestJob && latestJob.kind === 'service_notes'
              ? 'Your notes are saved.'
              : 'Your job is saved.';
      }
      setError(
        cause instanceof ApiError && cause.status >= 500
          ? `${savedMessage} We couldn’t put together a suggestion yet.`
          : errorMessage(cause),
      );
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  async function apply() {
    if (!proposal || working.current || photoWorking.current) return;
    working.current = true;
    teachingMutation.current += 1;
    setBusy('apply');
    setError('');
    try {
      await api(`/proposals/${proposal.id}/apply`, { method: 'POST', ...json({}) });
      setProposalSaved(true);
      setCorrectionExpanded(false);
      await onSaved();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const loaded = await api<{ proposals: Proposal[]; teaching: Teaching }>(
            `/services/${service.id}/proposals`,
          );
          const savedTeaching = loaded.teaching || { revision: 0, notes: [] };
          setTeaching(savedTeaching);
          setProposal(
            loaded.proposals.find(
              (item) =>
                item.status === 'pending' &&
                item.serviceVersion === service.version &&
                (item.teachingRevision || 0) === savedTeaching.revision,
            ),
          );
          await onSaved();
        } catch {
          /* The owner's unsent note remains available if the refresh fails. */
        }
      }
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  useEffect(() => {
    if (
      autoLearn &&
      (exampleCount + noteCount > 0 || service.description.trim()) &&
      !autoLearnStarted.current
    ) {
      autoLearnStarted.current = true;
      void learn();
    }
  }, [autoLearn, exampleCount, noteCount, service.description]);
  return (
    <section
      className={`practice-canvas ${session?.status === 'completed' && (proposal || proposalSaved) ? 'with-result' : ''} ${showHistory ? 'show-history' : ''}`}
      aria-label="Teach your assistant"
    >
      {error && <Notice kind="error">{error}</Notice>}
      {session?.status === 'completed' && (proposal || proposalSaved) && (
        <button
          className="text-button completed-history-toggle"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((value) => !value)}
        >
          {showHistory ? 'Hide conversation' : 'View conversation'} <ChevronDown size={14} />
        </button>
      )}
      {!session ? (
        proposal || proposalSaved ? null : (
          <div className="practice-start">
            {exampleCount + noteCount > 0 ? (
              <>
                {!proposal && !proposalSaved && (
                  <>
                    {latestJob ? (
                      <article className="captured-job saved-job-recap">
                        <span className="context-label">{savedEvidenceLabel(latestJob)}</span>
                        <h2>{latestJob.title}</h2>
                        {latestJob.finalPriceCents !== null && (
                          <strong className="captured-price">
                            {money(latestJob.finalPriceCents)}
                          </strong>
                        )}
                        {latestJob.finalPriceCents === null &&
                          'sourcePriceText' in latestJob &&
                          latestJob.sourcePriceText && (
                            <strong className="captured-price">{literalJobPrice(latestJob)}</strong>
                          )}
                        <p>{latestJob.description}</p>
                        {latestJob.rationale && (
                          <div className="captured-reason">
                            <span>
                              {'kind' in latestJob && latestJob.kind === 'inspection_required'
                                ? 'Your decision'
                                : latestJob.finalPriceCents !== null
                                  ? 'Why you charged that'
                                  : 'What you told it'}
                            </span>
                            <p>{latestJob.rationale}</p>
                          </div>
                        )}
                        <OriginalJobNote
                          content={latestJob.sourceNotes}
                          sourceBasis={latestJob.sourceBasis}
                          filename={latestJob.sourceFilename}
                        />
                      </article>
                    ) : (
                      <p>Your past job is saved.</p>
                    )}
                    <Button
                      onClick={() => void learn()}
                      loading={busy === 'learn'}
                      disabled={!!busy}
                    >
                      {exampleCount > 0 ? 'See suggested pricing' : 'Suggest customer questions'}{' '}
                      <ArrowRight size={15} />
                    </Button>
                  </>
                )}
              </>
            ) : (
              <>
                <p>Your service notes are saved. Start with the questions customers can answer.</p>
                <Button onClick={() => void learn()} loading={busy === 'learn'} disabled={!!busy}>
                  Suggest customer questions <ArrowRight size={15} />
                </Button>
              </>
            )}
          </div>
        )
      ) : (
        <>
          <div className="qf-conversation-header">
            <div>
              <strong>{session.scenario.customerName || 'Practice customer'}</strong>
              <span>Practice customer</span>
            </div>
          </div>
          <div
            className="practice-messages qf-thread"
            ref={log}
            role="log"
            aria-live="polite"
            aria-label="Practice conversation"
            onScroll={(event) => {
              const element = event.currentTarget;
              followConversation.current =
                element.scrollHeight - element.clientHeight - element.scrollTop < 64;
            }}
          >
            {session.messages.map((item) => (
              <article
                className={item.role === 'user' ? 'qf-message qf-message--outgoing' : 'qf-message'}
                key={item.id}
              >
                <div className="qf-message-body">
                  <span className="qf-message-author">
                    {item.role === 'user' ? 'You' : session.scenario.customerName || 'Customer'}
                  </span>
                  <p>{item.content.replace(/^\[(?:Demo )?Practice customer\]\s*/i, '')}</p>
                  {item.photos && (
                    <PracticePhotos
                      photos={item.photos}
                      onRetry={() => void requestPhotos(item.photos!.requestId)}
                      retrying={photoBusy === item.photos.requestId}
                      retryDisabled={!!busy || !!photoBusy || !!pendingPhotos}
                      retryUnavailableReason={
                        pendingPhotos ? 'Another set of photos is being prepared.' : undefined
                      }
                      retryError={
                        photoActionError?.requestId === item.photos.requestId
                          ? photoActionError.message
                          : undefined
                      }
                      refreshError={photoPollingError}
                      needsSignIn={photoNeedsSignIn}
                      onRefresh={() => setPhotoPollAttempt((value) => value + 1)}
                    />
                  )}
                  {session.status === 'active' &&
                    item.id === lastCustomerMessage?.id &&
                    !item.photos &&
                    !pendingPhotos &&
                    /\b(?:photos?|pictures?|images?)\b/i.test(item.content) && (
                      <PracticePhotoRequest
                        onRequest={() => void requestPhotos()}
                        loading={photoBusy === 'request'}
                        disabled={!!busy || !!photoBusy}
                      />
                    )}
                </div>
              </article>
            ))}
            {busy === 'send' && <p className="quiet-loading">Customer is replying…</p>}
          </div>
          {session.status === 'active' ? (
            <>
              {quote?.readyToConfirm ? (
                <div
                  className={`quote-confirmation${quote.outcome === 'inspection_required' ? ' inspection-confirmation' : ''}`}
                >
                  <span className="context-label">
                    {quote.outcome === 'inspection_required' ? 'Your decision' : 'Your final quote'}
                  </span>
                  <strong>
                    {quote.outcome === 'inspection_required'
                      ? 'Inspection needed'
                      : money(quote.finalPriceCents!)}
                  </strong>
                  <p>{quote.rationale}</p>
                  <div>
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => {
                        setQuote(undefined);
                        setContent(quoteSource);
                      }}
                    >
                      Change it
                    </button>
                    <Button
                      onClick={() => void complete()}
                      loading={busy === 'complete'}
                      disabled={!!photoBusy}
                    >
                      {quote.outcome === 'inspection_required'
                        ? 'Save inspection decision'
                        : 'Save this quote'}{' '}
                      <Check size={15} />
                    </Button>
                  </div>
                </div>
              ) : (
                <form className="qf-composer" onSubmit={send}>
                  <label className="sr-only" htmlFor="practice-reply">
                    Your reply to the practice customer
                  </label>
                  <textarea
                    id="practice-reply"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    rows={2}
                    maxLength={5000}
                    placeholder="Reply to the customer…"
                    disabled={!!busy}
                  />
                  <div className="qf-composer-actions">
                    <Button
                      type="submit"
                      disabled={!content.trim() || !!busy || !!photoBusy}
                      loading={busy === 'send'}
                      aria-label="Send practice reply"
                    >
                      Send
                    </Button>
                  </div>
                </form>
              )}
              {!quote?.readyToConfirm && (
                <div className="practice-completion-action">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void draftQuote()}
                    disabled={!!busy}
                    title="Review your price or inspection decision before saving"
                  >
                    {busy === 'quote' ? 'Reading your decision…' : 'Finish this practice'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="practice-recap">
              <div>
                <Check size={18} />
                <strong>
                  {session.outcome === 'inspection_required'
                    ? 'Inspection decision saved.'
                    : 'Your quote and reasoning are saved.'}
                </strong>
              </div>
              <p>
                {session.outcome !== 'inspection_required' &&
                  `${money(session.finalPriceCents || 0)} · `}
                {session.rationale}
              </p>
              {exampleCount === 0 &&
                noteCount === 0 &&
                session.outcome !== 'inspection_required' && (
                  <p>
                    Your quote stays with this conversation. Its job size hasn’t been confirmed.
                  </p>
                )}
              {!proposal &&
                !proposalSaved &&
                (exampleCount + noteCount > 0 || session.outcome === 'inspection_required') && (
                  <div className="recap-actions">
                    <Button onClick={() => void learn()} loading={busy === 'learn'}>
                      See what it learned <ArrowRight size={15} />
                    </Button>
                  </div>
                )}
            </div>
          )}
        </>
      )}
      {proposal && !proposalSaved && (
        <article className="learning-result" aria-label="Suggested pricing and questions">
          <span className="context-label">
            {proposal.sourceExampleIds.length + (proposal.sourceCaseIds?.length || 0) > 0
              ? 'From your saved jobs and notes'
              : 'Based on your service description'}
          </span>
          <h3>
            {proposal.proposal.unitPriceCents +
              proposal.proposal.basePriceCents +
              proposal.proposal.minimumChargeCents >
            0
              ? 'Suggested pricing'
              : 'Questions for new customers'}
          </h3>
          {proposal.proposal.unitPriceCents +
            proposal.proposal.basePriceCents +
            proposal.proposal.minimumChargeCents >
          0 ? (
            <div className="learned-prices">
              {proposal.proposal.unitPriceCents > 0 && (
                <div>
                  <strong>{money(proposal.proposal.unitPriceCents)}</strong>
                  <span>per {proposal.proposal.unitLabel || service.unitLabel}</span>
                </div>
              )}
              {proposal.proposal.basePriceCents > 0 && (
                <div>
                  <strong>{money(proposal.proposal.basePriceCents)}</strong>
                  <span>base charge</span>
                </div>
              )}
              {proposal.proposal.minimumChargeCents > 0 && (
                <div>
                  <strong>{money(proposal.proposal.minimumChargeCents)}</strong>
                  <span>minimum</span>
                </div>
              )}
            </div>
          ) : (
            <p>You can approve prices case by case. No standard rate is assumed.</p>
          )}
          <div className="learned-questions">
            {proposal.proposal.requiredInputs.length > 0 && (
              <>
                <strong>Ask customers</strong>
                <ul>
                  {proposal.proposal.requiredInputs.map((field) => (
                    <li key={field}>{intakeLabel(field)}</li>
                  ))}
                </ul>
              </>
            )}
            {proposal.proposal.pricingRules.map((rule) => (
              <p key={rule.id}>{ruleDescription(rule)}</p>
            ))}
            {proposal.proposal.exclusions.length > 0 && (
              <p>Bring these requests to you: {proposal.proposal.exclusions.join('; ')}.</p>
            )}
          </div>
          <Button
            onClick={() => void apply()}
            loading={busy === 'apply'}
            disabled={!!busy || !!photoBusy}
          >
            {proposal.proposal.unitPriceCents +
              proposal.proposal.basePriceCents +
              proposal.proposal.minimumChargeCents >
            0
              ? 'Use these rules'
              : 'Use these questions'}{' '}
            <Check size={15} />
          </Button>
          {proposal.proposal.unitLabel && proposal.proposal.unitLabel !== service.unitLabel && (
            <p className="result-footnote">
              New quotes use {proposal.proposal.unitLabel}. Past jobs keep their original units.
            </p>
          )}
          <details className="proposal-reason">
            <summary>
              Why this suggestion? <ChevronDown size={14} />
            </summary>
            <p>{proposal.proposal.explanation}</p>
            {proposal.proposal.uncertainties.length > 0 && (
              <div className="learning-unknowns">
                <strong>Still needs your judgment</strong>
                {proposal.proposal.uncertainties.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            )}
          </details>
        </article>
      )}
      {proposalSaved && session?.status !== 'active' && (
        <section className="applied-result" aria-label="Approved questions and pricing">
          <div className="applied-result-heading">
            <Check size={18} aria-hidden="true" />
            <strong>
              {freshPractice && readyJob ? savedEvidenceLabel(readyJob) : 'Saved for new requests.'}
            </strong>
          </div>
          {freshPractice && readyJob && (
            <div className="ready-practice-context">
              <h3>{readyJob.title}</h3>
              {readyJob.finalPriceCents !== null ? (
                <span>{money(readyJob.finalPriceCents)}</span>
              ) : 'sourcePriceText' in readyJob && readyJob.sourcePriceText ? (
                <span>{literalJobPrice(readyJob)}</span>
              ) : null}
              <p>{readyJob.rationale?.trim() ? readyJob.rationale : readyJob.description}</p>
            </div>
          )}
          {service.unitPriceCents + service.basePriceCents + service.minimumChargeCents > 0 && (
            <p className="applied-pricing">
              {[
                service.unitPriceCents > 0 &&
                  `${money(service.unitPriceCents)} per ${service.unitLabel}`,
                service.basePriceCents > 0 && `${money(service.basePriceCents)} base charge`,
                service.minimumChargeCents > 0 && `${money(service.minimumChargeCents)} minimum`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {freshPractice && (
            <Button
              onClick={() => void start()}
              loading={busy === 'start'}
              disabled={!!busy || !!photoBusy}
            >
              Price a practice job <ArrowRight size={15} />
            </Button>
          )}
          {(service.requiredInputs.length > 0 || !!service.pricingRules?.length) && (
            <div className="applied-questions">
              <span>Ask customers</span>
              <ul>
                {uniqueIntakeLabels([
                  ...service.requiredInputs,
                  ...(service.pricingRules || []).map((rule) => rule.field),
                ]).map((field) => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </div>
          )}
          {!freshPractice && (
            <>
              <Button onClick={onTry}>
                Try it <ArrowRight size={15} />
              </Button>
              {completedPractice && (
                <button
                  className="text-button optional-practice"
                  onClick={() => void start()}
                  disabled={!!busy || !!photoBusy}
                >
                  Price another practice job <ArrowRight size={14} />
                </button>
              )}
            </>
          )}
        </section>
      )}
      {session?.status !== 'active' &&
        (proposal || proposalSaved || teaching?.notes.length || pricingNotes) && (
          <section className="learning-feedback" aria-label="Your teaching notes">
            <details
              className="owner-teaching"
              open={correctionExpanded || correctionNeedsAttention}
              onToggle={(event) => {
                if (correctionNeedsAttention) {
                  if (!event.currentTarget.open) event.currentTarget.open = true;
                } else setCorrectionExpanded(event.currentTarget.open);
              }}
            >
              <summary>
                Add or change a detail <ChevronDown size={14} />
              </summary>
              <form
                className="pricing-clarification"
                onSubmit={(event) => {
                  event.preventDefault();
                  void learn(pricingNotes);
                }}
              >
                <label htmlFor="pricing-clarification">Anything to add or change?</label>
                <textarea
                  id="pricing-clarification"
                  value={pricingNotes}
                  onChange={(event) => setPricingNotes(event.target.value)}
                  placeholder="Add a detail, question, or exception…"
                  rows={2}
                  maxLength={5000}
                  disabled={!!busy}
                />
                <Button
                  variant="secondary"
                  type="submit"
                  loading={busy === 'learn'}
                  disabled={!pricingNotes.trim() || !!busy || !!photoBusy}
                >
                  Update suggestion
                </Button>
              </form>
              {!!teaching?.notes.length && (
                <details className="owner-teaching" open>
                  <summary>
                    What you’ve told it <ChevronDown size={14} />
                  </summary>
                  <ul>
                    {teaching.notes.map((note) => (
                      <li key={note.id}>{note.content}</li>
                    ))}
                  </ul>
                </details>
              )}
            </details>
          </section>
        )}
    </section>
  );
}

function OriginalJobNote({
  content,
  sourceBasis,
  filename,
}: {
  content?: string;
  sourceBasis?: 'exact_owner_text' | 'reviewed_extraction';
  filename?: string;
}) {
  if (!content?.trim()) return null;
  const reviewed = sourceBasis === 'reviewed_extraction';
  return (
    <details className="original-job-note">
      <summary>
        {reviewed ? 'Reviewed document details' : 'Original job note'} <ChevronDown size={14} />
      </summary>
      {reviewed && filename && <p>From {filename}</p>}
      <p>{content}</p>
    </details>
  );
}

function PastJobNote({
  service,
  onSaved,
}: {
  service: Service;
  onSaved: (count: number, receipt?: ImportReceipt) => Promise<void>;
}) {
  const textKey = `quotient:past-job-note:${service.businessId}:${service.id}`;
  const draftKey = `${textKey}:draft`;
  const [note, setNote] = useState(() => {
    try {
      return sessionStorage.getItem(textKey) || '';
    } catch {
      return '';
    }
  });
  const [draft, setDraft] = useState<ImportDraft>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const working = useRef(false);
  useEffect(() => {
    let active = true;
    try {
      const id = sessionStorage.getItem(draftKey);
      if (id) {
        setBusy('load');
        api<{ draft: ImportDraft }>(`/imports/${id}`)
          .then((result) => {
            if (!active) return;
            setDraft(result.draft);
            if (result.draft.sourceBasis === 'exact_owner_text' && result.draft.sourceNotes)
              setNote(result.draft.sourceNotes);
          })
          .catch((cause) => {
            if (active) setError(errorMessage(cause));
          })
          .finally(() => {
            if (active) setBusy('');
          });
      }
    } catch {
      /* The raw note remains usable without browser storage. */
    }
    return () => {
      active = false;
    };
  }, [draftKey]);
  useEffect(() => {
    try {
      sessionStorage.setItem(textKey, note);
    } catch {
      /* Browser storage is optional. */
    }
  }, [textKey, note]);
  async function extract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working.current || !note.trim()) return;
    working.current = true;
    setBusy('read');
    setError('');
    try {
      const form = new FormData();
      form.set('serviceId', service.id);
      form.set('file', new File([note], 'past-job.txt', { type: 'text/plain' }));
      const result = await api<{ draft: ImportDraft }>('/imports/document', {
        method: 'POST',
        body: form,
      });
      setDraft(result.draft);
      try {
        sessionStorage.setItem(draftKey, result.draft.id);
      } catch {
        /* The server retains this draft. */
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
      working.current = false;
    }
  }
  return (
    <section className="past-job-note" aria-label="Add a past job">
      <h3>Another job you’ve done</h3>
      {!draft && (
        <>
          <p>Share what you remember. The size, price or reason can stay unknown.</p>
          <form onSubmit={extract}>
            <label className="sr-only" htmlFor="past-job-note">
              Past job details
            </label>
            <textarea
              id="past-job-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              maxLength={12000}
              placeholder={`Describe a ${service.name.toLowerCase()} job…`}
              disabled={!!busy}
            />
            <Button
              variant="secondary"
              type="submit"
              loading={busy === 'read'}
              disabled={!note.trim() || !!busy}
            >
              Read these job details
            </Button>
          </form>
        </>
      )}
      {busy === 'load' && (
        <p className="quiet-loading" role="status">
          Opening your saved draft…
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {draft && (
        <ImportReview
          key={draft.id}
          draft={draft}
          onSaved={async (count, receipt) => {
            await onSaved(count, receipt);
            try {
              sessionStorage.removeItem(textKey);
              sessionStorage.removeItem(draftKey);
            } catch {
              /* Storage is optional. */
            }
          }}
          onChooseAnother={() => {
            setDraft(undefined);
            try {
              sessionStorage.removeItem(draftKey);
            } catch {
              /* Storage is optional. */
            }
          }}
          chooseAnotherLabel="Edit original note"
        />
      )}
    </section>
  );
}

function ShareAssistant({ service, data, user, refresh, notify }: Props & { service: Service }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const [tab, setTab] = useState<'link' | 'embed'>('link');
  const [copied, setCopied] = useState(false);
  const [verification, setVerification] = useState<{ delivery: string; devToken?: string }>();
  const verificationFlight = useRef(false);
  const areaDraftKey = `quotient:share-area:${data.business.id}:${user.id}:${service.id}`;
  const [areaDraft, setAreaDraft] = useState<{ key: string; value: string | null }>();
  const suggestedArea = (data.serviceAreaSuggestions?.[service.id] || '').slice(0, 500);
  const ownerArea = areaDraft?.key === areaDraftKey ? areaDraft.value : null;
  const areaValue = ownerArea ?? suggestedArea;
  useEffect(() => {
    let value: string | null = null;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(areaDraftKey) || 'null');
      if (saved?.version === 1 && typeof saved.value === 'string' && saved.value.length <= 500)
        value = saved.value;
    } catch {
      // The existing field remains editable when draft storage is unavailable.
    }
    setAreaDraft((current) =>
      current?.key === areaDraftKey ? current : { key: areaDraftKey, value },
    );
  }, [areaDraftKey]);
  function editArea(value: string) {
    setAreaDraft({ key: areaDraftKey, value });
    try {
      window.sessionStorage.setItem(areaDraftKey, JSON.stringify({ version: 1, value }));
    } catch {
      // Keep the owner's current value in this page without browser storage.
    }
  }
  const [automaticReadiness, setAutomaticReadiness] = useState<ServiceReadiness>();
  const receiveReadiness = useCallback(
    (value: ServiceReadiness | undefined) => {
      setAutomaticReadiness(
        value?.serviceId === service.id && value.serviceVersion === service.version
          ? value
          : undefined,
      );
    },
    [service.id, service.version],
  );
  const currentAutomaticReadiness =
    automaticReadiness?.serviceId === service.id &&
    automaticReadiness.serviceVersion === service.version
      ? automaticReadiness
      : undefined;
  const liveStatus =
    service.mode === 'review'
      ? 'You approve every price'
      : !currentAutomaticReadiness
        ? 'Quote requests open'
        : !currentAutomaticReadiness.approvalCurrent
          ? currentAutomaticReadiness.evaluationCurrent &&
            currentAutomaticReadiness.evaluation?.automaticReady
            ? 'Automatic quotes await your approval'
            : 'Automatic quotes need new checks'
          : currentAutomaticReadiness.autoQuoteEnabled && data.business.autoQuoteEnabled
            ? 'Approved automatic quotes'
            : 'You approve prices · Automatic quotes paused';
  useEffect(() => {
    if (user.emailVerified) return;
    const check = () => void refresh();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [user.emailVerified, refresh]);
  async function resendVerification() {
    if (verificationFlight.current) return;
    verificationFlight.current = true;
    setBusy('verify');
    setError('');
    try {
      const result = await api<{ ok: boolean; delivery: string; devToken?: string }>(
        '/auth/request-verification',
        { method: 'POST' },
      );
      setVerification(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      verificationFlight.current = false;
      setBusy('');
    }
  }

  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}/q/${data.business.slug}`;
  const embed = `<iframe src="${origin}/embed/${data.business.slug}" title="Request a quote from ${data.business.name.replace(/[<>&"]/g, '')}" width="100%" height="740" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
  async function publish(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!data.business.serviceArea.trim() && areaDraft?.key !== areaDraftKey) return;
    const submittedAreaDraft = ownerArea;
    setBusy('publish');
    setError('');
    try {
      if (!data.business.serviceArea.trim() || !data.business.description.trim()) {
        await api('/business', {
          method: 'PATCH',
          ...json({
            serviceArea: data.business.serviceArea.trim() || areaValue.trim(),
            description: data.business.description || service.description,
            onboardingComplete: true,
          }),
        });
      }
      await api(`/services/${service.id}/publish`, { method: 'POST', ...json({ mode: 'review' }) });
      await refresh();
      if (submittedAreaDraft !== null) {
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(areaDraftKey) || 'null');
          if (saved?.version === 1 && saved.value === submittedAreaDraft)
            window.sessionStorage.removeItem(areaDraftKey);
        } catch {
          // A successful publication does not depend on draft storage.
        }
        setAreaDraft((current) =>
          current?.key === areaDraftKey && current.value === submittedAreaDraft
            ? { key: areaDraftKey, value: null }
            : current,
        );
      }
      notify('Your quote link is live. You approve every price.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(tab === 'link' ? url : embed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Select the link or embed code and copy it.');
    }
  }
  async function pause() {
    setBusy('pause');
    setError('');
    try {
      await api(`/services/${service.id}/pause`, { method: 'POST' });
      await refresh();
      notify('This service is now private.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="share-canvas">
      <div className="canvas-intro">
        <h2>Share your quote link</h2>
        <p>
          {service.publishedAt
            ? 'Send your link or add the chat to your website.'
            : 'Customers describe the job. You approve the price.'}
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {!service.publishedAt ? (
        <form className="share-start" onSubmit={publish}>
          {!data.business.serviceArea.trim() && (
            <Field
              label="Where do you offer this service?"
              name="serviceArea"
              value={areaValue}
              onChange={(event) => editArea(event.target.value)}
              placeholder="City, region, or anywhere online"
              required
              maxLength={500}
            />
          )}
          <Button
            type="submit"
            loading={busy === 'publish'}
            disabled={!data.business.serviceArea.trim() && areaDraft?.key !== areaDraftKey}
          >
            Create my quote link <ArrowRight size={15} />
          </Button>
        </form>
      ) : (
        <section className="share-result">
          <span className="live-label">
            <span /> Live · {liveStatus}
          </span>
          <div className="share-tabs">
            <button
              className={tab === 'link' ? 'active' : ''}
              onClick={() => {
                setTab('link');
                setCopied(false);
              }}
            >
              Link
            </button>
            <button
              className={tab === 'embed' ? 'active' : ''}
              onClick={() => {
                setTab('embed');
                setCopied(false);
              }}
            >
              Website embed
            </button>
          </div>
          <label className="sr-only" htmlFor="share-code">
            {tab === 'link' ? 'Your quote link' : 'Website embed code'}
          </label>
          <textarea
            id="share-code"
            value={tab === 'link' ? url : embed}
            readOnly
            rows={tab === 'link' ? 1 : 4}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="share-result-actions">
            <Button onClick={() => void copy()}>
              <Copy size={15} />
              {copied ? 'Copied' : tab === 'link' ? 'Copy link' : 'Copy embed code'}
            </Button>
            <a href={url} target="_blank" rel="noreferrer">
              Open customer view <ExternalLink size={14} />
            </a>
          </div>
          <div className="share-alerts" aria-label="Email alerts">
            {user.emailVerified ? (
              <p>Email alerts are on for {user.email}.</p>
            ) : verification ? (
              <>
                <p>
                  {verification.delivery === 'local'
                    ? 'Local verification link ready. Development only.'
                    : `New verification email queued for ${user.email}. Use the newest link to receive request alerts.`}
                </p>
                {verification.devToken && (
                  <a
                    href={`/verify-email#token=${encodeURIComponent(verification.devToken)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open local verification link <ExternalLink size={14} />
                  </a>
                )}
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void resendVerification()}
                >
                  {busy === 'verify' ? 'Preparing email…' : 'Resend verification email'}
                </button>
              </>
            ) : (
              <>
                <p>
                  Use the link in your verification email to receive new request alerts at{' '}
                  {user.email}.
                </p>
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void resendVerification()}
                >
                  {busy === 'verify' ? 'Preparing email…' : 'Resend verification email'}
                </button>
              </>
            )}
          </div>
          <button className="text-button" disabled={!!busy} onClick={() => void pause()}>
            {busy === 'pause' ? 'Pausing…' : 'Make this service private'}
          </button>
        </section>
      )}
      <details className="automation-details">
        <summary>
          Want it to send quotes automatically? <ChevronDown size={15} />
        </summary>
        <div>
          <Publishing
            {...{ data, user, refresh, notify }}
            automaticOnly
            serviceId={service.id}
            onReadinessChange={receiveReadiness}
          />
        </div>
      </details>
    </div>
  );
}

function intakeLabel(value: string) {
  const text = value.trim();
  return /\s|\?/.test(text) ? text : humanLabel(text);
}
function uniqueIntakeLabels(fields: string[]) {
  const labels = new Map<string, string>();
  for (const field of fields) {
    const key = humanLabel(field);
    if (key && !labels.has(key)) labels.set(key, intakeLabel(field));
  }
  return [...labels.values()];
}
function humanLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
    .toLowerCase();
}
function ruleDescription(rule: PricingRule) {
  const field = humanLabel(rule.field),
    comparisons = {
      equals: 'is',
      not_equals: 'is not',
      contains: 'includes',
      gt: 'is more than',
      gte: 'is at least',
      lt: 'is less than',
      lte: 'is at most',
    };
  const condition =
    rule.value === 'true' && rule.operator === 'equals'
      ? `If ${field} is needed`
      : rule.value === 'false' && rule.operator === 'equals'
        ? `If ${field} is not needed`
        : `If ${field} ${comparisons[rule.operator]} “${rule.value}”`;
  if (rule.kind === 'review') return `${condition}, ask you to review the price.`;
  if (rule.kind === 'percent')
    return `${condition}, ${rule.amount >= 0 ? 'add' : 'deduct'} ${Math.abs(rule.amount) / 100}%.`;
  return `${condition}, ${rule.amount >= 0 ? 'add' : 'deduct'} ${money(Math.abs(rule.amount))}${rule.kind === 'per_unit' ? ' per unit' : ''}.`;
}
