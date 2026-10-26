'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { Logo } from './ui';

export default function LegalPage({ mode }: { mode: 'privacy' | 'terms' }) {
  const [site, setSite] = useState<{ operatorName: string; supportEmail: string }>();
  useEffect(() => {
    api<typeof site>('/site')
      .then(setSite)
      .catch(() => {});
  }, []);
  const privacy = mode === 'privacy';
  return (
    <main className="legal-page">
      <header>
        <Logo />
        <Link className="back-link" href="/">
          <ArrowLeft size={16} /> Back to Quotefolk
        </Link>
      </header>
      <article>
        <span className="eyebrow">CLEAR EXPECTATIONS</span>
        <h1>{privacy ? 'Privacy & your information.' : 'Terms of the quoting service.'}</h1>
        <p className="legal-lead">
          {privacy
            ? 'Quotefolk helps a business turn its own pricing knowledge into customer conversations. This explains the information that work involves.'
            : 'Quotefolk provides software for building, testing, and delivering quotes under a business’s approved pricing policies.'}
        </p>
        <p>
          Service operator: {site?.operatorName || 'Loading deployment operator details…'}
          {site?.supportEmail && (
            <>
              {' '}
              · <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
            </>
          )}
        </p>
        {privacy ? (
          <>
            <section>
              <h2>Information used by the service</h2>
              <p>
                A business workspace may contain the owner’s name and email, business profile,
                pricing rules, historical project examples, explanations, teaching conversations,
                independent tests, and approved policy versions. Customer requests may contain
                contact details, project descriptions, measurements, photographs, conversation
                history, quotes, and acceptance or decline decisions.
              </p>
              <p>
                The service also records account sessions, verification and recovery events,
                operational logs, quote delivery usage, payment-provider references, and platform
                billing records. Passwords and verification credentials are stored in protected
                forms rather than as readable account passwords.
              </p>
            </section>
            <section>
              <h2>How project information is used</h2>
              <p>
                Project information supports intake conversations, retrieval of the business’s
                examples, proposed pricing rules, evaluation, quote calculation, owner review, and
                follow-up. Teaching the assistant means building and applying a pricing playbook;
                the product does not promise that a separate model is fine-tuned for each business.
              </p>
              <p>
                The business controls its own pricing information and decides what to publish.
                Customer information is provided to that business for the requested project. Include
                only material you have permission to use, and avoid unnecessary sensitive
                information in examples, documents, or photos.
              </p>
            </section>
            <section>
              <h2>Service providers</h2>
              <p>
                Depending on deployment configuration, the service uses AWS for hosting, private
                file storage, and transactional email; OpenAI or Anthropic for AI processing; and
                Stripe for platform payment methods, checkout, and invoices. Relevant request
                content may be sent to the configured AI provider to perform the requested
                conversation or extraction. Card details are collected through Stripe rather than
                through a Quotefolk project chat.
              </p>
            </section>
            <section>
              <h2>Storage, access, and deletion</h2>
              <p>
                Session cookies keep owners signed in. A scoped customer token and optional browser
                storage let a customer return to their own request. Email links may provide
                temporary access to a quote session. Keep those links private.
              </p>
              <p>
                Workspace owners can export business data or schedule account deletion in settings.
                Deletion includes private-file cleanup and subscription cancellation jobs; it may
                take time to complete. Operational, security, and payment records may need separate
                retention or processing. Contact the operator for a request involving those records
                or a customer project.
              </p>
            </section>
            <section>
              <h2>Questions about a project</h2>
              <p>
                For a customer request, contact the business that received it. For access, export,
                deletion, or questions about this deployment, use the operator contact below.
              </p>
            </section>
          </>
        ) : (
          <>
            <section>
              <h2>Your business remains responsible for its prices</h2>
              <p>
                Provide accurate service descriptions, examples, required customer details,
                exclusions, and pricing rules. Review suggested changes before applying them.
                Independently test and explicitly approve a service policy before enabling automatic
                issuing, and monitor real outcomes after launch.
              </p>
              <p>
                You decide the scope of supported work, the maximum automatic quote, the assumptions
                communicated to customers, and when to pause the service. Passing a finite test set
                does not establish that every possible job will be priced correctly.
              </p>
            </section>
            <section>
              <h2>Quotes, handoff, and acceptance</h2>
              <p>
                The assistant follows the active business policy. Incomplete, uncertain,
                unsupported, or above-limit requests may go to the owner. A draft under review is
                not an issued price. Customers should read the scope and assumptions and provide
                accurate facts.
              </p>
              <p>
                Accepting or declining a quote records that response for the business. Quotefolk
                does not collect the customer’s project payment, perform the service, or
                automatically book a job. The business and customer arrange scheduling, final
                project requirements, payment, and any service-specific terms directly.
              </p>
            </section>
            <section>
              <h2>Platform fees</h2>
              <p>
                The current delivery tariff and free trial allowance appear on the{' '}
                <Link href="/pricing">pricing page</Link> and in billing settings. A qualified
                automatic delivery may incur a platform fee based on the issued quote value, even if
                the customer does not accept or book the work. Practice, teaching, retries, and
                revisions do not create additional delivery events.
              </p>
              <p>
                Billing access, remaining trial allowance, the payment-provider state, and your
                monthly spending cap can limit automatic issuing. Review the current tariff before
                activating paid delivery. Payment methods, invoices, and subscription management are
                available through the connected Stripe portal.
              </p>
            </section>
            <section>
              <h2>Use information you are entitled to provide</h2>
              <p>
                Upload project history and photos you have permission to use. Do not use another
                workspace’s private information, impersonate a business, submit malicious material,
                or attempt to bypass verification, billing, approval, or access controls.
              </p>
            </section>
            <section>
              <h2>Your account and ending use</h2>
              <p>
                Keep your login and customer access links private. Use the recovery process if
                access is lost. You may pause publication, export workspace data, manage billing, or
                request account deletion from settings. Contact the operator about a fee dispute or
                a problem that those controls cannot resolve.
              </p>
            </section>
          </>
        )}
        <footer>
          <h2>Contact the operator</h2>
          {site ? (
            <p>
              {site.operatorName}
              <br />
              <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a>
            </p>
          ) : (
            <p>
              Operator contact details are not currently available. Please check again before using
              this deployment for live requests.
            </p>
          )}
          <Link href={privacy ? '/terms' : '/privacy'}>
            {privacy ? 'Read the service terms' : 'Read the privacy notice'}
          </Link>
        </footer>
      </article>
    </main>
  );
}
