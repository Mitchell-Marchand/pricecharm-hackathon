# Identity, transactional email and billing setup

The API and worker use the same dedicated application database and environment. The worker is required: it delivers queued email, reports qualified usage, reconciles Stripe subscriptions, expires identity records, and executes account deletion. Apply all migrations before starting either process.

## Local and test isolation

Use `MAIL_PROVIDER=local` and `BILLING_PROVIDER=local` outside production. Local email stays in the encrypted database outbox; local checkout activates an explicitly local subscription and never calls a payment provider. Owner responses may include `devToken` and customer verification responses may include `devCode`. Authenticated owners can inspect only their workspace through `GET /api/v1/account/local-outbox`. These development responses and local providers are prohibited in production.

Tests explicitly set the local providers and mock the official Stripe and SES SDKs when exercising their request shapes. Never run QA with real recipients or live Stripe payment actions. Run `RUN_DB_TESTS=1 AI_PROVIDER=demo MAIL_PROVIDER=local BILLING_PROVIDER=local npm test` against the dedicated test database.

## SES production transport

Set `MAIL_PROVIDER=ses`, `AWS_REGION`, and a verified `SES_EMAIL_FROM`. Verify the sending identity in the same AWS region, configure DKIM/SPF/DMARC, and obtain SES production access before sending to recipients outside the sandbox. Give the EC2 instance role `ses:SendEmail` for the verified sending identity. Do not store AWS access keys in GitHub or the application repository.

Generate a 32-byte secret with `openssl rand -base64 32` and store it as `MAIL_ENCRYPTION_KEY` in the API/worker environment. Keep this key stable across releases and securely back it up: queued mail cannot be decrypted without it. Plan a controlled migration before rotating it while jobs remain queued. AES-256-GCM encrypts the entire mail payload, including verification links/codes, at rest. Identity tables contain token hashes or HMAC-protected OTPs, never plaintext credentials.

Email rows and their `send_email` jobs are inserted in the same transaction as the triggering state change. Unique deduplication keys prevent duplicate jobs. SES receives an opaque `quotient_email_id` tag for investigation. The SDK timeout is bounded and its automatic retries are disabled because SES SendEmail has no application idempotency key. A definite rejection can be retried; an ambiguous network outcome is marked `uncertain` and requires checking provider logs before resending. Failed jobs must trigger operational alerts. Never blindly reset an uncertain email row to pending.

Owner email links expire after 24 hours; password reset links expire after 30 minutes. Reset consumes the token and revokes all owner sessions. Customer codes expire after 10 minutes, allow five attempts, and bind to the exact business, chat and normalized email. Request cooldowns and durable rate limits apply. Production never returns a code or recovery token in an HTTP response.

## Stripe product and meter

Set `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_METER_EVENT_NAME=quotient_fee_cents`, `STRIPE_PRICE_ID`, `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`. Production refuses to start without all six. Keep sandbox/test and live Stripe settings completely separate.

Create a Stripe Billing meter with event name `quotient_fee_cents`, aggregation **sum**, customer mapping `stripe_customer_id`, and numeric value mapping `value`. Then create three USD prices:

| Setting | Price |
| --- | --- |
| `STRIPE_PRICE_ID` | Recurring, metered against the meter, monthly, **$0.01 per unit**. Every plan's quote fees go through it. The unit is one cent of fees, not one quote or one dollar of project value: a $1.25 fee sends `value=125`. |
| `STRIPE_PRICE_MONTHLY` | Recurring, licensed (flat), monthly, **$49.00**: the monthly plan (`BILLING_MONTHLY_CENTS`). |
| `STRIPE_PRICE_YEARLY` | Recurring, licensed (flat), yearly, **$499.00**: the yearly plan (`BILLING_YEARLY_CENTS`). |

A subscription carries the usage price and, on the monthly or yearly plan, that plan's price as well. Configure monthly invoicing and the customer portal in Stripe. The portal uses the account's default configuration, which is one more reason PriceCharm should have a Stripe account of its own. Before starting Checkout, the API checks each price. The usage price must be one cent per unit on a sum meter with the matching event name. A plan price must be active, USD, licensed, on the right interval and exactly the amount the pricing page shows. A mistyped price fails closed.

Checkout uses the server's fixed price IDs. Return URLs come only from the configured application origin. Only a verified account owner can activate billing. Existing open Checkout sessions are reused, customer/session creation has stable idempotency keys, and the portal is scoped to the authenticated business's Stripe customer. Customers pay this SaaS for quote delivery; this integration does not process their customers' project payments or use Stripe Connect.

