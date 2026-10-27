'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Download, LogOut } from 'lucide-react';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { useOwner } from '@/components/owner/OwnerShell';
import { PlanCards } from '@/components/owner/PlanCards';
import { Sheet } from '@/components/Sheet';
import { useToast } from '@/components/Toast';
import { LEARNING_TEXT } from '@/components/Charm';
import { Button, Field, MoneyInput, Segmented, SelectInput, TextInput } from '@/components/ui';
import { logout, OLD_SETTINGS, type CharmSettings, type LearningStyle } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import {
  choosePlan,
  deleteAccount,
  loadBilling,
  loadHome,
  openBillingPortal,
  saveSettings,
  saveSpendingCap,
  setLinkOn,
  startCheckout,
  type Billing,
} from '@/lib/owner';
import { planDetail, planName, type Plan } from '@/lib/plans';
import { money, moneyInput, parseMoney, shortDate } from '@/lib/util';

const TRAINED_MARKS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

const LEARNING_HINT: Record<LearningStyle, string> = {
  range: 'Like “$380 to $460”. You confirm the final price before starting.',
  estimate: 'One price, marked as an estimate. You confirm the final price before starting.',
  firm: 'The price it works out, as a firm quote, even while it’s learning.',
};

function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-6 border-t border-line py-10 first:border-0 first:pt-0 md:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <h2 className="t-h3">{title}</h2>
        {intro && <p className="mt-2 text-sm text-muted">{intro}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const { me } = useOwner();
  const notify = useToast();
  const router = useRouter();
  const [charm, setCharm] = useState<CharmSettings | null>(null);
  const [limit, setLimit] = useState('');
  const [billing, setBilling] = useState<Billing | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadHome()
      .then((home) => {
        const settings = home.settings ?? {
          ...OLD_SETTINGS,
          autoSend: home.autoSend,
          limitCents: home.autoSendLimitCents,
        };
        setCharm(settings);
        setLimit(moneyInput(settings.limitCents));
      })
      .catch((loadError) => setError(errorMessage(loadError)));
    loadBilling()
      .then((loaded) => {
        setBilling(loaded);
        setCap(moneyInput(loaded.spendingCapCents));
      })
      .catch((loadError) => setError(errorMessage(loadError)));
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') === 'active') {
      notify('Billing is set up. Quotes can go out to customers now.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [notify]);

  /** Saves one change right away, and puts it back if it doesn't save. */
  const change = (patch: Partial<CharmSettings>, saved: (settings: CharmSettings) => string) => {
    if (!charm) return;
    const before = charm;
    setCharm({ ...charm, ...patch });
    saveSettings(patch)
      .then((next) => {
        setCharm(next);
        setLimit(moneyInput(next.limitCents));
        notify(saved(next));
      })
      .catch((saveError) => {
        setCharm(before);
        setLimit(moneyInput(before.limitCents));
        notify(errorMessage(saveError));
      });
  };

  // Empty is no limit. Anything else has to be a price.
  const saveLimit = () => {
    if (!charm) return;
    const cents = limit.trim() ? parseMoney(limit) : null;
    if (limit.trim() && cents === null) return setLimit(moneyInput(charm.limitCents));
    if (cents === charm.limitCents) return;
    change({ limitCents: cents }, (next) =>
      next.limitCents === null
        ? 'Saved. No price limit.'
        : `Saved. Quotes over ${money(next.limitCents)} wait for you.`,
    );
  };

  const go = (request: () => Promise<{ url: string }>) =>
    request()
      .then(({ url }) => window.location.assign(url))
      .catch((billingError) => notify(errorMessage(billingError)));

  return (
    <>
      <h1 className="t-h1">Settings</h1>
      {error && (
        <p className="mt-4 text-stop" role="alert">
          {error}
        </p>
      )}

      <div className="mt-10">
        <Section
          title="Your Charm"
          intro="How it quotes your customers. Unusual jobs, and anyone who asks for you, always come to you first."
        >
          {charm === null ? (
            <div className="shimmer h-24 rounded-md" />
          ) : (
            <div className="flex flex-col gap-7">
              <Field
                label="Quotes customers on its own"
                htmlFor="settings-auto"
                hint={
                  charm.autoSend
                    ? 'Customers get a quote in about 2 minutes, day or night.'
                    : 'Every quote waits for your OK. One tap from your email sends it.'
                }
              >
                <div id="settings-auto">
                  <Segmented
                    label="Quotes customers on its own"
                    value={charm.autoSend ? 'on' : 'off'}
                    onChange={(value) =>
                      change({ autoSend: value === 'on' }, (next) =>
                        next.autoSend
                          ? 'Your Charm quotes customers on its own.'
                          : 'Every quote waits for your OK.',
                      )
                    }
                    options={[
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Check with me first' },
                    ]}
                  />
                </div>
              </Field>
              <Field
                label="Firm prices once a service is"
                htmlFor="settings-trained"
                hint="How trained your Charm has to be on a service before it gives firm prices for it."
              >
                <SelectInput
                  id="settings-trained"
                  className="max-w-48"
                  value={charm.trainedPercent}
                  onChange={(event) =>
                    change(
                      { trainedPercent: Number(event.target.value) },
                      (next) => `Saved. Firm prices from ${next.trainedPercent}%.`,
                    )
                  }
                >
                  {TRAINED_MARKS.map((mark) => (
                    <option key={mark} value={mark}>
                      {mark}% trained
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field
                label="Before then, customers get"
                htmlFor="settings-learning"
                hint={LEARNING_HINT[charm.learningStyle]}
              >
                <div id="settings-learning">
                  <Segmented<LearningStyle>
                    label="Before then, customers get"
                    value={charm.learningStyle}
                    onChange={(value) =>
                      change(
                        { learningStyle: value },
                        (next) => `Saved. Customers get ${LEARNING_TEXT[next.learningStyle]}.`,
                      )
                    }
                    options={[
                      { value: 'range', label: 'A price range' },
                      { value: 'estimate', label: 'An estimate' },
                      { value: 'firm', label: 'A firm price' },
                    ]}
                  />
                </div>
              </Field>
              <Field
                label="Always check with me about quotes over"
                htmlFor="settings-limit"
                optional
                hint="Leave it empty for no limit."
              >
                <MoneyInput
                  id="settings-limit"
                  className="max-w-48"
                  placeholder="No limit"
                  value={limit}
                  onChange={setLimit}
                  onBlur={saveLimit}
                />
              </Field>
            </div>
          )}
        </Section>

        <Section
          title="Billing"
          intro="You pay a small fee for each quote a customer receives. Setup, practice and your own tests are free."
        >
          {!billing ? (
            <div className="shimmer h-32 rounded-md" />
          ) : (
            <BillingDetails
              billing={billing}
              cap={cap}
              setCap={setCap}
              onChange={setBilling}
              go={go}
            />
          )}
        </Section>

        <Section title="Account">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">Name</dt>
              <dd className="mt-0.5 font-medium">{me.user.name}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Email</dt>
              <dd className="mt-0.5 font-medium break-all">{me.user.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Business</dt>
              <dd className="mt-0.5 font-medium">{me.business.name}</dd>
            </div>
          </dl>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                logout()
                  .catch(() => {})
                  .finally(() => router.replace('/login'))
              }
            >
              <LogOut aria-hidden /> Sign out
            </Button>
            <a
              href="/api/v1/account/export"
              download="pricecharm-export.json"
              className="inline-flex h-11 items-center gap-2 rounded-sm px-4 text-[15px] font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink [&_svg]:size-[1.1em]"
            >
              <Download aria-hidden /> Download your data
            </a>
          </div>
          <div className="mt-10 rounded-md border border-stop/30 p-4">
            <p className="font-semibold">Delete your account</p>
            <p className="mt-1 text-sm text-ink-2">
              Your quote link and widget stop working right away. We delete your information, and
              backup copies are overwritten within 30 days.
            </p>
            <Button
              variant="secondary"
              className="mt-4 text-stop"
              onClick={() => setDeleting(true)}
            >
              Delete account
            </Button>
          </div>
        </Section>
      </div>

      <DeleteSheet
        open={deleting}
        business={me.business.name}
        onClose={() => setDeleting(false)}
        onDeleted={() => router.replace('/')}
      />
    </>
  );
}

function BillingDetails({
  billing,
  cap,
  setCap,
  onChange,
  go,
}: {
  billing: Billing;
  cap: string;
  setCap: (value: string) => void;
  onChange: (billing: Billing) => void;
  go: (request: () => Promise<{ url: string }>) => void;
}) {
  const notify = useToast();
  const [picking, setPicking] = useState(!billing.plan);
  const [busy, setBusy] = useState<Plan | null>(null);
  const paying = billing.status === 'active' || billing.status === 'trialing';
  const { pricing } = billing;

  // With a card on file it's a switch. Without one, choosing a plan goes on to adding a card.
  async function choose(plan: Plan) {
    setBusy(plan);
    try {
      const saved = await choosePlan(plan);
      onChange(saved);
      if (!paying && saved.checkoutAvailable) return go(startCheckout);
      setPicking(false);
      notify(
        saved.nextPlan && saved.periodEnd
          ? `You’ll move to ${planName(saved.nextPlan, pricing)} on ${shortDate(saved.periodEnd)}.`
          : `You’re on ${planName(plan, pricing)}.`,
      );
    } catch (planError) {
      notify(errorMessage(planError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-md border border-line bg-surface p-4">
        <p className="font-semibold">
          {billing.plan ? planName(billing.plan, pricing) : 'No plan yet.'}
        </p>
        <p className="mt-1 text-sm text-ink-2">
          {billing.plan
            ? planDetail(billing.plan, pricing, false)
            : 'Choose how you’d like to pay and add a card. Quotes wait for you until then.'}{' '}
          Your own tests are always free.
        </p>
        {billing.status === 'trialing' && billing.periodEnd && (
          <p className="mt-2 text-sm text-ink-2">
            Your free week ends {shortDate(billing.periodEnd)}.
          </p>
        )}
        {billing.nextPlan && billing.periodEnd && (
          <p className="mt-2 text-sm text-ink-2">
            Moving to {planName(billing.nextPlan, pricing)} on {shortDate(billing.periodEnd)}.
          </p>
        )}
        <p className="mt-3 text-sm text-muted">
          This month: {billing.usage.billableQuotes} paid{' '}
          {billing.usage.billableQuotes === 1 ? 'quote' : 'quotes'},{' '}
          {money(billing.usage.feesCents)} in fees
          {billing.plan === 'monthly' || billing.plan === 'yearly'
            ? `, ${billing.coveredThisMonth} of ${pricing.subscription.includedQuotes} included quotes used`
            : ''}
          .
        </p>
        {!billing.canSend && billing.reason && (
          <p className="mt-3 text-sm text-stop">{billing.reason}</p>
        )}
      </div>

      {picking ? (
        <div className="flex flex-col gap-4">
          <PlanCards
            billing={billing}
            current={billing.plan}
            busy={busy}
            onChoose={(plan) => void choose(plan)}
            action={() => (paying ? 'Switch to this plan' : 'Choose this plan')}
          />
          {billing.plan && (
            <Button variant="ghost" className="self-start" onClick={() => setPicking(false)}>
              Keep my plan
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPicking(true)}>
            Change plan
          </Button>
          {billing.checkoutAvailable && billing.plan && !paying && (
            <Button onClick={() => go(startCheckout)}>Add a card</Button>
          )}
          {billing.portalAvailable && (
            <Button variant="secondary" onClick={() => go(openBillingPortal)}>
              Manage card and invoices
            </Button>
          )}
        </div>
      )}

      {billing.deployed && (
        <Field
          label="Quote link"
          htmlFor="settings-link"
          hint="Paused, customers see that you aren’t taking requests right now."
        >
          <Segmented
            label="Quote link"
            value={billing.linkOn ? 'on' : 'off'}
            onChange={(value) =>
              setLinkOn(value === 'on')
                .then((saved) => {
                  onChange(saved);
                  notify(saved.linkOn ? 'Your quote link is on.' : 'Your quote link is paused.');
                })
                .catch((linkError) => notify(errorMessage(linkError)))
            }
            options={[
              { value: 'on', label: 'Taking requests' },
              { value: 'off', label: 'Paused' },
            ]}
          />
        </Field>
      )}

      <Field
        label="Monthly spending limit"
        htmlFor="settings-cap"
        hint="Once fees reach this, new quotes wait for you instead of going out."
      >
        <MoneyInput
          id="settings-cap"
          className="max-w-48"
          value={cap}
          onChange={setCap}
          onBlur={() => {
            const cents = parseMoney(cap);
            if (cents === null || cents === billing.spendingCapCents) return;
            saveSpendingCap(cents)
              .then(() => loadBilling())
              .then((loaded) => {
                onChange(loaded);
                notify(`Saved. Your limit is ${money(loaded.spendingCapCents)} a month.`);
              })
              .catch((saveError) => notify(errorMessage(saveError)));
          }}
        />
      </Field>
    </div>
  );
}

function DeleteSheet({
  open,
  business,
  onClose,
  onDeleted,
}: {
  open: boolean;
  business: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Delete your account"
      subtitle="This can't be undone."
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          deleteAccount(password, confirmation)
            .then(onDeleted)
            .catch((deleteError) => {
              setError(errorMessage(deleteError));
              setBusy(false);
            });
        }}
      >
        <Field label={`Type ${business} to confirm`} htmlFor="delete-confirm">
          <TextInput
            id="delete-confirm"
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
        <Field label="Your password" htmlFor="delete-password">
          <PasswordInput
            id="delete-password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <p className="text-sm text-stop" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || confirmation !== business || !password}>
            {busy ? 'Deleting…' : 'Delete everything'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
