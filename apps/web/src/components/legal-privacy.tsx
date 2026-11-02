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
                such as security, billing and improving PriceCharm once nothing in it identifies
                you.
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
                <strong>Connected accounts:</strong> if you connect WhatsApp, Messenger or
                Instagram, the IDs Meta gives us for your business’s number, Facebook Page or
                Instagram account, and the access Meta grants us to send and receive messages for
                you.
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
              <li>Your name and a phone number or email address, so the business can reach you.</li>
              <li>The quote you receive and whether you accept or decline it.</li>
            </ul>
            <h3>Through WhatsApp, Messenger and Instagram</h3>
            <ul>
              <li>
                If you message a business that has connected one of these apps, Meta passes us your
                messages and photos, the name on your profile, and your phone number (on WhatsApp)
                or an ID Meta assigns you (on Messenger and Instagram).
              </li>
              <li>
                We use them only for that business: to answer you, draft your quote and teach that
                business’s own assistant. We never use them to improve PriceCharm for other
                businesses or in combined figures.
              </li>
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
                How you use our website and your account: the pages and screens you open and how
                long you spend on them, what you click, which fields you fill in and how long they
                take (not what you type in them), error messages you see, and requests that fail or
                run slowly. A random id for your browser tab ties one visit together.
              </li>
              <li>
                Screen recordings of our website and of business owners’ setup and accounts, made
                with PostHog. What you type is hidden, and so are customers’ names, messages and
                photos. We never record quote links or the quote button on a business’s website, and
                we don’t record at all if your browser sends a Do Not Track or Global Privacy
                Control signal.
              </li>
              <li>
                Visits to our public pages and the website that sent you there, counted on our own
                servers using a scrambled form of your IP address and browser type that changes
                every day.
              </li>
              <li>
                On our public pages and the setup pages, Meta’s pixel: the pages you open, and
                whether you made an account or added a card, so we can measure our ads on Facebook
                and Instagram. It never runs on quote links, the quote button on a business’s
                website or the owner’s account pages. We don’t use it in Europe or the UK, or if
                your browser sends a Do Not Track or Global Privacy Control signal. See{' '}
                <SectionLink id="sharing">Who we share it with</SectionLink>.
              </li>
              <li>
                If you’re in Europe or the UK, we ask before recording how you use the website or
                your account.
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
                them. No other business sees any of it.
              </li>
              <li>
                <strong>To improve PriceCharm for every business:</strong> we use job details,
                prices, quotes, conversations and how they turned out, from all businesses, to train
                and test the AI behind PriceCharm, for example so it reads requests and prices jobs
                more accurately. First we remove names, contact details, addresses and anything else
                that identifies a person or business. We never use conversations from WhatsApp,
                Messenger or Instagram this way.
              </li>
              <li>
                <strong>To make combined figures,</strong> like the typical price for a kind of job
                in a trade. They combine prices and job details from at least five businesses and
                can’t be traced back to any one business or customer. They never include names,
                addresses or contact details, or anything from WhatsApp, Messenger or Instagram. We
                use them to improve PriceCharm and may share them.
              </li>
              <li>
                <strong>To see how PriceCharm is used and fix what gets in the way,</strong> we
                record steps like finishing setup, sending a quote or a customer accepting one, and
                how people move through the website and the app. These records hold no names,
                contact details or messages. Unless a business picks its own, we also try different
                words on the button customers tap to accept a quote, and count which ones they say
                yes to.
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
            <p>
              We don’t sell personal information. The only advertising use is Meta’s pixel, above,
              for our own ads.
            </p>
          </>
        ),
      },
      {
        id: 'ai',
        title: 'How the AI uses your information',
        body: (
          <>
            <p>
              PriceCharm uses AI models from Meta, OpenAI and Anthropic. To reply to a customer,
              read a document or draft a quote, we send the model the parts of the conversation, the
              business’s pricing information and any photos or videos it needs, and use its answer.
              We also use Meta or OpenAI to create the photos that come with practice requests.
              Those photos are made up and don’t show anyone’s real property. When a business shows
              after pictures with its quotes, Meta’s Muse Image makes one from the customer’s photo,
              to show what the job could look like done.
            </p>
            <p>
              We use these providers’ business services. Under their terms, they don’t use what we
              send to train their models. OpenAI and Anthropic keep it only for a limited time,
              generally up to 30 days, to watch for abuse.
            </p>
            <p>
              When we train AI for all businesses, we use only information with names, contact
              details, addresses and anything else that identifies a person or business removed, as{' '}
              <SectionLink id="use">How we use it</SectionLink> describes.
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
                  'Meta, OpenAI and Anthropic',
                  'AI replies, reading documents and, at Meta and OpenAI, practice photos and after pictures',
                  'The conversation, pricing details, documents, photos and videos each task needs',
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
                  'PostHog',
                  'Screen recordings and usage analytics, in the United States',
                  'Pages, clicks and screen recordings, with typing and customers’ details hidden',
                ],
                [
                  'Sentry',
                  'Error reports',
                  'The error, the page and browser type. We remove request contents, email addresses and sign-in details before sending.',
                ],
              ]}
            />
            <p>
              <strong>Meta’s messaging apps.</strong> If a business connects WhatsApp, Messenger or
              Instagram, messages between the business and its customers go through Meta, which
              handles them under its own terms and privacy policy.
            </p>
            <p>
              <strong>Meta’s pixel.</strong> On our public pages and the setup pages, the pixel
              sends Meta the pages you open, whether you made an account or added a card, your IP
              address and browser, and Meta’s cookies. It doesn’t receive what you type. Meta uses
              this to measure our ads and choose who sees them, under its own terms and privacy
              policy, and may match it to a Facebook or Instagram account.
            </p>
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
              We don’t use analytics cookies. Meta’s pixel sets advertising cookies on our public
              pages and the setup pages, where it runs. Besides that and what PriceCharm needs to
              work, browser storage holds the id that ties one visit together and, in Europe and the
              UK, your answer about recordings.
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
                  'pricecharm_code (browser storage)',
                  'Keeps a code from a link you followed until you choose a plan',
                  'Until it’s used, or 30 days',
                ],
                [
                  'Browser storage',
                  'Lets you return to a quote request you started, and keeps unsent drafts',
                  'Until you clear it. Drafts last until you close the tab.',
                ],
                [
                  'pc_session (browser storage)',
                  'Ties together what you do in one visit, for our usage records and recordings',
                  'Until you close the tab',
                ],
                [
                  'pc_consent (browser storage)',
                  'Remembers whether you agreed to recordings, in Europe and the UK',
                  'Until you clear it',
                ],
                ['_fbp (Meta)', 'Lets Meta recognize this browser, to measure our ads', '90 days'],
                ['_fbc (Meta)', 'Records that you came from one of our ads', '90 days'],
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
                  'Connected WhatsApp, Messenger and Instagram accounts',
                  'Until the business disconnects them or closes its account',
                ],
                [
                  'Information used to improve PriceCharm, with everything that identifies a person or business removed',
                  'Kept, since it can’t be linked to anyone',
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
                ['Visit counts for our public pages', '13 months'],
                ['Records of what people did on the website and in the app', '13 months'],
                ['Screen recordings', '30 days'],
                [
                  'Records of steps taken in PriceCharm',
                  'Kept, but no longer linked to a business once it closes its account',
                ],
                ['Error reports', '90 days'],
                ['Backups', 'Up to 30 days, then overwritten'],
              ]}
            />
            <p>
              When a business closes its account, we delete its information, including its
              customers’ requests and photos. We keep only a record that the deletion happened (an
              ID and the dates), usage records that can no longer be linked to the business, and
              what PriceCharm already learned from information that identifies no one. Stripe keeps
              billing records under its own rules and the law.
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
              <li>Disconnect WhatsApp, Messenger or Instagram at any time.</li>
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
              We don’t sell personal information. Meta’s pixel on our public pages and the setup
              pages may count as sharing for cross-context behavioral advertising, as California law
              defines it. To opt out, turn on Global Privacy Control in your browser and we won’t
              load the pixel. We don’t use sensitive personal information for any purpose that would
              give you a right to limit it.
            </p>
            <p>
              If you’re in the UK or EU: we rely on our contract with you to run your account; on
              our legitimate interests to keep PriceCharm secure, prevent fraud and fix problems; on
              legal obligations for billing and tax; on our legitimate interests to improve
              PriceCharm with information that no longer identifies you; and on your consent where
              we ask for it. You can complain to your local data protection authority.
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
