'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { privacyPolicy } from './legal-privacy';
import type { Operator } from './legal-shared';
import { termsOfService } from './legal-terms';
import { SiteFooter, SiteHeader } from './site/SiteHeader';

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
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="gutter mx-auto max-w-3xl pt-8 pb-20">
        <article className="legal-page">
          <h1 className="t-h1">{legal.title}</h1>
          <p className="mt-3 text-sm text-muted">Last updated {legal.updated}</p>
          <p className="mt-6 text-lg text-ink-2">{legal.intro}</p>
          <nav
            className="legal-contents mt-8 rounded-md border border-line bg-surface p-5"
            aria-label="Contents"
          >
            <h2 className="t-label text-muted">Contents</h2>
            <ol className="mt-3 list-decimal columns-1 gap-8 pl-5 text-[15px] sm:columns-2">
              {legal.sections.map((section) => (
                <li key={section.id} className="py-0.5 break-inside-avoid">
                  <a
                    href={`#${section.id}`}
                    className="text-accent underline decoration-accent/30 underline-offset-4"
                  >
                    {section.title}
                  </a>
                </li>
              ))}
              <li className="py-0.5">
                <a
                  href="#contact"
                  className="text-accent underline decoration-accent/30 underline-offset-4"
                >
                  Contact us
                </a>
              </li>
            </ol>
          </nav>
          {legal.sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-title`}
              className="prose-doc mt-10 scroll-mt-4 border-t border-line pt-8"
            >
              <h2 id={`${section.id}-title`} className="t-h2 text-ink">
                {index + 1}. {section.title}
              </h2>
              {section.body}
            </section>
          ))}
          <footer id="contact" className="mt-12 rounded-md bg-surface p-6 shadow-1">
            <h2 className="t-h3">Contact us</h2>
            {operator ? (
              <p className="mt-2 text-ink-2">
                {operator.name}
                {operator.address && (
                  <>
                    <br />
                    {operator.address}
                  </>
                )}
                <br />
                <a
                  href={`mailto:${operator.email}`}
                  className="text-accent underline underline-offset-4"
                >
                  {operator.email}
                </a>
              </p>
            ) : (
              <p className="mt-2 text-ink-2">
                Contact details are loading. If they don’t appear, reload the page.
              </p>
            )}
            <Link
              href={privacy ? '/terms' : '/privacy'}
              className="mt-4 inline-block text-sm text-accent underline underline-offset-4"
            >
              {privacy ? 'Read the Terms of Service' : 'Read the Privacy Policy'}
            </Link>
          </footer>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
