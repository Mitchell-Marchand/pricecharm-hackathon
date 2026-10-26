# Quotefolk API

TypeScript / Express service for a business-owned quoting assistant. Stores accounts, pricing rules, historical projects, practice conversations, customer requests, and delivery events in a dedicated MySQL-compatible database.

## Development

Use Node 24 LTS. Quotefolk has its own database (see `docs/ops/database.md`); database names must begin with `quotient` or `quoting`. Run these from the repository root:

```sh
npm ci
npm run db:start
cp apps/api/.env.example apps/api/.env
# Add Quotefolk's own dev AI keys (docs/ops/ai-keys.md), or set AI_PROVIDER=demo.
npm run migrate --workspace @quotefolk/api
npm run dev
```

`npm run test:db` runs every API test, including the database tests, against a throwaway `quoting_test` database.

From the repository root, `npm run dev` starts the API, worker and web app. `npm run db:start` runs Quotefolk's own local MariaDB, and `python3 scripts/setup-local.py` writes a local `.env` for it without printing credentials. It never copies another product's AI keys; add Quotefolk's own dev keys (see `docs/ops/ai-keys.md`).

The API binds to `127.0.0.1:4100`. Its database connection pool defaults to five connections. `APP_ORIGIN` is the exact frontend origin (comma-separated values are supported during development). Never commit `.env` files.

`AI_PROVIDER=openai` uses the Responses API; `AI_PROVIDER=anthropic` uses the Messages API. Provider errors fail visibly. Practice image generation uses `OPENAI_API_KEY` independently of the selected chat provider, with `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare` by default. Set `AI_PROVIDER=demo` explicitly for deterministic local practice with no provider requests. Demo mode is rejected in production. Both chat adapters support normalized customer photos, PDF document extraction and validated structured responses. A memory/time-limited child process parses PDFs before provider submission.

## Core endpoints

All API routes use `/api/v1`. Success bodies are `{ "data": ... }`; failures are `{ "error": { "code": ..., "message": ... } }`. Monetary values are integer cents. Browser owner mutations require an allowed Origin and a valid HttpOnly session cookie.

