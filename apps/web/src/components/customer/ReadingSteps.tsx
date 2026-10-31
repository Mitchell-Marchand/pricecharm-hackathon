'use client';

import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { BusinessMark } from '@/components/Chat';
import { Avatar } from '@/components/ui';
import type { BusinessProfile, ReadingProgress } from '@/lib/chat';
import { cx } from '@/lib/util';

type Step = ReadingProgress['step'];
/**
 * A reading's steps in order, each with how far along the bar is once it's done and about how long
 * it takes, from timing real readings: a 20-second video is about a minute, photos about 25 s.
 */
type Plan = { step: Step; done: number; seconds: number }[];
const VIDEO: Plan = [
  { step: 'preparing', done: 12, seconds: 8 },
  { step: 'watching', done: 35, seconds: 13 },
  { step: 'counting', done: 80, seconds: 25 },
  { step: 'checking', done: 90, seconds: 6 },
  { step: 'replying', done: 100, seconds: 7 },
];
const PHOTOS: Plan = [
  { step: 'watching', done: 55, seconds: 12 },
  { step: 'counting', done: 85, seconds: 6 },
  { step: 'replying', done: 100, seconds: 6 },
];

const list = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');

function label(step: Step, progress: ReadingProgress | null, photos: boolean) {
  const counting = progress?.counting ?? [];
  if (step === 'preparing') return 'Getting your video ready';
  if (step === 'watching') return photos ? 'Looking over your photos' : 'Watching your video';
  if (step === 'counting')
    return counting.length ? `Counting the ${list(counting)}` : 'Counting what sets the price';
  // Once it has watched and found nothing to count, there's nothing to look at one by one.
  if (step === 'checking')
    return progress?.seen !== undefined && !counting.length
      ? 'Checking the details'
      : 'Looking at each one up close';
  return 'Writing back';
}

/**
 * What the customer sees while their video or photos are read: each step as it happens, what was
 * seen and counted so far, and a bar that moves at about the pace a reading usually takes. Nothing
 * on it is made up: the steps and what's seen come from the reading itself.
 */
export function ReadingSteps({
  profile,
  photos,
  progress,
}: {
  profile: BusinessProfile;
  photos: boolean;
  progress: ReadingProgress | null;
}) {
  const plan = photos ? PHOTOS : VIDEO;
  // Photos are looked at up close while they're counted, so their "checking" is still counting.
  const step = photos && progress?.step === 'checking' ? 'counting' : progress?.step;
  const at = Math.max(
    0,
    plan.findIndex((item) => item.step === step),
  );
  const from = at ? plan[at - 1].done : 0;
  // It creeps most of the way to the step's end over its usual time, then waits for the real end.
  const bar = {
    '--from': `${from}%`,
    '--to': `${from + (plan[at].done - from) * 0.9}%`,
    animationDuration: `${plan[at].seconds}s`,
  } as CSSProperties;
  const seen = progress?.seen?.trim();
  const found = progress?.found ?? [];

  return (
    <div className="fade-up flex items-end gap-2.5" role="status" aria-live="polite">
      <div className="w-9 shrink-0">
        {profile.logo ? (
          <BusinessMark initials={profile.initials} logo={profile.logo} square />
        ) : (
          <Avatar initials={profile.initials} tone="blue" />
        )}
      </div>
      <div className="w-full max-w-[340px] min-w-0 rounded-[16px] rounded-bl-[4px] border border-line bg-surface px-4 py-3.5 shadow-1">
        <ol className="flex flex-col gap-2">
          {plan.map((item, index) => (
            <li
              key={item.step}
              className={cx(
                'flex items-center gap-2.5 text-[14.5px] leading-snug',
                index < at ? 'text-ink-2' : index === at ? 'font-medium text-ink' : 'text-muted',
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {index < at ? (
                  <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-accent">
                    <Check className="size-3" strokeWidth={3} aria-hidden />
                  </span>
                ) : index === at ? (
                  <span
                    className="size-4 animate-spin rounded-full border-2 border-accent-soft border-t-accent"
                    aria-hidden
                  />
                ) : (
                  <span className="size-2 rounded-full bg-line-strong" aria-hidden />
                )}
              </span>
              <span>
                {label(item.step, progress, photos)}
                {index < at && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          ))}
        </ol>

        <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div key={at} className="reading-bar h-full rounded-full bg-accent" style={bar} />
        </div>

        {(seen || found.length > 0) && (
          <div className="mt-3.5 flex flex-col gap-1.5 border-t border-line pt-3 text-[13.5px] leading-[1.5] text-ink-2">
            {found.length > 0 && (
              <p className="fade-up">
                <span className="font-medium text-ink">Found so far:</span> {found.join(', ')}
              </p>
            )}
            {seen && (
              <p className="fade-up">
                <span className="font-medium text-ink">
                  {photos ? 'In your photos:' : 'In your video:'}
                </span>{' '}
                {seen}
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-muted">
          {photos
            ? 'This usually takes under half a minute.'
            : 'This usually takes about a minute.'}
        </p>
      </div>
    </div>
  );
}
