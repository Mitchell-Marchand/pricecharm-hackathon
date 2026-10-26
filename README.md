# Quotefolk

Quotefolk lets a service business train an AI to quote jobs the way the owner would. This repository holds the whole product.

| Folder | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Express API, MySQL/MariaDB storage, AI integrations, billing, email and the background worker |
| [`apps/web`](apps/web) | The current Next.js web app. The plan replaces it in phase 3. |
| [`apps/prototype`](apps/prototype) | Clickable prototype of the new onboarding flow, on mock data |
| [`docs`](docs) | Operations guides ([database](docs/ops/database.md), [AI keys](docs/ops/ai-keys.md)) |
| [`scripts`](scripts) | Local development, test and setup scripts |

## Get started

You need Node 24 (`.nvmrc`) and Docker, for Quotefolk's own local database.

```sh
npm ci
npm run db:start
python3 scripts/setup-local.py
npm run migrate --workspace @quotefolk/api
npm run dev
```

Open http://localhost:3100. The API runs on port 4100.

Add Quotefolk's own development AI keys to `apps/api/.env` ([AI keys guide](docs/ops/ai-keys.md)), or set `AI_PROVIDER=demo` for deterministic, labelled demo responses.

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
| `npm run dev --workspace @quotefolk/prototype` | The onboarding prototype on port 3200 |

## Safety checks

The API refuses to start a staging or production server with settings that are only safe on a laptop:

- demo AI, local email or local payments
- missing `APP_ENV`, `TRUST_PROXY` or provider settings
- an unencrypted connection to a remote database
- email codes in API responses
- a test Stripe key in production, or a live one in staging

Production uses its own RDS database, with a rows-only app user and a separate migration user ([database guide](docs/ops/database.md)).

## CI and deployment

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It covers the API's formatting, types, database tests and build; the web app's formatting, types, build and end-to-end suite; and the prototype's build.
- **Deploy API** and **Deploy web** run on pushes to `main` that change their app. They deploy to EC2 only when the repository variable `ENABLE_DEPLOY` is `true`.

The full runbook is [apps/api/deploy/LAUNCH.md](apps/api/deploy/LAUNCH.md).
