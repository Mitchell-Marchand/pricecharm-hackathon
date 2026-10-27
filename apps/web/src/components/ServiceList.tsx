'use client';

import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui';
import type { ServiceReadiness } from '@/lib/account';
import { joinList } from '@/lib/util';

/** "2 more jobs", or just "2 jobs" before there's been any. */
const count = (amount: number, more: boolean, what: string) =>
  `${amount}${more ? ' more' : ''} ${what}${amount === 1 ? '' : 's'}`;

/** Where one service stands, in a line: sending on its own, or what it's waiting for. */
function standing(item: ServiceReadiness, autoSend: boolean) {
  if (item.ready)
    return autoSend
      ? `Sends quotes on its own for jobs from ${item.covers}.`
      : `Ready for jobs from ${item.covers}. Turn on automatic quotes in Settings.`;
  if (item.jobsToGo)
    return `Checks with you until it has ${count(item.jobsToGo, item.sizedPrices > 0, `${item.service} job`)} with a size.`;
  return `Checks with you until it comes within 15% of your price on ${count(item.matchesToGo, item.checked > 0, 'job')}.`;
}

/** The opening line above the list: what goes out on its own, and how the rest get there. */
export function ServicesIntro({
  services,
  autoSend,
}: {
  services: ServiceReadiness[];
  autoSend: boolean;
}) {
  const ready = services.filter((item) => item.ready).map((item) => item.service);
  if (!ready.length)
    return (
      <p className="mt-2 max-w-2xl text-ink-2">
        <span className="font-semibold text-ink">You&apos;ll approve each quote for now.</span> A
        service starts sending on its own once it knows three of your jobs with a size and comes
        within 15% of your price twice. Practice counts, and so does every quote you approve.
      </p>
    );
  return (
    <p className="mt-2 max-w-2xl text-ink-2">
      <span className="font-semibold text-ink">
        {joinList(ready)} quotes {autoSend ? 'will go out' : 'can go out'} on their own
        {autoSend ? '.' : ' once you turn on automatic quotes in Settings.'}
      </span>{' '}
      {ready.length < services.length && 'The rest wait for your OK. '}
      Anything unusual always waits for you.
    </p>
  );
}

/**
 * Each service the owner offers and whether its quotes go out on their own. One that isn't there
 * yet offers the quickest way to get it there: a job to add, or a practice customer.
 */
export function ServiceList({
  services,
  autoSend,
  busy,
  onAddJob,
  onPractice,
}: {
  services: ServiceReadiness[];
  autoSend: boolean;
  /** The service a practice customer is being started for. */
  busy?: string | null;
  onAddJob: (service: string) => void;
  onPractice: (service: string) => void;
}) {
  return (
    <ul
      className="mt-5 max-w-3xl divide-y divide-line border-y border-line"
      aria-label="Your services"
    >
      {services.map((item) => (
        <li
          key={item.service}
          className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold">
              {item.service}
              {item.ready && <CircleCheck className="size-4 text-go" aria-label="Ready" />}
            </p>
            <p className="mt-0.5 text-[15px] text-ink-2">{standing(item, autoSend)}</p>
          </div>
          {!item.ready && (
            <div className="flex shrink-0 gap-2">
              {item.jobsToGo > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAddJob(item.service)}
                  aria-label={`Add a ${item.service} job`}
                >
                  Add a job
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => onPractice(item.service)}
                aria-label={`Practice a ${item.service} job`}
              >
                {busy === item.service ? 'Starting…' : 'Practice one'}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
