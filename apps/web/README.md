# Quotefolk Web

Next.js / React frontend for the Quotefolk quoting platform. A separate Node API owns pricing, AI orchestration, accounts and persistence.

## Run locally

Use Node 24. From the repository root, `npm run dev` starts the API on port 4100, its worker and this app on port 3100:

```sh
npm ci
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

`bash scripts/e2e.sh` runs the Playwright suite against a real API and the throwaway test database, on ports 3300 and 4200.

Open http://localhost:3100 and describe a past job or your service. See a real receipt and proposed customer questions before creating an account. Saving the assistant through three-field signup keeps the original note and those exact approved questions without repeating analysis. The next screen is Teach: the saved job, literal charge/reason and one explicit **Price a practice job** action. Finish reviews a price and reason even when stated in separate replies. A confirmed practice decision reaches learning with unknown measurements preserved; its next suggestion needs explicit approval before Try. Completed decisions and their reasoning remain visible, and an older lesson cannot hide learning from the new case after reload. Try keeps the saved project editable. Requests appear in the separate inbox; detailed tools live in the account menu.

An unambiguous company name from the exact approved note prefills the existing Business name field. It stays editable, and owner edits or deliberate clearing win over a delayed response or registration error. Missing suggestions stay blank; the AI service title and a later draft never supply a business name. Sign-in and claiming preserve the existing account identity.

The homepage keeps the original note, the assistant’s proposed customer questions and a working reply field in one conversation. Unclear notes can be answered immediately; ready previews can be corrected before saving. A short role or misspelled service name does not need a pricing form. Historical charges remain evidence of that job, with unknown currency and measurements preserved rather than invented standard rates.

The owner workspace uses a desktop sidebar and a compact phone header. Teach, Try and Share remain the three assistant steps. Active practice gives the conversation its screen space; detailed service settings, imports and pricing tools remain available when needed. Customer requests keep messages, project facts and separately approved pricing together.

`API_BASE_URL` defaults to `http://127.0.0.1:4100`. Browser API calls use `/api/v1` on the same origin and are rewritten to the separate API. All OpenAI, Anthropic, database and Stripe secrets belong in the backend environment. They must never use `NEXT_PUBLIC_` names.

## Routes

| Route                                                  | Purpose                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                                                    | Job/service capture and real preview before signup                                                                                                                 |
| `/signup`, `/login`                                    | Account creation and sign-in                                                                                                                                       |
| `/forgot-password`, `/reset-password`, `/verify-email` | Account recovery and verified email                                                                                                                                |
| `/pricing`, `/privacy`, `/terms`                       | Live tariff, product policies and configured support contact                                                                                                       |
| `/onboarding`                                          | Authenticated compatibility redirect to the assistant                                                                                                              |
| `/dashboard`                                           | Continuous Teach → Try → Share workspace; optional `service`, `step`, `practice` query parameters                                                                  |
| `/dashboard/services`                                  | Service conversations, pricing policies and service scope; `?new=1` starts or resumes an introduction                                                              |
| `/dashboard/examples`                                  | Historical projects, CSV, reviewed document imports and learned playbook proposals                                                                                 |
| `/dashboard/training`                                  | Compatibility redirect to the main practice workspace, preserving service/session links                                                                            |
| `/dashboard/playground`                                | Private, nonbillable calculator and customer-chat tests                                                                                                            |
| `/dashboard/quotes`                                    | Paged customer requests with global filters, photos, conversation and owner approval; safe quote/filter/cursor links preserve the task through sign-in and history |
| `/dashboard/publish`                                   | Independent test cases/evaluation, explicit automatic approval, hosted links and embeds                                                                            |
| `/dashboard/settings`                                  | Profile, provider status, usage, account export/deletion                                                                                                           |
| `/dashboard/billing`                                   | Trial, actual tariff, Checkout, customer portal and monthly spending cap                                                                                           |
| `/q/:slug`                                             | Hosted customer inquiry experience                                                                                                                                 |
| `/embed/:slug`                                         | Embeddable customer experience                                                                                                                                     |
| `/embed.js`                                            | Script launcher that inserts the iframe                                                                                                                            |

## Styling and accessibility

