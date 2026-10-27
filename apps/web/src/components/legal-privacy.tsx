import {
  DocumentLink,
  LEGAL_UPDATED,
  LegalTable,
  Mail,
  SectionLink,
  operatorName,
  type LegalDocument,
  type Operator,
} from './legal-shared';

export function privacyPolicy(operator?: Operator): LegalDocument {
  const mail = <Mail operator={operator} />;
  return {
    title: 'Privacy Policy',
    updated: LEGAL_UPDATED,
    intro: (
      <>
        PriceCharm is software that learns how a business prices its work, then talks with that
        business’s customers and drafts quotes. This policy explains what information we collect,
        how we use it, who we share it with and the choices you have. It covers business owners who
        use PriceCharm and people who ask a business for a quote through it.
      </>
    ),
    sections: [
      {
        id: 'who-we-are',
        title: 'Who we are',
        body: (
          <>
            <p>
              PriceCharm is operated by {operatorName(operator)} (“we” or “us”). You can reach us at{' '}
              {mail}
              {operator?.address ? <>, or by mail at {operator.address}</> : null}.
            </p>
            <p>We handle information in two different roles:</p>
            <ul>
              <li>
                <strong>For business owners,</strong> we decide how your account information is
                used, and this policy describes how.
              </li>
              <li>
                <strong>For people requesting a quote,</strong> we handle your information for the
                business you contacted. That business decides what happens with your request, and
                its own privacy policy covers what it does with it. We use your information only to
                run PriceCharm for that business and for the few purposes of our own listed below,
                such as security and billing.
              </li>
            </ul>
          </>
        ),
      },
      {
        id: 'information',
        title: 'Information we collect',
        body: (
          <>
            <h3>From business owners</h3>
            <ul>
              <li>
                <strong>Account details:</strong> your name, email address and password. We store
                the password only as a salted hash, never as you typed it.
              </li>
              <li>
                <strong>Your business:</strong> its name, services, service area, prices, pricing
                rules and what your work includes or leaves out.
              </li>
              <li>
                <strong>What you teach the assistant:</strong> past jobs, notes, documents you
                upload (such as old quotes and invoices), photos, and your practice conversations
                and quotes.
              </li>
              <li>
                <strong>Billing:</strong> your usage, fees and spending cap. Stripe collects your
                card details, and we never see your full card number.
              </li>
              <li>
                <strong>Your activity with customers:</strong> messages you send, prices you set and
                your decisions on requests.
              </li>
            </ul>
            <h3>From people requesting a quote</h3>
            <ul>
              <li>
                What you tell the assistant about your project, the photos you send and the
                conversation.
              </li>
              <li>
                Your name and email address, and the code we email you to confirm the address.
              </li>
              <li>The quote you receive and whether you accept or decline it.</li>
            </ul>
            <h3>From people trying the demo</h3>
            <ul>
              <li>
                What you type in the demo on our website goes to our AI provider so it can reply. We
                don’t save it, and it isn’t linked to you.
              </li>
              <li>
                To stop abuse, we count how much each visitor uses the demo each day, using a
                scrambled form of your IP address that changes every day, never the address itself.
              </li>
            </ul>
            <h3>Collected automatically</h3>
            <ul>
              <li>
                Technical details from your browser: IP address, browser and device type, the pages
                you request and when.
              </li>
              <li>
                Cookies and browser storage that keep you signed in or let you come back to a
                request. See <SectionLink id="cookies">Cookies and browser storage</SectionLink>.
              </li>
              <li>
                Signals that Cloudflare reads from your browser to tell people from automated
                scripts, when you start setting up, sign up, try the demo or start a request.
              </li>
              <li>
                Error reports when something breaks: what went wrong, the page and your browser
                type.
              </li>
            </ul>
            <p>
              Please don’t put sensitive information, such as health details, financial account
              numbers or government ID numbers, in project descriptions, documents or photos.
              PriceCharm doesn’t need it.
            </p>
          </>
        ),
      },
      {
        id: 'use',
        title: 'How we use it',
        body: (
          <>
            <ul>
              <li>
                <strong>To run PriceCharm:</strong> answer customers, ask the questions a business
                needs answered, calculate and draft quotes, deliver them and keep each conversation
                together.
              </li>
              <li>
                <strong>To teach each business’s assistant</strong> from that business’s own jobs,
                notes, practice quotes and real quotes, including whether its customers accepted
                them. No other business’s assistant sees any of it.
              </li>
              <li>
                <strong>To make combined figures,</strong> like the typical price for a kind of job
                in a trade. They combine prices and job details from at least five businesses and
                can’t be traced back to any one business or customer. They never include names,
                addresses or contact details. We use them to improve PriceCharm and may share them.
              </li>
              <li>
                <strong>To send the emails the service needs:</strong> verification codes, sign-in
                and password-reset links, quotes, one reminder about a quote you haven’t answered,
                replies, and notices about requests and billing.
              </li>
              <li>
                <strong>To bill businesses</strong> for delivered quotes through Stripe.
              </li>
              <li>
                <strong>To keep PriceCharm safe:</strong> stop bots and fake requests, limit how
                much any one visitor can use, protect accounts and investigate misuse.
              </li>
              <li>
                <strong>To support you and fix problems,</strong> including reading a conversation
                when a business asks us for help with it.
              </li>
              <li>
                <strong>To meet legal obligations</strong> and enforce our{' '}
                <DocumentLink to="terms">Terms of Service</DocumentLink>.
              </li>
            </ul>
            <p>We don’t sell personal information, and we don’t use it for advertising.</p>
          </>
        ),
      },
      {
        id: 'ai',
        title: 'How the AI uses your information',
        body: (
          <>
            <p>
              PriceCharm uses AI models from OpenAI and Anthropic. To reply to a customer, read a
              document or draft a quote, we send the model the parts of the conversation, the
              business’s pricing information and any photos it needs, and use its answer. We also
              use OpenAI to create the photos that come with practice requests. Those photos are
              made up and don’t show anyone’s real property.
            </p>
            <p>
              We use these providers’ business services. Under their terms, they don’t use what we
              send to train their models, and they keep it only for a limited time, generally up to
              30 days, to watch for abuse.
            </p>
            <p>
              A business can let its assistant send quotes automatically, without the owner
              reviewing each one first. The business sets the rules and limits, and anything unusual
              goes to the owner. If you received a quote and want a person at the business to look
              at it, reply in your conversation or contact the business.
            </p>
          </>
        ),
      },
      {
        id: 'sharing',
        title: 'Who we share it with',
        body: (
          <>
            <p>
              <strong>The business you contacted.</strong> If you request a quote, your project
              details, photos, conversation, contact details and your answer to the quote go to that
              business.
            </p>
            <p>
              <strong>Service providers.</strong> These companies run parts of PriceCharm for us.
              They can use the information only to do that work for us.
            </p>
            <LegalTable
              head={['Provider', 'What it does', 'What it receives']}
              rows={[
                [
                  'Amazon Web Services',
                  'Servers, database, file storage and email delivery, in the United States',
                  'Everything stored in PriceCharm, and the emails we send',
                ],
                [
                  'OpenAI and Anthropic',
                  'AI replies, reading documents and, at OpenAI, practice photos',
                  'The conversation, pricing details, documents and photos each task needs',
                ],
                [
                  'Stripe',
                  'Billing businesses for PriceCharm',
                  'The business name, owner’s email, payment details and fees',
                ],
                [
                  'Cloudflare',
                  'Checking for bots on setup, signup, the demo and new requests',
                  'IP address and browser signals',
                ],
                [
                  'Sentry',
                  'Error reports',
                  'The error, the page and browser type. We remove request contents, email addresses and sign-in details before sending.',
                ],
              ]}
            />
            <p>
              <strong>Combined figures.</strong> We may share the combined figures described in{' '}
              <SectionLink id="use">How we use it</SectionLink>. They don’t identify any business or
              person.
            </p>
            <p>
              <strong>For legal reasons.</strong> When the law requires it, or when it’s needed to
              protect the rights, property or safety of the people who use PriceCharm, the public or
              us.
            </p>
            <p>
              <strong>If our business changes hands.</strong> As part of a merger, acquisition or
              sale of assets. The new owner would have to protect your information as this policy
              does, and we’d tell you before a different policy applied.
            </p>
            <p>
              <strong>With your permission,</strong> in any other case.
            </p>
          </>
        ),
      },
      {
        id: 'cookies',
        title: 'Cookies and browser storage',
        body: (
          <>
            <p>
              We only use the cookies and browser storage PriceCharm needs to work. We don’t use
              advertising or analytics cookies.
            </p>
            <LegalTable
              head={['Name', 'What it’s for', 'How long it lasts']}
              rows={[
                [
                  'quotient_draft',
                  'Keeps your setup together before you have an account',
                  '14 days, or until you create your account',
                ],
                [
                  'quotient_session',
                  'Keeps a business owner signed in',
                  '30 days, or until you sign out',
                ],
                [
                  'quotient_known_device',
                  'Remembers that this browser has signed in to your account before, so it isn’t locked out if someone else guesses at your password',
                  '180 days',
                ],
                [
                  'Browser storage',
                  'Lets you return to a quote request you started, and keeps unsent drafts',
                  'Until you clear it. Drafts last until you close the tab.',
                ],
              ]}
            />
            <p>
              Cloudflare’s bot check runs in your browser when you start setting up, sign up, try
              the demo or start a request, and Cloudflare handles the signals it reads under its own
              privacy policy.
            </p>
          </>
        ),
      },
      {
        id: 'retention',
        title: 'How long we keep it',
        body: (
          <>
            <LegalTable
              head={['Information', 'How long']}
              rows={[
                [
                  'Your account, business details, prices and what you’ve taught the assistant',
                  'Until you delete it or close your account',
                ],
                [
                  'Quote requests, including messages, photos, contact details and quotes',
                  'As long as the business that received them has an account, unless deleted sooner on request',
                ],
                [
                  'Setups that never become an account, including their photos',
                  '14 days after you start',
                ],
                ['What you type in the demo', 'Not saved'],
                [
                  'Verification codes, and sign-in, verification and password-reset links',
                  'Deleted 7 days after they expire',
                ],
                ['Copies of emails we’ve sent', '30 days'],
                ['Server logs, which include IP addresses', '30 days'],
                ['Error reports', '90 days'],
                ['Backups', 'Up to 30 days, then overwritten'],
              ]}
            />
            <p>
              When a business closes its account, we delete its information, including its
              customers’ requests and photos. We keep only a record that the deletion happened: an
              ID and the dates. Stripe keeps billing records under its own rules and the law.
            </p>
          </>
        ),
      },
      {
        id: 'security',
        title: 'How we protect it',
        body: (
          <>
            <p>
              Every connection to PriceCharm uses HTTPS. The database, stored files and backups are
              encrypted. Passwords are salted and hashed, and sign-in sessions and emailed links are
              stored only as hashes. Emails waiting to be sent are encrypted. Uploaded photos are
              re-saved on upload, which strips location data and other hidden details. Only the
              people who run PriceCharm can reach its servers, and only when their work needs it.
            </p>
            <p>
              No system is perfectly secure. If a breach affects your personal information, we’ll
              tell you, and the authorities, as the law requires.
            </p>
          </>
        ),
      },
      {
        id: 'rights',
        title: 'Your choices and rights',
        body: (
          <>
            <h3>If you own a business account</h3>
            <ul>
              <li>Download your business’s data any time from Settings.</li>
              <li>Correct your details in PriceCharm, or ask us to.</li>
              <li>
                Close your account from Settings. We then delete your information as described
                above.
              </li>
              <li>
                The emails PriceCharm sends are part of the service, so they continue while you have
                an account. If we ever send product news, every one will have an unsubscribe link.
              </li>
            </ul>
            <h3>If you requested a quote</h3>
            <p>
              Start with the business you contacted, since it decides what happens with your
              request. You can also email us at {mail}. We’ll pass your request on to the business
              or, where the law allows, handle it ourselves.
            </p>
            <h3>Rights under privacy laws</h3>
            <p>
              Depending on where you live, including California and other US states, the UK and the
              EU, you may have the right to know what personal information we hold about you, get a
              copy of it, correct it, delete it, and object to or limit some uses of it. To use
              these rights, email {mail}. We’ll confirm it’s you before acting, usually by email,
              and reply within the time the law sets, generally 30 to 45 days.
            </p>
            <p>
              Someone you authorize can make a request for you; we’ll ask for proof that they can
              act on your behalf. If we turn down a request, you can ask us to reconsider by
              replying to our answer. We won’t treat you differently for using any of these rights.
            </p>
            <p>
              We don’t sell personal information or share it for cross-context behavioral
              advertising, as California law defines those terms. We don’t use sensitive personal
              information for any purpose that would give you a right to limit it.
            </p>
            <p>
              If you’re in the UK or EU: we rely on our contract with you to run your account; on
              our legitimate interests to keep PriceCharm secure, prevent fraud and fix problems; on
              legal obligations for billing and tax; and on your consent where we ask for it. You
              can complain to your local data protection authority.
            </p>
          </>
        ),
      },
      {
        id: 'children',
        title: 'Children',
        body: (
          <p>
            PriceCharm isn’t meant for children, and you must be 18 or older to use it. If you think
            a child has given us personal information, contact us at {mail} and we’ll delete it.
          </p>
        ),
      },
      {
        id: 'transfers',
        title: 'Where your information is kept',
        body: (
          <p>
            PriceCharm runs in the United States. If you use it from another country, your
            information goes to the United States and is handled there, under laws that may differ
            from yours. Our service providers offer contractual safeguards for these transfers, such
            as the European Commission’s standard contractual clauses.
          </p>
        ),
      },
      {
        id: 'changes',
        title: 'Changes to this policy',
        body: (
          <p>
            When we change this policy, we’ll post the new version here and update the date at the
            top. If a change is significant, we’ll tell business owners by email before it takes
            effect.
          </p>
        ),
      },
    ],
  };
}
