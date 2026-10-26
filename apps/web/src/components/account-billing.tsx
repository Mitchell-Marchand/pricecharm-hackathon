'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Check, CreditCard, Download, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { api, cents, dollars, errorMessage, json, money, shortDate } from '@/lib/api';
import type { Billing, Business, User } from '@/lib/types';
import { Badge, Button, Field, Modal, Notice } from './ui';

export function BillingPanel({
  notify,
  emailVerified,
}: {
  notify: (message: string) => void;
  emailVerified?: boolean;
}) {
  const [billing, setBilling] = useState<Billing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setBilling(await api<Billing>('/billing'));
      setError('');
    } catch (error) {
      setError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function redirect(path: string) {
    setBusy(path);
    setError('');
    try {
      const { url } = await api<{ url: string }>(`/billing/${path}`, { method: 'POST' });
      window.location.assign(url);
    } catch (error) {
      setError(errorMessage(error));
      setBusy('');
    }
  }
  async function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('cap');
    setError('');
    try {
      setBilling(
        await api<Billing>('/billing', {
          method: 'PATCH',
          ...json({
            spendingCapCents: cents(String(new FormData(event.currentTarget).get('cap'))),
          }),
        }),
      );
      notify('Your monthly spending cap has been saved.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel commerce-panel">
      <div className="panel-heading">
        <div>
          <h3>Billing & delivery usage</h3>
          <p>Practice is free. Eligible automatic deliveries follow your current tariff.</p>
        </div>
        <CreditCard size={23} />
      </div>
      <div className="commerce-body">
        {error && (
          <Notice kind="error">
            {error}{' '}
            <button className="inline-button" onClick={() => void load()}>
              Retry
            </button>
          </Notice>
        )}
        {billing ? (
          <>
            <div className="billing-status">
              <Badge tone={billing.canIssue ? 'green' : 'amber'}>
                {billing.status.replaceAll('_', ' ')}
              </Badge>
              <span>
                {billing.provider === 'local'
                  ? 'Local payment provider · development only'
                  : 'Secure billing through Stripe'}
              </span>
            </div>
            {billing.reason && <Notice>{billing.reason}</Notice>}
            <div className="billing-metrics">
              <div>
                <span>Trial deliveries remaining</span>
                <strong>
                  {billing.trial.remainingQuotes}
                  <small> / {billing.trial.quoteLimit}</small>
                </strong>
                <p>Trial ends {shortDate(billing.trial.endsAt)}</p>
              </div>
              <div>
                <span>Delivered this month</span>
                <strong>{billing.usage.deliveredQuotes}</strong>
                <p>{billing.usage.billableQuotes} billable deliveries</p>
              </div>
              <div>
                <span>Accrued platform fees</span>
                <strong>{money(billing.usage.feesCents)}</strong>
                <p>{billing.usage.month}</p>
              </div>
            </div>
            <div className="formula-note">
              <span>CURRENT DELIVERY TARIFF</span>
              <p>
                {billing.tariff.basisPoints / 100}% of the issued quote value, with a{' '}
                {money(billing.tariff.minimumFeeCents)} minimum and{' '}
                {money(billing.tariff.maximumFeeCents)} maximum per eligible delivery. Test quotes,
                retries, and revisions are not additional deliveries.
              </p>
            </div>
            <form className="spending-cap-form" onSubmit={saveCap}>
              <Field
                label="Monthly platform spending cap ($)"
                name="cap"
                type="number"
                min="0"
                step="0.01"
                required
                key={billing.spendingCapCents}
                defaultValue={dollars(billing.spendingCapCents)}
                hint="When the server reaches this cap, additional issuing pauses until you raise the cap or the billing period changes."
              />
              <Button type="submit" variant="secondary" loading={busy === 'cap'}>
                Save cap <Check size={14} />
              </Button>
            </form>
            <div className="billing-actions">
              {emailVerified === false && (
                <Notice>
                  Verify your account email in{' '}
                  <a className="inline-button" href="/dashboard/settings">
                    Business & account
                  </a>{' '}
                  before activating paid delivery.
                </Notice>
              )}
              {billing.checkoutAvailable && (
                <Button
                  loading={busy === 'checkout'}
                  disabled={!!busy || emailVerified === false}
                  onClick={() => void redirect('checkout')}
                >
                  Activate paid delivery <ArrowUpRight size={15} />
                </Button>
              )}
              {billing.portalAvailable && (
                <Button
                  variant="secondary"
                  loading={busy === 'portal'}
                  disabled={!!busy}
                  onClick={() => void redirect('portal')}
                >
                  Payment methods & invoices <ArrowUpRight size={15} />
                </Button>
              )}
            </div>
            {!billing.configured && (
              <Notice>
                Payment processing is not configured on this deployment. Your available trial
                allowance is shown above; paid delivery cannot be activated until Stripe is
                configured.
              </Notice>
            )}
            {billing.subscription && (
              <p className="account-small">
                Subscription: {billing.subscription.status}
                {billing.subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
                {billing.subscription.periodEnd
                  ? ` · current period ends ${shortDate(billing.subscription.periodEnd)}`
                  : ''}
                .
              </p>
            )}
          </>
        ) : (
          !error && <p>Loading your billing status…</p>
        )}
      </div>
    </section>
  );
}

export function AccountPanel({
  user,
  business,
  refresh,
  notify,
}: {
  user: User;
  business: Business;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [devToken, setDevToken] = useState('');
  const [deleting, setDeleting] = useState(false);
  async function verify() {
    setBusy('verify');
    setError('');
    try {
      const result = await api<{ ok: boolean; delivery: string; devToken?: string }>(
        '/auth/request-verification',
        { method: 'POST' },
      );
      setDevToken(result.devToken || '');
      notify(
        result.delivery === 'local'
          ? 'Development verification link prepared below.'
          : 'Verification email queued. Check your inbox.',
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  async function exportData() {
    setBusy('export');
    setError('');
    try {
      const data = await api<unknown>('/account/export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${business.slug}-workspace-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify('Your workspace export has been downloaded.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel commerce-panel">
      <div className="panel-heading">
        <div>
          <h3>Account & security</h3>
          <p>Manage your email, password and account data.</p>
        </div>
        <ShieldCheck size={23} />
      </div>
      <div className="commerce-body">
        {error && <Notice kind="error">{error}</Notice>}
        <div className="identity-status">
          <div>
            <strong>{user.email}</strong>
            <p>
              {user.emailVerified
                ? 'Email verified. Your account can approve automatic quoting policies.'
                : 'Verify this email before approving automatic quoting policies.'}
            </p>
          </div>
          <Badge tone={user.emailVerified ? 'green' : 'amber'}>
            {user.emailVerified ? 'Verified' : 'Verification needed'}
          </Badge>
        </div>
        {!user.emailVerified && (
          <Button variant="secondary" onClick={() => void verify()} loading={busy === 'verify'}>
            <Mail size={15} /> Send verification email
          </Button>
        )}
        {devToken && (
          <Notice>
            <strong>Local development email</strong>
            <br />
            No email was sent.{' '}
            <a
              className="inline-button"
              href={`/verify-email#token=${encodeURIComponent(devToken)}`}
            >
              Open local verification link
            </a>
          </Notice>
        )}
        <div className="account-actions">
          <a className="button button-secondary" href="/forgot-password">
            Change or recover password <ArrowUpRight size={15} />
          </a>
          <Button variant="secondary" onClick={() => void exportData()} loading={busy === 'export'}>
            <Download size={15} /> Export workspace data
          </Button>
        </div>
        <div className="danger-zone">
          <div>
            <strong>Delete this workspace</strong>
            <p>
              Schedule deletion of your business data, private files, account sessions, and any
              subscription.
            </p>
          </div>
          <Button variant="ghost" onClick={() => setDeleting(true)}>
            <Trash2 size={15} /> Delete workspace
          </Button>
        </div>
      </div>
      {deleting && (
        <DeleteAccount
          business={business}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            router.replace('/login');
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function DeleteAccount({
  business,
  onClose,
  onDeleted,
}: {
  business: Business;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/account', {
        method: 'DELETE',
        ...json({ password: form.get('password'), confirmation: form.get('confirmation') }),
      });
      onDeleted();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Modal
      title="Delete your workspace?"
      subtitle="This action schedules permanent deletion. Export anything you want to keep before continuing."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Notice kind="error">
          Your business data, private uploads, sessions, and subscription will be removed. This
          cannot be undone after deletion completes.
        </Notice>
        <Field
          label={`Type “${business.name}” to confirm`}
          name="confirmation"
          required
          autoComplete="off"
        />
        <Field
          label="Your current password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Keep workspace
          </Button>
          <Button variant="danger" type="submit" loading={loading}>
            Delete workspace
          </Button>
        </div>
      </form>
    </Modal>
  );
}