The interface draws from Abode Money’s public signup flow: comfortable geometric type, forest actions, warm surfaces, compact reply fields and direct language. Variable DM Sans and its SIL Open Font License are in `public/fonts`, pinned to Google Fonts commit `5b35b7208dd4100571326fdf37f030b32a524232`. Production builds do not fetch external fonts. Layouts adapt to mobile; inputs use explicit labels, dialogs trap focus and support Escape, errors are visible, and reduced-motion preferences are respected.

The design foundation lives in `src/app/design-tokens.css`; shared buttons and fields have one definition in `product.css`, and conversation primitives live in `conversation.css`. Teaching, setup, customer chat and the owner inbox share message roles, spacing and composer controls. App controls have a 44px minimum touch size; entry actions can use the explicit larger variant. New component styles should consume the shared tokens rather than append another global override.

Requests open as a conversation workspace with adjoining list and project details on desktop. Phones prioritize the conversation and reply, then pricing and supporting project/photos. Opening a request no longer requires a dialog or another click to reveal its messages. Sending, draft price saving and approval remain separate actions. Successful message reads survive a photo-read failure, with explicit retries for the failed part. This direction follows the focus and role clarity in [Intercom’s current Messenger](https://www.intercom.com/help/en/articles/9319961-updates-to-the-messenger) and [Inbox layout](https://www.intercom.com/help/en/articles/7911926-customize-the-inbox-to-suit-you-and-how-you-work-best), alongside [Abode’s](https://abodemoney.com/) clear first action. Public product references inform the design; they are not evidence of Quotefolk usability or conversion.

Owner/account pages deny framing. The dedicated embed route allows framing. Customer sessions work through scoped tokens without depending on third-party cookies. Browser storage is optional; session continuity within the open widget does not require it.

Practice conversations support requested AI-generated sample photos, with persisted progress, viewable thumbnails and a full-size dialog. Finished photos remain visible while other views generate or fail. Generation retries are explicit; retrying an image that failed to load only fetches its existing bytes. Older text-only photo promises can be recovered with `Show sample photos` without starting another conversation. The API worker and an authorized OpenAI image model must be configured; images never generate merely from opening or refreshing a page.

## Verification

R59’s redesigned flows passed 88 distinct mocked browser cases, with 13 final teaching/photo/navigation/request rechecks, including the measured-practice recovery case. The production build and type checks pass. A separate normal-browser journey used the actual local API, database, worker and OpenAI providers, reaching an approved $345 customer quote, acceptance and ordinary reload. It included generated practice photos, an actual customer upload, local contact verification and explicit owner approval. The real short-note regression `closet orgainzer` is saveable and survives reload without another analysis.

The actual tests found and repaired an unwanted photo batch and repeated/dropped customer facts. The final same-note real response retains all five stated facts and asks only for the missing photo. Exact scope, later focused checks and limits are in the API’s [verification notes](../api/docs/VERIFICATION.md). These fictional journeys do not establish general model accuracy or recruited-owner usability.

```sh
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

End-to-end tests expect the API and web app running locally with local email/payments. Demo AI supports deterministic flows. `LIVE_SETUP_TESTS=1 npx playwright test tests/e2e/setup.spec.ts` additionally exercises the live job-first journey, plain-language pricing clarification, natural final quote confirmation, private customer preview and sharing. The same file includes an owner-reviewed quote flow with no configured prices. Tests create distinctly labelled QA workspaces. Screenshots and traces are ignored by Git.

`tests/e2e/practice-photos.spec.ts` uses fully mocked API responses to check legacy recovery, pending/partial/failed/ready states, explicit generation retry, existing-image retry, full-size viewing and persisted history. It creates no accounts and incurs no image-generation charges. The separate bounded live-image acceptance result is recorded in the API's `docs/VERIFICATION.md`.

## Deployment

See [deploy/README.md](deploy/README.md). GitHub Actions builds a standalone Next.js release, including static files and public assets, for EC2/PM2. Deployment is opt-in and no hosting has been provisioned by this repository.

Automatic delivery requires a current approved policy, passing independent cases, verified contacts and per-request eligibility/billing checks. Review mode and human follow-up remain available. Production uses real configured SES/Stripe integrations; local development uses clearly isolated providers. See the API repository's `deploy/LAUNCH.md` and `deploy/COMMERCE.md` for the account-specific settings and deployment acceptance checks.
