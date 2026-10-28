# PriceCharm API

The Express API behind PriceCharm. It keeps accounts, setup, past jobs, practice, customer chats, quotes and billing in PriceCharm's own MySQL-compatible database, and runs the AI.

## Development

Use Node 24. PriceCharm has its own database (see `docs/ops/database.md`); database names must begin with `quotient` or `quoting`. From the repository root:

```sh
npm ci
npm run db:start
cp apps/api/.env.example apps/api/.env
# Add PriceCharm's own dev AI keys (docs/ops/ai-keys.md), or set AI_PROVIDER=demo.
npm run migrate --workspace @pricecharm/api
npm run dev
```

`npm run dev` starts the API on `127.0.0.1:4100`, its worker and the web app. `APP_ORIGIN` is the web app's exact origin. Never commit `.env` files.

`AI_PROVIDER` is `openai` (Responses API), `anthropic` (Messages API) or `demo`. Demo mode needs no keys, makes no provider calls and gives scripted, labelled answers; tests and the browser tests use it, and production refuses it. Practice photos always use OpenAI images (`OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`), whichever chat provider is selected.

## Routes

Everything is under `/api/v1`. Success bodies are `{ "data": ... }` and failures `{ "error": { "code", "message" } }`. Money is integer cents. Requests that change something need an allowed `Origin`.

| Area      | Routes                                                                                                                                        | Who                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Setup     | `/onboarding` (start, business, step, resume link), `/onboarding/jobs`, `/onboarding/photos`, `/onboarding/practice/*`, `/onboarding/profile`, `/onboarding/knows` with questions and notes (what the chat asks, each service's rate, notes every draft follows) | A draft or a signed-in owner |
| Accounts  | `/auth/register`, `/login`, `/logout`, `/me`, `/forgot-password`, `/reset-password`, `/request-verification`, `/verify-email`                 | Anyone, or the owner         |
| Customers | `/chat/:slug` and `/chat/:slug/:chatId/*`: messages, photos, contact, verify, accept, visit; `/chat/:slug/logo/:id`                           | Anyone with the chat token   |
| Demo      | `/demo/start` (bot check), `/demo/turn`, `/demo/quote`: the live demo with the sample businesses                                              | Anyone with a demo pass      |
| Quotes    | `/app/home`, `/app/quotes`, `/app/quotes/:id` with approve, decline and messages; `/app/profile`, `/app/settings`, `/app/billing`             | The owner                    |
| Quote page | `/app/quote-page` (logo, the name customers hear from, the lines after a yes or a visit request, the accept button's words), `/app/quote-page/logo` | The owner                    |
| Sharing   | `/share`, `/share/instructions`                                                                                                               | The owner                    |
| Billing   | `PATCH /billing`, `/billing/checkout`, `/billing/portal`, signed `/billing/webhook`; public `/pricing`, `/site`                               | The owner, Stripe, anyone    |
| Account   | `/account/export`, `DELETE /account`, `/uploads/:id` (a customer's photo)                                                                     | The owner                    |

`/health` and `/ready` sit outside the prefix.

## How it works

**Setup before signup.** A new visitor gets a draft business tied to an HttpOnly cookie (14 days). Setup, past jobs and practice all save to it, and signup claims it. Drafts have their own AI allowance and are deleted when they expire.

**Practice.** The AI writes three practice customers for the business's trade, each with a hidden fact sheet and generated photos. Before the owner sends each practice quote, the AI makes its own private guess. Once its last two guesses are within 15% of the owner's, quotes can go out on their own.

**Pricing.** The AI drafts line items only from this business's own past jobs, practice quotes and the lessons the owner confirmed. The server adds them up and checks the result: it must be priced, under the owner's limit, for a listed service, inside the area, and close to what similar past jobs cost. Anything that fails a check, or any quote while automatic sending is off, waits for the owner.

**Customers.** A chat token, stored only as a hash, scopes each customer to their own chat. Customers confirm their email with a six-digit code (five tries, ten minutes) before they see a price. Emailed links carry a separate token in the URL fragment. An owner chatting with their own link gets a test chat that is never emailed or billed.

**The live demo.** Visitors to the website can chat with a sample business for any trade and get a quote. The sample businesses and prices live in `@pricecharm/trades/demos`, on the server, so a visitor can't change them. Each demo chat starts with a bot check that earns a signed pass, good for an hour. Demo AI calls have their own daily pool inside the app-wide one, plus caps per visitor and per chat. Messages are short, nothing is saved, and replies or quote lines with links, emails or phone numbers are replaced.

**Billing.** Each quote a verified customer receives has a fee (1% by default, at least $1 and at most $25), recorded once in `quote_usage` and reported to Stripe by the worker. Owners add a payment method before their first customer quote; until then, quotes wait for them. See [deploy/COMMERCE.md](deploy/COMMERCE.md).

## Photos and AI allowances

Uploaded photos are checked by content, rotated, resized, stripped of metadata and stored as JPEGs in `UPLOAD_DIR`, or in private S3 when `S3_BUCKET` is set. Owners fetch their customers' photos with their session; customers fetch theirs with the chat token.

Every AI call reserves a daily allowance first, including calls that fail: per business, per draft, for all customers together, per business's customers, and per customer address (stored only as a keyed daily fingerprint). The settings are in `.env.example`.

## Tests

```sh
npm run typecheck --workspace @pricecharm/api
npm test --workspace @pricecharm/api   # unit tests
npm run test:db                       # everything, against a throwaway quoting_test database
```

Provider tests mock HTTP and never call a real model. Test files run one at a time because database fixtures share the mail and job queues.

## Deployment

Start with [deploy/LAUNCH.md](deploy/LAUNCH.md), then [deploy/COMMERCE.md](deploy/COMMERCE.md) for SES and Stripe and [deploy/README.md](deploy/README.md) for the GitHub Actions and EC2 details. The worker must run alongside the API: it sends email, reports fees, reconciles Stripe, deletes accounts and expired drafts, and cleans up. `node dist/ops.js --http` checks readiness and queues in production.
