import Link from 'next/link';
import {
  DocumentLink,
  LEGAL_UPDATED,
  Mail,
  SectionLink,
  operatorName,
  type LegalDocument,
  type Operator,
} from './legal-shared';

export function termsOfService(operator?: Operator): LegalDocument {
  const mail = <Mail operator={operator} />;
  const state = operator?.governingLaw;
  return {
    title: 'Terms of Service',
    updated: LEGAL_UPDATED,
    intro: (
      <>
        These terms are the agreement between you and {operatorName(operator)} (“we” or “us”) for
        using PriceCharm. By creating an account or using PriceCharm, you agree to them. If you use
        PriceCharm for a business, you agree on the business’s behalf and confirm that you’re
        allowed to. If you’re asking a business for a quote, the section{' '}
        <SectionLink id="requesting">If you’re requesting a quote</SectionLink> is written for you.
      </>
    ),
    sections: [
      {
        id: 'using',
        title: 'Using PriceCharm',
        body: (
          <ul>
            <li>
              PriceCharm is for businesses. To open an account, you must be at least 18 and use it
              for your business.
            </li>
            <li>Give us accurate information when you sign up, and keep it current.</li>
            <li>
              Keep your sign-in details private. You’re responsible for what happens under your
              account. If you think someone else has used it, tell us at {mail} right away.
            </li>
          </ul>
        ),
      },
      {
        id: 'service',
        title: 'What PriceCharm does',
        body: (
          <>
            <p>
              PriceCharm learns how you price from the jobs, notes and practice quotes you give it.
              It then talks with your customers on your quote link, on your website and, if you
              connect them, on WhatsApp, Messenger and Instagram. It asks the questions you need
              answered and drafts quotes. You decide whether each quote waits for your review or
              goes out automatically, within the rules and limits you set.
            </p>
            <p>
              We keep improving PriceCharm, so features will change. If we remove something you rely
              on, we’ll tell you first. Features we label as beta may be less reliable and may
              change or go away.
            </p>
          </>
        ),
      },
      {
        id: 'quotes',
        title: 'Your prices and your quotes',
        body: (
          <ul>
            <li>
              You’re responsible for your prices and for every quote sent in your business’s name,
              whether you approved it or the assistant sent it automatically.
            </li>
            <li>
              The assistant can get things wrong. It can misunderstand a customer, miss a detail or
              price a job differently than you would. Check its practice quotes and your settings,
              keep your automatic limits sensible, and review the quotes it sends.
            </li>
            <li>
              A quote is an offer from your business to your customer. We aren’t a party to it, we
              don’t do or guarantee the work, and we don’t collect payment for it. Scheduling, final
              scope, payment and any other terms are between you and your customer.
            </li>
            <li>
              You’re responsible for following the laws that apply to your business and your quotes,
              including licensing, consumer protection, pricing and tax rules. If your trade or
              location requires particular wording in quotes, add it to your service details.
            </li>
            <li>
              Don’t let the assistant quote automatically for work where a wrong price or a missed
              detail could put someone at risk or break the law.
            </li>
          </ul>
        ),
      },
      {
        id: 'customers',
        title: 'Your customers',
        body: (
          <ul>
            <li>
              Handle your customers’ information lawfully. Where the law requires it, tell them how
              you use it, for example in your own privacy policy, and respond to their requests
              about it.
            </li>
            <li>
              Use PriceCharm to answer people who asked you for a quote, not to send marketing they
              didn’t ask for.
            </li>
            <li>
              If one of your customers asks us about their request, we may refer them to you, and
              you’ll help them.
            </li>
          </ul>
        ),
      },
      {
        id: 'meta-apps',
        title: 'WhatsApp, Messenger and Instagram',
        body: (
          <ul>
            <li>
              You can connect your business’s WhatsApp number, Facebook Page or Instagram account so
              the assistant can answer customers there. These apps belong to Meta, and Meta’s terms
              and policies apply when you use them, including the WhatsApp Business Messaging
              Policy.
            </li>
            <li>
              Only connect accounts you’re allowed to manage. Don’t use them to message people first
              unless they’ve agreed to hear from you and Meta’s rules allow it.
            </li>
            <li>
              Meta can limit or switch off these connections at any time. If it does, your quote
              link and website keep working. You can disconnect them at any time too.
            </li>
            <li>
              Conversations from these apps are used only for your business, as{' '}
              <SectionLink id="content">Your content</SectionLink> explains.
            </li>
          </ul>
        ),
      },
      {
        id: 'fees',
        title: 'Fees and payment',
        body: (
          <ul>
            <li>
              Before your quote link takes requests, you choose a plan: a fee for each quote shown
              to a customer, a fee for each quote a customer accepts, or a monthly or yearly
              subscription. The current prices and details are on our{' '}
              <Link href="/pricing">pricing page</Link> and in your billing settings. The prices in
              place when you choose a plan apply until we change them as described below. Setting
              up, practice and your own tests are free on every plan.
            </li>
            <li>
              A quote counts when it’s shown to a customer, whether the assistant sent it
              automatically or you approved it first. Each quote counts once.
            </li>
            <li>
              On the per-quote plan, the fee applies to each quote that counts, whether or not the
              customer answers it. On the accepted-quote plan, the fee applies only when the
              customer accepts the quote through PriceCharm, as a percentage of the quote within the
              stated minimum and maximum.
            </li>
            <li>
              We don’t charge for practice, the demo, your own test requests or sending the same
              quote again.
            </li>
            <li>
              For 30 days from when you first add a payment method, your quote fees stop at the
              first-month maximum shown on our pricing page. Quotes past it still go out, and you
              don’t pay for them.
            </li>
            <li>
              A subscription includes a set number of quotes that count each calendar month, with a
              fee for each one past that. A new subscription may start with a free trial; you give a
              payment method to start it, and unless you cancel before the trial ends, the
              subscription begins and you’re charged then. Subscriptions renew automatically at the
              end of each monthly or yearly period until you cancel. You can cancel or switch plans
              at any time in your billing settings. A switch takes effect right away, and what’s
              left of a period you’ve paid for is credited to your next bills. If you cancel, we
              don’t refund the rest of a period.
            </li>
            <li>
              You can set a monthly spending cap in billing settings. Once you reach it, no more
              quotes go out until the next month or until you raise the cap. New requests wait for
              you in the meantime. Customers can still accept quotes they already have, and we don’t
              charge for those acceptances.
            </li>
            <li>
              Sending quotes to customers needs a payment method on file. Until you add one, quotes
              wait for you instead of going out. Stripe bills subscriptions at the start of each
              period and fees monthly, and you authorize us to charge your payment method for them.
              Stripe’s terms also apply to payments.
            </li>
            <li>
              Fees don’t include taxes. You’re responsible for any sales, use or similar taxes on
              them, except taxes on our income.
            </li>
            <li>If a payment fails, we may pause sending quotes until it’s fixed.</li>
            <li>
              Fees aren’t refundable, except where the law requires or as this section says. If you
              think a fee is wrong, or that you were charged for a quote that went to a fake or
              abusive request, tell us at {mail} within 60 days of the invoice. We’ll look into it
              and credit any fee that shouldn’t have been charged.
            </li>
            <li>
              We may change fees by emailing you at least 30 days before the change. New fees apply
              from your first billing period after that. If you don’t agree, you can close your
              account before the change.
            </li>
          </ul>
        ),
      },
      {
        id: 'content',
        title: 'Your content',
        body: (
          <ul>
            <li>
              “Your content” means everything you and your customers put into PriceCharm: business
              details, prices, past jobs, documents, photos, conversations and quotes. You own it.
            </li>
            <li>
              You let us host, copy, process, display and send your content, including to the
              service providers in our <DocumentLink to="privacy">Privacy Policy</DocumentLink>, as
              needed to run PriceCharm for you, keep it secure and meet the law, and to improve
              PriceCharm and make the combined figures described below. This permission ends when
              your content is deleted, apart from copies in backups until they’re overwritten and
              what PriceCharm has already learned from it.
            </li>
            <li>
              We don’t sell your content. No other business ever sees your prices, quotes, jobs,
              customers or name, and your assistant never shows them to anyone else.
            </li>
            <li>
              We use content from all businesses to improve PriceCharm for everyone. For example, we
              teach the AI behind PriceCharm to read requests, price jobs and catch mistakes, and we
              test changes on it before they go out. Before we use your content this way, we remove
              names, contact details, addresses and anything else that identifies you, your business
              or your customers.
            </li>
            <li>
              We may combine prices and job details, like sizes and what was included, from many
              businesses into figures that can’t be traced back to any one business or customer,
              such as the typical price per square foot for washing a driveway. We use these figures
              to improve PriceCharm, for example to give a business a starting price for a service
              it hasn’t priced yet, and we may share them with others. A figure always combines at
              least five businesses and never includes names, addresses or contact details.
            </li>
            <li>
              Conversations that come in through WhatsApp, Messenger or Instagram, and anything
              taken from them, like job details, quotes and whether the customer said yes, are used
              only for your own assistant. We never use them to improve PriceCharm for other
              businesses or count them in combined figures.
            </li>
            <li>
              Once your content is deleted, we stop using it to improve PriceCharm and it stops
              counting toward new figures. What PriceCharm already learned from it, and figures
              already made, stay, but they can’t be traced back to you.
            </li>
            <li>
              Make sure you have the right to everything you upload, including photos and documents,
              and any permission you need from your customers.
            </li>
            <li>If you send us feedback or ideas, we may use them without owing you anything.</li>
          </ul>
        ),
      },
      {
        id: 'ours',
        title: 'Our software',
        body: (
          <p>
            PriceCharm, including its software, design and the assistant’s instructions, belongs to
            us and our licensors. While you have an account and follow these terms, you may use
            PriceCharm for your business. This right is limited, non-exclusive and can’t be
            transferred. The quotes and other results PriceCharm produces for you are your content,
            and you can use them as you like.
          </p>
        ),
      },
      {
        id: 'acceptable-use',
        title: 'Acceptable use',
        body: (
          <>
            <p>Don’t do any of the following, or help anyone else do it:</p>
            <ul>
              <li>Break the law, or use PriceCharm for fraud, deception or harassment.</li>
              <li>
                Pretend to be another person or business, or quote for a business you don’t
                represent.
              </li>
              <li>
                Upload anything you don’t have the right to use, or anything illegal, hateful,
                sexually explicit or harmful.
              </li>
              <li>Send spam, or contact people who didn’t ask you for a quote.</li>
              <li>
                Try to get into another account, or probe, scan or attack PriceCharm. If you find a
                security problem, please report it to {mail}.
              </li>
              <li>
                Get around PriceCharm’s limits, bot checks, email verification, billing or spending
                cap, or create fake requests.
              </li>
              <li>
                Overload PriceCharm, or access it with bots or scrapers. Putting the quote widget on
                your own website, as intended, is fine.
              </li>
              <li>
                Copy, reverse engineer or resell PriceCharm, or use it to build a competing product.
              </li>
              <li>
                Try to make the assistant reveal its instructions or other businesses’ information,
                or use it for anything other than quoting.
              </li>
            </ul>
            <p>We may remove content or turn off features for anyone who breaks these rules.</p>
          </>
        ),
      },
      {
        id: 'data-protection',
        title: 'Data protection',
        body: (
          <>
            <p>
              Our <DocumentLink to="privacy">Privacy Policy</DocumentLink> explains how we handle
              personal information. For your customers’ information, we act as your service
              provider, or processor, and we:
            </p>
            <ul>
              <li>
                use it only to run PriceCharm for you, following the instructions you give through
                your settings and how you use PriceCharm, or as the law requires, apart from
                improving PriceCharm and making combined figures once anything that identifies a
                customer is removed, as <SectionLink id="content">Your content</SectionLink>{' '}
                describes;
              </li>
              <li>make sure everyone who works on PriceCharm keeps it confidential;</li>
              <li>protect it with the measures described in our Privacy Policy;</li>
              <li>
                use only the service providers listed in our Privacy Policy, under contracts that
                protect it, and update that list before adding a new one;
              </li>
              <li>help you answer your customers’ requests about their information;</li>
              <li>tell you without undue delay if we learn of a breach that affects it;</li>
              <li>delete it when you close your account, as our Privacy Policy describes.</li>
            </ul>
            <p>If you need a signed data processing agreement, email {mail}.</p>
          </>
        ),
      },
      {
        id: 'termination',
        title: 'Suspension and closing an account',
        body: (
          <ul>
            <li>
              You can close your account at any time from Settings. Download anything you want to
              keep first, because closing an account can’t be undone.
            </li>
            <li>
              We may suspend or close your account, or pause automatic quotes, if you break these
              terms, don’t pay, put others at risk, or if the law requires it. When we reasonably
              can, we’ll tell you first and give you a chance to fix the problem.
            </li>
            <li>
              If we stop offering PriceCharm, we’ll give you at least 30 days’ notice and a chance
              to download your data.
            </li>
            <li>
              Closing an account doesn’t cancel fees for quotes already delivered. The sections on
              fees, your content, disclaimers, liability, indemnity, disputes and the general terms
              continue to apply afterward.
            </li>
          </ul>
        ),
      },
      {
        id: 'disclaimers',
        title: 'Disclaimers',
        body: (
          <p className="legal-emphasis">
            PriceCharm is provided “as is” and “as available.” To the fullest extent the law allows,
            we disclaim all warranties, express or implied, including warranties of merchantability,
            fitness for a particular purpose, title and non-infringement. We don’t promise that
            PriceCharm will be uninterrupted or error-free, that the assistant’s replies, prices or
            quotes will be accurate or complete, or that any customer will accept a quote.
          </p>
        ),
      },
      {
        id: 'liability',
        title: 'Limitation of liability',
        body: (
          <>
            <p className="legal-emphasis">To the fullest extent the law allows:</p>
            <ul className="legal-emphasis">
              <li>
                Neither you nor we will be liable for lost profits, revenue, business or data, or
                for indirect, incidental, special, consequential or punitive damages, even if told
                they were possible.
              </li>
              <li>
                Our total liability for all claims relating to PriceCharm or these terms is limited
                to the greater of the fees you paid us in the 12 months before the claim arose, or
                $100.
              </li>
            </ul>
            <p>
              These limits don’t apply to fees you owe, to your obligations under{' '}
              <SectionLink id="indemnity">Indemnity</SectionLink>, or to liability that the law
              doesn’t allow to be limited.
            </p>
          </>
        ),
      },
      {
        id: 'indemnity',
        title: 'Indemnity',
        body: (
          <p>
            You’ll defend and indemnify us, and our officers, employees and agents, against claims,
            losses and costs, including reasonable legal fees, arising from your content, your
            quotes, your work, your dealings with your customers, or your breaking these terms or
            the law. We’ll tell you promptly about any such claim, let you control the defense, and
            cooperate at your expense. You won’t settle a claim in a way that admits fault on our
            part without our consent.
          </p>
        ),
      },
      {
        id: 'requesting',
        title: 'If you’re requesting a quote',
        body: (
          <>
            <p>If you use PriceCharm to ask a business for a quote:</p>
            <ul>
              <li>
                You’re dealing with that business. It sets the prices, sends the quote and does the
                work. We aren’t part of any agreement between you and the business, and we aren’t
                responsible for its work, prices or conduct.
              </li>
              <li>
                A quote is based on what you share. Give accurate details and photos, and read
                what’s included and excluded before you accept. The final price can change if the
                job turns out to be different.
              </li>
              <li>
                Accepting a quote tells the business you want to go ahead. Payment, scheduling and
                any further terms are between you and the business.
              </li>
              <li>
                Your conversation, photos and contact details go to the business, as our{' '}
                <DocumentLink to="privacy">Privacy Policy</DocumentLink> explains.
              </li>
              <li>
                We may also use what you share to improve PriceCharm, after removing your name,
                contact details, address and anything else that identifies you. We don’t do this
                with messages sent through WhatsApp, Messenger or Instagram.
              </li>
              <li>
                If you message a business on WhatsApp, Messenger or Instagram, Meta’s own terms and
                privacy policy apply to those apps too.
              </li>
              <li>
                Use the quote page honestly. Don’t make fake requests, try to misuse the assistant,
                or send anything illegal or anyone else’s private information.
              </li>
            </ul>
            <p>
              The sections on acceptable use, disclaimers, limitation of liability and disputes
              apply to you too. Some places don’t allow these limits for consumers, so they may not
              all apply to you.
            </p>
          </>
        ),
      },
      {
        id: 'disputes',
        title: 'Disputes',
        body: (
          <>
            <p>
              {state ? (
                <>
                  These terms are governed by the laws of the State of {state}, without regard to
                  its conflict-of-law rules.
                </>
              ) : (
                <>
                  These terms are governed by the laws of the US state where we’re based, without
                  regard to its conflict-of-law rules.
                </>
              )}
            </p>
            <p>
              If a dispute comes up, contact us first at {mail}, and we’ll both try in good faith to
              resolve it within 30 days. If we can’t, it will be decided only in the state or
              federal courts located in {state || 'that state'}, and you and we agree to their
              jurisdiction. Either of us may still bring a claim in small claims court, or ask any
              court to stop misuse of PriceCharm or to protect intellectual property.
            </p>
          </>
        ),
      },
      {
        id: 'changes',
        title: 'Changes to these terms',
        body: (
          <p>
            We may update these terms. We’ll post the new version here with a new date. For
            significant changes, we’ll email account owners at least 30 days before they take
            effect. If you keep using PriceCharm after that, the new terms apply. If you don’t
            agree, close your account before they take effect.
          </p>
        ),
      },
      {
        id: 'general',
        title: 'General',
        body: (
          <ul>
            <li>
              These terms and our <DocumentLink to="privacy">Privacy Policy</DocumentLink> are the
              whole agreement between you and us about PriceCharm.
            </li>
            <li>If part of these terms can’t be enforced, the rest still applies.</li>
            <li>If we don’t enforce a right straight away, we haven’t given it up.</li>
            <li>
              You can’t transfer these terms without our written consent. We may transfer them as
              part of a merger, acquisition or sale of assets.
            </li>
            <li>
              Neither of us is responsible for delays caused by events beyond reasonable control,
              such as internet or hosting outages, natural disasters or government action. This
              doesn’t excuse paying fees.
            </li>
            <li>
              We’ll send notices to your account’s email address. Send notices to us at {mail}
              {operator?.address ? <> or by mail to {operator.address}</> : null}.
            </li>
            <li>
              You and we are independent. These terms don’t create a partnership, agency or
              employment relationship, and they don’t give anyone else rights under them.
            </li>
          </ul>
        ),
      },
    ],
  };
}