| Area                 | Routes                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts             | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/request-verification`, `/auth/verify-email`; `GET /auth/me`, `/account/export`; `DELETE /account` |
| Guest preview        | `GET /guest-preview`, `POST /guest-preview`; authenticated `POST /guest-preview/:id/claim`                                                                                                                      |
| Business             | `GET/PATCH /business`, `GET /dashboard`                                                                                                                                                                         |
| Service introduction | `POST /service-setup`, `GET /service-setup/:id`, `POST /service-setup/:id/messages`, `/confirm`                                                                                                                 |
| Pricing              | `GET/POST /services`, `PATCH /services/:id`, `POST /services/:id/evaluate`, `/publish`, `/pause`                                                                                                                |
| History              | `GET/POST /examples`, `DELETE /examples/:id`, `POST /examples/import?serviceId=...`; `POST /imports/document`, `GET /imports`, `POST /imports/:id/confirm`                                                      |
| Learning             | `POST /services/:id/learn`, `GET /services/:id/proposals`, `POST /proposals/:id/apply`                                                                                                                          |
| Teaching             | `GET/POST /training`, `GET /training/:id`, `POST /training/:id/messages`, `/photos`, `/photos/:requestId/retry`, `/quote-draft`, `/complete`; `GET /training/:id/photos/:photoId`                               |
| Testing              | `POST /playground`, `/playground/sessions`; `GET/POST/DELETE /services/:id/test-cases`; `GET /services/:id/readiness` (never billed)                                                                            |
| Review               | `GET /quotes`, `/quotes/page`, `/quotes/:id`; `PATCH /quotes/:id`, `POST /quotes/:id/approve`, `GET /quotes/:id/photos`, `/conversation`                                                                        |
| Photos               | `GET/POST /uploads`, `GET/DELETE /uploads/:id`                                                                                                                                                                  |
| Customer             | `GET /public/:slug`, `POST /public/:slug/sessions`, session messages/uploads/quote routes                                                                                                                       |
| Billing              | `GET/PATCH /billing`, `POST /billing/checkout`, `/billing/portal`, signed `/billing/webhook`; public `GET /pricing`, `/site`                                                                                    |
| Operations           | `GET /usage`, `/settings`; `/health` and `/ready` outside the API prefix                                                                                                                                        |

Owner request alerts link to `/dashboard/quotes?quote=UUID`. `GET /quotes/:id` returns only an authenticated owner’s live customer request, including closed records and requests older than the latest-200 list. Missing, foreign and private-test records use the same not-found response. This read does not issue, revise or notify.

Customer sessions use bearer tokens scoped to one inquiry. Raw tokens are hashed before persistence. Public service metadata excludes rates and internal pricing thresholds. Pending draft amounts stay hidden until owner approval. Public contact verification, owner follow-up and acceptance/decline routes are scoped to that exact inquiry. Emailed inquiry access tokens use URL fragments and are cleared before session restoration.

## Historical CSV import

Submit UTF-8 content with `Content-Type: text/csv`. Required columns are:

```csv
title,description,quantity,finalPrice,rationale
Standard driveway,"Concrete, easy access",1000,200.00,Standard rate
```

`finalPrice` is a dollar amount with at most two decimals; quantities support up to three decimals. Up to 100 records can be imported per request. Every record is validated before an atomic transaction; failed imports add no projects.

## Pricing and publication

The public entry flow returns a real job/service receipt and three to five proposed customer questions before signup. A private HttpOnly proof cookie scopes the preview, which expires after 30 minutes. GET and identical request retries reuse its stored result. GET accepts either requestId or previewId and separately exposes a usable earlier recoverablePreview without replacing its primary result. Signup restores the exact approved ID/version. Explicit uncertain retries can send expectedSessionExpiresAt; the locked proof session must match before any reservation. Earlier receipt recovery does not renew expiry or bypass allowances. Explicitly saving through signup claims it atomically and applies only the displayed questions, without repeating analysis. Prices and automatic limits remain zero, unpublished and owner reviewed. Literal historical money retains its source currency; a bare `$` is not enough to create a USD amount. Expired unclaimed notes are removed by worker maintenance; owned evidence and a minimal retry receipt remain until account deletion.

Guest previews interpret the owner's current offering and one actual past job in the same model response. Currentness and history use exact private source excerpts; bounded monetary and quantity checks preserve honest unknowns without inferring rates. The assistant asks prospective customers about their own new projects, prioritizing relevant work, evidence and observable conditions. Literal source membership does not prove semantic meaning. R51's actual review found useful writing, wooden-goods and piano previews, a correct hobby-only refusal, and remaining organizing/audio scope and branch errors. The owner reviews the result before saving. Private outputs stay outside exports; aggregate findings are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

Service introductions persist a resumable, owner-scoped conversation and a working draft. Each turn accepts an expected version and reserves a processing lease. Confirming the summary explicitly creates an unpublished service with zero pricing and an automatic quote limit of zero. No example or rate is required. Only complete owner-supported historical facts become an example; an individual job never silently sets a standard rate. Introductory notes remain available to later pricing proposals for owner review. Migration `007_service_setup.sql` adds this storage.

The calculator applies base charge + quantity × unit price, subject to the approved minimum. Arithmetic uses integer cents with bounded quantity precision. Pricing proposals from completed teaching sessions require explicit owner acceptance; they never silently update service rules.

`POST /training/:id/quote-draft` captures the owner's final price and rationale across the current statement and last eight owner turns for inline review. A selected prior price needs exact owner evidence and matching cents; current literal totals retain precedence. Unknown or unsupported values remain empty. It does not complete a session or mutate pricing; the owner confirms through `/complete`. Completed quotes without a measured quantity reach Learn as private `practice_quote` case notes with confirmed price/reason and unknown quantity/unit, never as numeric calculator examples. App-generated completion summaries are kept separate from verbatim owner turns.

Private evidence saves invalidate saved checks and automatic approval while preserving an existing owner-review publication. Actual policy edits still invalidate publication and automatic approval. Service updates can include `expectedVersion` to reject stale changes. Review publication requires a service description, business description and service area, while every final price stays subject to owner approval. It can start before rates or historical examples are configured. Automatic publication requires configured pricing/evidence, verified owner email, explicit approval and passing independent owner-labelled cases for the current service/engine version; teaching agreement alone never enables it. The server checks customer verification, policy version, facts, scope, location, exclusions, amount limits, owner pause and billing capacity again before delivery. Any uncertainty goes to owner review.

The read-only readiness endpoint restores saved evaluation results without model calls, reservations or writes. It distinguishes current results from policy, model or engine changes; a passing historical result cannot authorize a changed assistant. An unchanged cap-only update is a no-op after its expected-version check. Actual cap changes and independent-case edits retain an already-published owner-review link while clearing automatic approval and advancing the version. Automatic publication still pauses for these changes. Private example saves/deletion, CSV and reviewed document confirmation, and saved numeric/inspection practice use the same review-link continuity. Actual pricing, scope and applied teaching changes remain separate and pause publication.

Conditional fixed/per-unit/percentage extras, discounts and review rules use a bounded declarative schema; no customer or AI code is executed. Historical-learning proposals and document drafts require owner confirmation before changing the playbook. Applying an actual policy change invalidates publication and requires re-evaluation. Explicit approval of an identical policy records the decision once without changing the service version or publication/automatic approval. Migration014 binds each applied proposal to its actual resulting version; saved recovery requires that exact version and teaching revision.

Customer browser proofs keep their original seven-day expiry. An explicit owner issuance/reply can send a verified, consented inquiry contact a separately expiring seven-day email grant, without reviving original or replaced proofs. Session responses report the expiry of the actual matched grant. The encrypted outbox stores private grant metadata; pre-send validation terminally skips expired, superseded, revoked or unavailable customer notifications instead of marking them sent. Legacy customer-link mail without verifiable metadata is skipped. Identity/owner-dashboard mail and uncertain-delivery reconciliation retain their existing behavior. Access expiry does not imply inquiry-data deletion.

## Photos and provider budgets

JPEG, PNG and WebP files are checked by content, rotated, resized, stripped of metadata and converted to bounded JPEGs. Owner retrieval is authenticated; customer retrieval requires its inquiry token. There are per-inquiry, file-size, workspace-storage and concurrent-processing limits.

Local photos use `UPLOAD_DIR`. Set `S3_BUCKET`, `S3_PREFIX` and `AWS_REGION` to use private encrypted S3 with the standard AWS credential chain (prefer an EC2 instance role). No public bucket ACL is requested.

When the owner asks the practice customer for photos, the request becomes a durable background image job. Keep the worker running alongside the API. The conversation shows generation progress, actual labelled sample images, or a failure with an explicit retry. Images are generated from the fictional scenario and requested views, stored privately, and retained with their messages across refreshes. Completed views remain visible when another view fails; explicit retries generate only unfinished views. Requests reuse existing room images, with up to three views per request and six distinct views per practice conversation. They are not photographs of an actual customer's property. Generation uses a separate image timeout (`AI_IMAGE_TIMEOUT_MS`, default 120 seconds) rather than keeping a chat HTTP request open. Paid image jobs are not automatically retried.

Older text-only photo promises have a `Show sample photos` recovery action. The owner can also continue the same conversation with a photo request such as `All rooms, please`. Subsequent simulated-customer replies receive up to three generated images and the saved scene captions. Completing practice retains the image links on its example; pricing proposals continue to use confirmed textual facts and the owner's rationale, without inferring exact measurements or rates from pixels.

AI requests reserve durable per-workspace and application-wide daily allowances before a provider call. Defaults are 100 logical calls/workspace/day and 1,000/app/day. Failed or ambiguous calls still consume a reservation. Actual token usage is recorded separately.

Guest previews share that global allowance, with additional defaults of 50/app/day and 3/IP/day through `GUEST_PREVIEW_DAILY_APP_LIMIT` and `GUEST_PREVIEW_DAILY_IP_LIMIT`. The database stores a daily HMAC fingerprint rather than a raw address. Production requires the existing `MAIL_ENCRYPTION_KEY`; local development can use the isolated database password. Each guest attempt makes at most one provider HTTP request, including failures. Claiming transfers recorded usage to the account without charging for a quote.

## Validation

```sh
npm run typecheck
npm test
npm run build
AI_PROVIDER=demo RUN_DB_TESTS=1 npm test
```

Database tests require this app's isolated local database and create/clean their own fixtures. They never contact providers. Adapter tests mock provider HTTP responses. Live-provider smoke tests were separately run with explicit authorization.

The test command serializes test files because real database fixtures share the local mail/job queues and application-wide budgets. This keeps fixture cleanup from deadlocking under parallel runs.

The current R56 API passed 178/178 tests with zero skips on a fresh restricted database, including all 14 migrations / 32 tables and exact database/users/uploads cleanup. R57 web passed 52 existing fully mocked browser cases, including the complete teach/practice/confirm/learn/apply/Try handoff and completion reload. A bounded two-request live HTTP check used seeded fictional chat: it captured $275 and a separate reason, then referenced that saved practice case in an unpriced learning proposal. The fixture was cleaned while reservations remained consumed. Local API/worker use the verified R56 snapshot with R57 web. The model and ignored configuration are unchanged. Earlier R51 preview findings and organizing/audio limitations remain historical evidence. See [docs/VERIFICATION.md](docs/VERIFICATION.md); this does not establish general pricing accuracy, customer adoption or AWS deployment.

## Deployment

Start with [deploy/LAUNCH.md](deploy/LAUNCH.md) for the full setup, [deploy/COMMERCE.md](deploy/COMMERCE.md) for SES/Stripe, and [deploy/README.md](deploy/README.md) for GitHub Actions/EC2 rollback details. The included CloudFormation template and AL2023 bootstrap provision a dedicated app host. Migrations are additive and serialized.

Production requires configured live AI, SES, Stripe and public operator/support details. The worker generates requested practice photos, delivers encrypted queued emails, reports immutable metered quote fees, reconciles subscriptions and performs scoped deletion. Use `node dist/ops.js --http` to inspect readiness/queue health. Back up the isolated database with `deploy/ops/backup.py` and test restoring into a separate database.

The app uses a reviewable pricing playbook; it does not fine-tune model weights. Initial currency is USD. It records quote acceptance but does not schedule jobs or collect the business's project payments. Account-specific AWS/domain/SES/Stripe/GitHub configuration is required before public launch.
