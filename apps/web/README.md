# PriceCharm Web

The Next.js app for PriceCharm: the public site, setup, the owner's app, and what customers see on a quote link or a business's website. The API in `apps/api` owns accounts, pricing, AI and data. This app never holds a secret.

## Run locally

Use Node 24. From the repository root, `npm run dev` starts the API on port 4100, its worker and this app on port 3100:

```sh
npm ci
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

Browser requests go to `/api/v1` on this app's own origin, and Next.js forwards them to `API_BASE_URL` (default `http://127.0.0.1:4100`). The address is read when the app is built, and the server also uses it to read business profiles for quote link pages.

## Pages

| Route                                                            | What it is                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/`, `/pricing`, `/privacy`, `/terms`                            | The public site                                                        |
| `/start`                                                         | Setup, before and after signup: business, past jobs, practice, account |
| `/login`, `/forgot-password`, `/reset-password`, `/verify-email` | Signing in, and the links in password and email messages               |
| `/app`                                                           | The owner's quotes: what needs their OK, sent and accepted             |
| `/app/quotes/:id`                                                | One quote with its conversation: send, edit, decline, message          |
| `/app/train`                                                     | What the AI knows, and the owner's past jobs                           |
| `/app/share`                                                     | The quote link, QR code and website widget                             |
| `/app/settings`                                                  | Automatic quotes, billing, and the account                             |
| `/q/:slug`                                                       | A business's quote link: the customer chat                             |
| `/embed/:slug`                                                   | The same chat inside the website widget's frame                        |
| `/widget.js`                                                     | The script businesses paste into their site                            |

## Framing

Only `/embed/:slug` can be shown in a frame, and only on PriceCharm itself or the business's own website (its domain and `www.`). `src/proxy.ts` sets that per business. Every other page refuses to be framed. If the widget's frame doesn't load, for example on a site the business didn't list, the widget offers a link to the quote page instead.

## Design

The design comes from the prototype in `apps/prototype`: the tokens in `src/app/globals.css`, the components in `src/components`, and the quote card in `QuoteForm.tsx`. Quote cards are paper, so they keep the same colors in dark mode.

## Tests

`bash scripts/e2e.sh` (from the repository root) builds this app, starts it with the API and worker on ports 3300 and 4200 against the throwaway test database, and runs the Playwright tests in `tests/e2e`. AI runs in demo mode, and email and billing stay local.

```sh
npm run typecheck --workspace @pricecharm/web
bash scripts/e2e.sh
bash scripts/e2e.sh owner   # one file
```

## Deployment

See [deploy/README.md](deploy/README.md). `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PUBLIC_SENTRY_DSN` are read at build time.
