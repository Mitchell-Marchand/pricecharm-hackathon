'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { privacyPolicy } from './legal-privacy';
import type { Operator } from './legal-shared';
import { termsOfService } from './legal-terms';
import { Logo } from './ui';

type Site = {
  operatorName: string;
  supportEmail: string;
  operatorAddress?: string;
  governingLaw?: string;
};

export default function LegalPage({ mode }: { mode: 'privacy' | 'terms' }) {
  const [operator, setOperator] = useState<Operator>();
  useEffect(() => {
    api<Site>('/site')
      .then((site) =>
        setOperator({
          name: site.operatorName,
          email: site.supportEmail,
          address: site.operatorAddress || '',
          governingLaw: site.governingLaw || '',
        }),
      )
      .catch(() => {});
  }, []);
  const privacy = mode === 'privacy';
  const legal = privacy ? privacyPolicy(operator) : termsOfService(operator);
  return (
    <main className="legal-page">
      <header>
        <Logo />
        <Link className="back-link" href="/">
          <ArrowLeft size={16} /> Back to Quotefolk
        </Link>
      </header>
      <article>
        <h1>{legal.title}</h1>
        <p className="legal-updated">Last updated {legal.updated}</p>
        <p className="legal-lead">{legal.intro}</p>
        <nav className="legal-contents" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            {legal.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
            <li>
              <a href="#contact">Contact us</a>
            </li>
          </ol>
        </nav>
        {legal.sections.map((section, index) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>
              {index + 1}. {section.title}
            </h2>
            {section.body}
          </section>
        ))}
        <footer id="contact">
          <h2>Contact us</h2>
          {operator ? (
            <p>
              {operator.name}
              {operator.address && (
                <>
                  <br />
                  {operator.address}
                </>
              )}
              <br />
              <a href={`mailto:${operator.email}`}>{operator.email}</a>
            </p>
          ) : (
            <p>Contact details are loading. If they don’t appear, reload the page.</p>
          )}
          <Link href={privacy ? '/terms' : '/privacy'}>
            {privacy ? 'Read the Terms of Service' : 'Read the Privacy Policy'}
          </Link>
        </footer>
      </article>
    </main>
  );
}
