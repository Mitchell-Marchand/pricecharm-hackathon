'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, money } from '@/lib/api';
import type { Pricing } from '@/lib/types';
import { Button, ButtonLink, Logo, Notice } from './ui';

export default function PricingPage() {
  const [pricing, setPricing] = useState<Pricing>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setPricing(await api<Pricing>('/pricing'));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="simple-pricing">
      <header className="front-header">
        <Logo />
        <nav aria-label="Main navigation">
          <Link href="/">Home</Link>
          <Link href="/login">Sign in</Link>
        </nav>
      </header>
      <section className="price-content" aria-labelledby="price-title">
        <h1 id="price-title">Start free. Pay for automatic quotes.</h1>
        <p className="price-lead">
          Teaching, private tests, and quotes you approve yourself are free. A fee applies when your
          assistant delivers an automatic quote to a verified customer.
        </p>
        {error && (
          <div className="price-error">
            <Notice kind="error">Current pricing could not be loaded. {error}</Notice>
            <Button variant="secondary" loading={loading} onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {pricing ? (
          <>
            <div className="price-offer">
              <div className="price-number">
                <strong>{pricing.feeBasisPoints / 100}%</strong>
                <span>of each automatic quote</span>
              </div>
              <p className="price-range">
                {money(pricing.minimumFeeCents)} minimum · {money(pricing.maximumFeeCents)} maximum
                per delivery
              </p>
              <div className="price-trial">
                <strong>{pricing.trialQuotes} automatic quotes to try</strong>
                <p>
                  Use them within {pricing.trialDays} days of signing up. No card required to start.
                </p>
              </div>
              <ButtonLink href="/">
                Start free <span aria-hidden="true">→</span>
              </ButtonLink>
            </div>
            <dl className="price-facts">
              <div>
                <dt>Monthly fee</dt>
                <dd>
                  {pricing.monthlyCents
                    ? money(pricing.monthlyCents) + ' per month'
                    : 'No fixed monthly fee'}
                </dd>
              </div>
              <div>
                <dt>Spending control</dt>
                <dd>Set a monthly spending cap in your account.</dd>
              </div>
              <div>
                <dt>Your approval</dt>
                <dd>
                  Automatic quotes stay off until you approve the pricing and it passes separate
                  customer tests.
                </dd>
              </div>
            </dl>
            <p className="price-small">
              The delivery fee applies whether or not the customer books the job. Duplicate
              deliveries are not billed again.
            </p>
          </>
        ) : (
          !error && (
            <p className="quiet-loading" role="status">
              Loading current pricing…
            </p>
          )
        )}
      </section>
      <footer className="front-footer">
        <span>Quotefolk</span>
        <nav aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </main>
  );
}
