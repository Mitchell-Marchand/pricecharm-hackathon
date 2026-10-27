'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy, Inbox } from 'lucide-react';
import { CharmCard } from '@/components/Charm';
import { useOwner } from '@/components/owner/OwnerShell';
import { GoLiveCard } from '@/components/owner/GoLiveCard';
import { QuoteStatusTag } from '@/components/owner/QuoteStatus';
import { TryCharm } from '@/components/TryCharm';
import { useToast } from '@/components/Toast';
import { Button, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import {
  listQuotes,
  loadBilling,
  loadHome,
  type Billing,
  type Home,
  type QuoteFilter,
  type QuoteListItem,
} from '@/lib/owner';
import type { CharmView } from '@/lib/account';
import { cx, money, shortDate } from '@/lib/util';

const FILTERS: { id: QuoteFilter; label: string }[] = [
  { id: 'review', label: 'Needs your OK' },
  { id: 'sent', label: 'Sent' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'all', label: 'All' },
];

export default function QuotesHome() {
  const { me } = useOwner();
  const notify = useToast();
  const [home, setHome] = useState<Home | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [filter, setFilter] = useState<QuoteFilter | null>(null);
  const [quotes, setQuotes] = useState<QuoteListItem[] | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadHome()
      .then((loaded) => {
        setHome(loaded);
        setFilter((current) => current ?? (loaded.counts.needsOk ? 'review' : 'all'));
      })
      .catch((loadError) => setError(errorMessage(loadError)));
    // Only to show what's stopping quotes from going out; the list works without it.
    loadBilling()
      .then(setBilling)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!filter) return;
    setQuotes(null);
    listQuotes(filter)
      .then(setQuotes)
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [filter]);

  if (error)
    return (
      <p className="text-stop" role="alert">
        {error}
      </p>
    );
  if (!home || !filter) return <div className="shimmer h-40 rounded-md" aria-busy="true" />;

  const waiting = home.counts.needsOk;
  // Missing from an API older than this page, as when web and API deploy a moment apart.
  const charm: CharmView | null =
    home.readiness && home.settings && home.services
      ? { readiness: home.readiness, settings: home.settings, services: home.services }
      : null;
  const link = `${window.location.origin}/q/${home.business.slug}`;
  const firstName = me.user.firstName || me.user.name.split(' ')[0];

  return (
    <>
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-muted">Hi {firstName}</p>
          <h1 className="t-h1 mt-1">
            {waiting === 0
              ? 'You’re all caught up.'
              : waiting === 1
                ? '1 quote needs your OK.'
                : `${waiting} quotes need your OK.`}
          </h1>
          <p className="mt-3 max-w-xl text-ink-2">
            {home.autoSend
              ? 'Your Charm quotes customers on its own. Anything unusual waits here for you.'
              : 'Every quote waits here for your OK.'}
          </p>
        </div>
        <dl className="flex gap-8">
          <div>
            <dt className="t-label text-muted">Sent this month</dt>
            <dd className="tabular mt-1 font-display text-3xl font-[800]">
              {home.counts.sentThisMonth}
            </dd>
          </div>
          <div>
            <dt className="t-label text-muted">Accepted</dt>
            <dd className="tabular mt-1 font-display text-3xl font-[800]">
              {home.counts.acceptedThisMonth}
            </dd>
          </div>
        </dl>
      </div>

      {billing && <GoLiveCard billing={billing} onChange={setBilling} className="mt-8" />}
      {charm && (
        <CharmCard
          className="mt-8"
          charm={charm}
          onChange={(next) => {
            setHome({ ...home, autoSend: next.settings.autoSend, settings: next.settings });
          }}
          compact
          moreHref="/app/train"
        />
      )}

      <div className="mt-10 flex flex-wrap gap-1.5" role="tablist" aria-label="Show quotes">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={cx(
              'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium',
              filter === item.id
                ? 'border-ink bg-ink text-on-ink'
                : 'border-line-strong text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
            {item.id === 'review' && waiting > 0 && (
              <span className="tabular rounded-full bg-canary px-1.5 text-xs text-on-canary">
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-4">
        {quotes === null ? (
          <div className="shimmer h-24 rounded-md" aria-busy="true" />
        ) : quotes.length === 0 ? (
          <div className="rounded-md border border-dashed border-line-strong bg-surface p-6">
            <Inbox className="size-7 text-accent" aria-hidden />
            <h2 className="t-h3 mt-3">
              {filter === 'review'
                ? 'Nothing waiting for you.'
                : filter === 'all'
                  ? 'No quotes yet.'
                  : 'None here yet.'}
            </h2>
            <p className="mt-1 text-ink-2">
              {filter === 'all'
                ? 'Share your quote link and your first customers will show up here.'
                : 'Quotes show up here as customers ask for them.'}
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-md border border-line bg-surface">
            {quotes.map((quote) => (
              <li key={quote.id} className="border-b border-line last:border-0">
                <Link
                  href={`/app/quotes/${quote.id}`}
                  className="flex items-center gap-4 px-4 py-4 hover:bg-surface-2 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{quote.customer}</span>
                      <QuoteStatusTag status={quote.status} />
                      {quote.test && <Tag>Test</Tag>}
                    </p>
                    <p className="mt-1 truncate text-sm text-muted">
                      {[quote.serviceName, `No. ${quote.number}`, shortDate(quote.createdAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {quote.status === 'review' && quote.reviewReason && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-ink-2">{quote.reviewReason}</p>
                    )}
                  </div>
                  <p className="tabular font-mono text-lg font-semibold">
                    {quote.range
                      ? `${money(quote.range.lowCents)}–${money(quote.range.highCents)}`
                      : money(quote.totalCents)}
                  </p>
                  <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section
        className="mt-10 flex flex-col gap-4 rounded-md border border-line bg-surface p-5 sm:flex-row sm:items-center sm:justify-between"
        aria-label="Your quote link"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold">Your quote link</p>
          <p className="mt-1 truncate font-mono text-[15px] text-ink-2">
            {link.replace(/^https?:\/\//, '')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              navigator.clipboard
                ?.writeText(link)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                })
                .catch(() => notify('Copy is blocked here. Select the link and copy it.'))
            }
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copied' : 'Copy'}
          </Button>
          <TryCharm slug={home.business.slug} variant="ghost" size="md">
            Try it as a customer
          </TryCharm>
        </div>
      </section>
    </>
  );
}
