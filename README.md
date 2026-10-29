# PriceCharm

PriceCharm lets a service business train an AI to quote jobs the way the owner would. This repository holds the whole product.

## Meta AI Developer Hackathon (Startups track)

PriceCharm runs on Meta's models through the Meta Model API, in Standard mode only. The API refuses Contributor-mode models, because they would let Meta train on customers' photos and owners' prices.

- **Muse Spark 1.3** runs the customer's quote chat, reads old quotes and invoices into past jobs, and drafts each quote from the owner's own prices. See [`apps/api/src/ai/index.ts`](apps/api/src/ai/index.ts).
- **Walk-around video quotes.** A customer films the job instead of taking photos. Muse Spark 1.2 watches it and hears what they say, then picks what the price depends on, like windows to count or a driveway to size. **SAM 3.1** follows each window through the video and counts it once, then outlines what it found on a still for the owner. The count becomes the size on the quote, in the unit the owner prices by. See [`walkaround.ts`](apps/api/src/ai/walkaround.ts), [`meta-media.ts`](apps/api/src/ai/meta-media.ts) and [`live/videos.ts`](apps/api/src/live/videos.ts).
- **Muse Image** edits the customer's own photo to show the job done, like the same patio with the moss gone. The quote shows the two as a before-and-after the customer can drag across. Owners can turn it off. See [`after-preview.ts`](apps/api/src/ai/after-preview.ts) and [`live/previews.ts`](apps/api/src/live/previews.ts). Muse Image also makes the photos that come with the practice customers owners train on ([`practice-images.ts`](apps/api/src/ai/practice-images.ts)).

### What we built during the hackathon

- the setup flow: pick a trade, add past jobs (with invoice reading), and practice on made-up customers until the AI prices like the owner
- the pricing engine, which learns rates, minimums and price style from the owner's own jobs, and checks every draft against them
- the customer quote chat, on a link and as a website widget, with quotes that send themselves once a service has earned it
- the owner app: quotes waiting for an OK, replies, settings, and what the AI knows
- plans and billing rules, the public site and live demo, and the production deploy
- everything on Meta above: the Muse provider, walk-around video with SAM 3.1, and Muse Image's after pictures and practice photos

| Folder | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Express API, MySQL/MariaDB storage, AI integrations, billing, email and the background worker |
| [`apps/web`](apps/web) | The Next.js web app: the public site, setup, the owner's app and the customer chat |
| [`apps/prototype`](apps/prototype) | The clickable prototype the web app was built from, on mock data |
| [`packages/trades`](packages/trades) | The trades and their services, shared by the API and the web app |
| [`docs`](docs) | [How pricing works](docs/pricing.md) and operations guides ([database](docs/ops/database.md), [AI keys](docs/ops/ai-keys.md)) |
| [`scripts`](scripts) | Local development, test and setup scripts |

## Get started

You need Node 24 (`.nvmrc`) and Docker, for PriceCharm's own local database.

```sh
npm ci
npm run db:start
python3 scripts/setup-local.py
npm run migrate --workspace @pricecharm/api
npm run dev
```

Open http://localhost:3100. The API runs on port 4100.

Add PriceCharm's own development AI keys to `apps/api/.env` ([AI keys guide](docs/ops/ai-keys.md)), or set `AI_PROVIDER=demo` for deterministic, labelled demo responses.

## Everyday commands

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | API, worker and web app. The web app reloads on save; restart for API changes. |
| `npm run typecheck` | Typechecks every app |
| `npm run build` | Builds every app |
| `npm test` | API tests that don't need a database |
| `npm run test:db` | Every API test, including database tests, against a throwaway `quoting_test` database |
| `bash scripts/e2e.sh` | Playwright suite against a real API and the test database, on ports 3300 and 4200 |
| `npm run dev --workspace @pricecharm/prototype` | The onboarding prototype on port 3200 |

## Safety checks

The API refuses to start a staging or production server with settings that are only safe on a laptop:

- demo AI, local email or local payments
- missing `APP_ENV`, `TRUST_PROXY` or provider settings
- an unencrypted connection to a remote database
- email codes in API responses
- a test Stripe key in production, or a live one in staging
- no Turnstile secret, or Cloudflare's test secret in production
- no `SENTRY_DSN` in production

Production runs on one EC2 instance, with MariaDB 11.4 in Docker beside the app. It has a rows-only app user and a separate migration user ([database guide](docs/ops/database.md)).

## CI and deployment

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It covers the API's formatting, types, database tests and build; the web app's formatting, types, build and end-to-end suite; and the prototype's build.
- **Deploy API** and **Deploy web** run on pushes to `main` that change their app. When the repository variable `ENABLE_DEPLOY` is `true`, they copy the release to the server over SSH and restart it with PM2.

The full runbook is [apps/api/deploy/LAUNCH.md](apps/api/deploy/LAUNCH.md).