Configure the HTTPS webhook at `/api/v1/billing/webhook` with snapshot events for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Also register the meter error events supported by your Stripe account (`v1.billing.meter.error_report_triggered`, `v1.billing.meter.no_meter_found`). Use the signing secret for that exact endpoint. The route must remain mounted with its raw body before JSON parsing. Signed event IDs are stored once, work is queued, and the worker reads current subscription state from Stripe rather than trusting delivery order. Meter-error events become visible failed reconciliation work; they must be investigated before invoice finalization.

## Trial, tariff, spending caps and reconciliation

There are no free quotes by default: owners choose a plan and add a payment method before their first customer quote goes out, and until then quotes wait for them. `BILLING_TRIAL_QUOTES` (0–100) gives new accounts that many free quotes first, if you ever want to. A plan's fee terms are saved on the account when the plan is chosen and on every fee, so changing environment settings never reprices an earlier charge.

The plans, with their server settings and defaults:

| Plan | What it costs |
| --- | --- |
| Per quote | $2 for each quote a customer receives (`BILLING_PER_QUOTE_CENTS`). |
| Per accepted quote | 1% of the quote when the customer accepts it, at least $1 and at most $25 (`BILLING_ACCEPTED_BASIS_POINTS`, `BILLING_ACCEPTED_MINIMUM_CENTS`, `BILLING_ACCEPTED_MAXIMUM_CENTS`). Nothing if they don't. |
| Monthly | $49 a month, covering 100 quotes a month (`BILLING_INCLUDED_QUOTES`), then $1 a quote (`BILLING_OVERAGE_CENTS`). |
| Yearly | $499 a year, with the same monthly allowance and overage. |

The first monthly or yearly subscription starts with a 7-day free trial (`BILLING_TRIAL_DAYS`). Public `/api/v1/pricing` shows the current prices. Prices use integer cents and exact rounding. A quote qualifies when a customer with a verified email receives it, whether it went out automatically or the owner approved it. Each account's `trial_quote_limit` qualifying quotes are free first (none by default). Practice, owner test chats, abandoned requests and repeat sends of the same quote never incur fees.

`quote_usage` is the durable delivery/fee ledger. Each quote has one immutable fee/tariff snapshot; associated dispatch timestamps do not change its financial fields. Trial allowance and the monthly spending cap are enforced while holding the business row lock, including the next quote's fee. The default cap is $100 in platform fees per UTC calendar month; an owner can change it through `PATCH /api/v1/billing`. The UTC cap window is distinct from Stripe's subscription invoice dates. If billing is unavailable, past due, stale or capped, new quotes wait for the owner, and the owner can't send them until billing is fixed or the cap is raised.

Meter dispatch uses `identifier=quotient:<usage-id>` and `Idempotency-Key=quotient-meter:<usage-id>`. Stripe processes meter events asynchronously. The application ledger, not delayed Stripe summaries, controls allowance and caps. A worker crash can safely retry with these stable keys during the bounded retry window. An uncertain dispatch older than 23 hours is stopped for manual reconciliation rather than risking a duplicate beyond provider idempotency retention. Monitor failed work and compare ledger totals to Stripe meter summaries before invoice finalization; use Stripe's invoice finalization grace-period settings to allow reconciliation. A 30-minute maintenance job schedules current-state subscription reconciliation and missing meter work; failed jobs remain inspectable.

## Data export and deletion

Owners can export tenant data without password/token hashes or internal email/job payloads. Deletion requires the current password and exact business name, immediately revokes sessions and publication, and queues cleanup. The worker flushes outstanding qualified usage, cancels the subscription with final invoicing, deletes private photos, and removes tenant records in foreign-key order. Retries are idempotent and never delete another business. Minimal deletion audit IDs and timestamps remain. Stripe may retain financial/customer records under its own retention rules; deleting the application tenant does not erase required provider billing records. A failed cancellation or uncertain usage dispatch retains the cleanup job for investigation rather than losing the financial audit trail.

Primary references: [SESv2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html), [SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html), [Stripe metering](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api), [Stripe webhooks](https://docs.stripe.com/webhooks), [Stripe hosted subscriptions](https://docs.stripe.com/payments/checkout/build-subscriptions?payment-ui=stripe-hosted), [Stripe customer portal](https://docs.stripe.com/customer-management).
