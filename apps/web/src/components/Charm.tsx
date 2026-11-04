'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Circle } from 'lucide-react';
import { buttonClass } from '@/components/button-class';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui';
import {
  loadCharm,
  saveCharm,
  type CharmSettings,
  type CharmView,
  type LearningStyle,
  type ReadinessStep,
  type ServiceReadiness,
} from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { article, cx } from '@/lib/util';

const STORE = 'pricecharm:readiness';

/** What a service still learning sends, in a few words. */
export const LEARNING_TEXT: Record<LearningStyle, string> = {
  range: 'a price range',
  estimate: 'an estimate',
  firm: 'a firm price',
};

/**
 * The Charm's score, settings and services, loaded fresh whenever `refreshKey` changes. The same
 * endpoint works during setup and after, so every screen shows the same numbers.
 */
export function useCharm(refreshKey: unknown = 0) {
  const [charm, setCharm] = useState<CharmView | null>(null);
  useEffect(() => {
    let live = true;
    loadCharm()
      .then((view) => live && setCharm(view))
      // An API from before the Charm card: the page works without it.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return [charm, setCharm] as const;
}

/**
 * Points gained since this browser last showed this business's score, so training feels like it's
 * going somewhere. Kept per business, so a second account in the same browser starts fresh.
 */
function useGained(score: number | null, businessId: string | undefined) {
  const [gained, setGained] = useState(0);
  useEffect(() => {
    if (score === null || !businessId) return;
    try {
      const key = `${STORE}:${businessId}`;
      const last = Number(localStorage.getItem(key));
      if (last && score > last) setGained(score - last);
      localStorage.setItem(key, String(score));
    } catch {
      // Private browsing: no running tally, and nothing else changes.
    }
  }, [score, businessId]);
  return gained;
}

export function Meter({
  score,
  mark,
  size = 'md',
}: {
  score: number;
  mark: number;
  /** `line` runs edge to edge under a header. */
  size?: 'line' | 'sm' | 'md';
}) {
  const line = size === 'line';
  return (
    <div
      role="meter"
      aria-label="How trained your Charm is"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      className={cx(
        'relative bg-line',
        line ? 'h-[3px]' : 'rounded-full',
        size === 'sm' && 'h-1.5',
        size === 'md' && 'h-2',
      )}
    >
      <span
        className={cx(
          'block h-full bg-go transition-[width] duration-500',
          line ? 'rounded-r-full' : 'rounded-full',
        )}
        style={{ width: `${score}%` }}
      />
      {mark < 100 && (
        <span
          className={cx(
            'absolute -top-1 w-0.5 rounded-full bg-ink/40',
            line ? 'bottom-0' : '-bottom-1',
          )}
          style={{ left: `${mark}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}

/** Whether the Charm is still learning, and what goes out until it isn't. */
function standing(score: number, settings: CharmSettings) {
  if (score >= 100) return 'Fully trained. Anything unusual is still flagged for you.';
  if (score >= settings.trainedPercent)
    return `Trained enough for firm prices on the work you do most. Services under ${settings.trainedPercent}% get ${LEARNING_TEXT[settings.learningStyle]}.`;
  return settings.learningStyle === 'firm'
    ? 'Still learning your prices. It sends firm prices anyway, as you chose.'
    : `Still learning your prices, so customers get ${LEARNING_TEXT[settings.learningStyle]} for services under ${settings.trainedPercent}%.`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * One step in plain words: "Add 2 more Deck staining jobs with a size", or "Add 3 Patios jobs
 * with a size" when it has none yet.
 */
export function stepText(step: ReadinessStep, service?: ServiceReadiness) {
  const count = step.count ?? 1;
  const started = step.action === 'job' ? service?.sizedPrices : service?.checked;
  const how = count > 1 ? (started === 0 ? String(count) : `${count} more`) : article(step.service);
  const jobs = `${step.service} ${count > 1 ? 'jobs' : 'job'}`;
  return step.action === 'job' ? `Add ${how} ${jobs} with a size` : `Practice ${how} ${jobs}`;
}

const gainText = (step: ReadinessStep) => `+${step.gain}%${(step.count ?? 1) > 1 ? ' each' : ''}`;

/**
 * The switch that lets the Charm quote customers on its own. It's the owner's call: while the
 * score is under their mark, it recommends having quotes wait, and says so once.
 */
export function CharmSwitch({
  score,
  settings,
  onChange,
}: {
  score: number;
  settings: CharmSettings;
  onChange: (patch: Partial<CharmSettings>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const learning = score < settings.trainedPercent;
  const set = (autoSend: boolean) => {
    setBusy(true);
    onChange({ autoSend }).finally(() => setBusy(false));
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="charm-switch" className="font-semibold">
            Quotes customers on its own
          </p>
          <p className="mt-0.5 text-[15px] text-ink-2">
            {settings.autoSend
              ? 'Customers get a quote in about 2 minutes. Unusual jobs are flagged for you.'
              : 'Every quote waits for your OK first. One tap from your email sends it.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.autoSend}
          aria-labelledby="charm-switch"
          disabled={busy}
          onClick={() => set(!settings.autoSend)}
          className={cx(
            'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-60',
            settings.autoSend ? 'bg-go' : 'bg-line-strong',
          )}
        >
          <span
            className={cx(
              'inline-block size-5 rounded-full bg-surface shadow-1 transition-transform',
              settings.autoSend ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>
      {settings.autoSend && learning && (
        <div className="mt-3 flex flex-col items-start gap-1.5 rounded-sm bg-canary-soft px-3 py-2.5 text-[15px]">
          <p>
            <span className="font-semibold">Recommended:</span> while it&apos;s under{' '}
            {settings.trainedPercent}%, have it check with you first.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => set(false)}
            className="font-semibold text-accent underline underline-offset-4 disabled:opacity-60"
          >
            Check with me first
          </button>
        </div>
      )}
      {!settings.autoSend && !learning && (
        <p className="mt-3 rounded-sm bg-go-soft px-3 py-2.5 text-[15px]">
          It&apos;s at {score}%, past your {settings.trainedPercent}% mark. It&apos;s ready to quote
          on its own whenever you are.
        </p>
      )}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  href,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (onClick)
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </Button>
    );
  return href ? (
    <Link href={href} className={buttonClass('secondary', 'sm')} aria-label={label}>
      {children}
    </Link>
  ) : null;
}

/** One service: how well it knows it, what customers get, and the quickest way to raise it. */
function ServiceRow({
  service,
  step,
  settings,
  busy,
  onStep,
  stepHref,
}: {
  service: ServiceReadiness;
  step: ReadinessStep | undefined;
  settings: CharmSettings;
  /** The service a practice customer is being started for, if any. */
  busy: string | null;
  onStep?: (step: ReadinessStep) => void;
  stepHref?: string;
}) {
  const firm = service.progress >= settings.trainedPercent || settings.learningStyle === 'firm';
  const gets = firm
    ? service.covers
      ? `Firm prices for ${service.covers}.`
      : 'Firm prices.'
    : `Customers get ${LEARNING_TEXT[settings.learningStyle]} for now.`;
  return (
    <li className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 gap-3">
        {service.ready ? (
          <Check className="mt-0.5 size-5 shrink-0 text-go" aria-label="Fully trained" />
        ) : (
          <Circle className="mt-0.5 size-5 shrink-0 text-line-strong" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="font-semibold">
            {service.service}{' '}
            <span className="tabular font-normal text-muted">{service.progress}%</span>
          </p>
          <p className="mt-0.5 text-[15px] text-ink-2">
            {gets}
            {step && (
              <>
                {' '}
                {stepText(step, service)}. <span className="text-go">{gainText(step)}</span>
              </>
            )}
          </p>
        </div>
      </div>
      {step && (onStep || stepHref) && (
        <div className="flex shrink-0 gap-2">
          {/* While it's short of jobs, practice still counts, so both are offered. */}
          {step.action === 'job' && (
            <StepButton
              label={`Add ${article(service.service)} ${service.service} job`}
              onClick={onStep && (() => onStep(step))}
              href={stepHref}
            >
              Add a job
            </StepButton>
          )}
          <StepButton
            label={`Practice ${article(service.service)} ${service.service} job`}
            onClick={onStep && (() => onStep({ ...step, action: 'practice' }))}
            href={stepHref}
            disabled={Boolean(busy)}
          >
            {busy === service.service ? 'Starting…' : 'Practice one'}
          </StepButton>
        </div>
      )}
    </li>
  );
}

/**
 * The Charm, the same everywhere it shows: how trained it is, whether it quotes on its own, and
 * what would get it to 100%. Compact shows only the next step, with a link to the rest.
 */
export function CharmCard({
  charm,
  onChange,
  onStep,
  stepHref,
  busyService,
  compact = false,
  moreHref,
  className,
}: {
  charm: CharmView;
  /** Saved settings come back here. Without it there's no switch. */
  onChange?: (charm: CharmView) => void;
  /** Takes a step right here, like opening the job form. */
  onStep?: (step: ReadinessStep) => void;
  /** Or a page to take steps on. */
  stepHref?: string;
  /** The service a practice customer is being started for. */
  busyService?: string | null;
  compact?: boolean;
  /** Where the full card is, from the compact one. */
  moreHref?: string;
  className?: string;
}) {
  const notify = useToast();
  const { readiness, services, settings } = charm;
  const { score } = readiness;
  const gained = useGained(score, charm.businessId);
  const steps = readiness.steps ?? (readiness.next ? [readiness.next] : []);
  const stepFor = (service: string) =>
    steps.find((step) => step.service.toLowerCase() === service.toLowerCase());
  // Services that need the most first, then the ones that are done.
  const ordered = [
    ...steps.flatMap((step) => services.filter((item) => item.service === step.service)),
    ...services.filter((item) => !stepFor(item.service)),
  ];
  const save = useCallback(
    async (patch: Partial<CharmSettings>) => {
      try {
        const next = await saveCharm(patch);
        onChange?.(next);
        if (patch.autoSend !== undefined)
          notify(
            patch.autoSend
              ? 'Your Charm quotes customers on its own.'
              : 'Every quote waits for your OK.',
          );
      } catch (error) {
        notify(errorMessage(error));
      }
    },
    [onChange, notify],
  );
  const next = steps[0];

  return (
    <section
      className={cx('rounded-md border border-line bg-surface p-5 sm:p-6', className)}
      aria-labelledby="charm-title"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="charm-title" className="t-h3">
          Your Charm
        </h2>
        <p className="tabular font-display text-3xl font-[800]">{score}%</p>
      </div>
      <div className="mt-3">
        <Meter score={score} mark={settings.trainedPercent} />
      </div>
      <p className="mt-3 text-[15px] text-ink-2">{standing(score, settings)}</p>
      {gained > 0 && (
        <p className="mt-1 text-sm font-semibold text-go">Up {gained} since you last looked.</p>
      )}

      {onChange && (
        <div className="mt-5 border-t border-line pt-5">
          <CharmSwitch score={score} settings={settings} onChange={save} />
        </div>
      )}

      {compact
        ? next && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
              <p className="text-[15px]">
                <span className="font-semibold">Next:</span>{' '}
                {stepText(
                  next,
                  services.find((item) => item.service === next.service),
                )}
                . <span className="text-go">{gainText(next)}</span>
              </p>
              {moreHref && (
                <Link href={moreHref} className={buttonClass('secondary', 'sm')}>
                  Keep training
                </Link>
              )}
            </div>
          )
        : services.length > 0 && (
            <div className="mt-5 border-t border-line pt-5">
              <h3 className="font-semibold">{score < 100 ? 'Get to 100%' : 'Your services'}</h3>
              <ul className="mt-1 divide-y divide-line" aria-label="Your services">
                {ordered.map((service) => (
                  <ServiceRow
                    key={service.service}
                    service={service}
                    step={stepFor(service.service)}
                    settings={settings}
                    busy={busyService ?? null}
                    onStep={onStep}
                    stepHref={stepHref}
                  />
                ))}
              </ul>
            </div>
          )}
    </section>
  );
}

/** The score in a line, for the setup header: it moves as jobs and practice go in. */
export function CharmMeter({ refreshKey }: { refreshKey: unknown }) {
  const [charm] = useCharm(refreshKey);
  const last = useRef<number | null>(null);
  const [gain, setGain] = useState(0);
  const score = charm?.readiness.score ?? null;
  useEffect(() => {
    if (score === null) return;
    const before = last.current;
    last.current = score;
    if (before === null || score <= before) return;
    setGain(score - before);
    const timer = window.setTimeout(() => setGain(0), 2400);
    return () => window.clearTimeout(timer);
  }, [score]);
  if (!charm || score === null) return null;
  return (
    <div className="flex w-36 flex-col gap-1.5 sm:w-44" aria-live="polite">
      <p className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">Your Charm</span>
        <span className="tabular">
          {gain > 0 && <span className="mr-1.5 font-semibold text-go">+{gain}</span>}
          {score}%
        </span>
      </p>
      <Meter score={score} mark={charm.settings.trainedPercent} size="sm" />
    </div>
  );
}
