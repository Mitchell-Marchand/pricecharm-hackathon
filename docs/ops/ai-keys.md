# Dedicated AI keys

Quotefolk needs its own keys, one set per environment, each with a spending cap set at the provider.

Only you can create these keys. They live in your provider accounts.

## What to create

| Environment | OpenAI | Anthropic | Suggested monthly cap |
| --- | --- | --- | --- |
| Local development | Project "Quotefolk dev" | Workspace "Quotefolk dev" | Low, such as $20 |
| Staging | Project "Quotefolk staging" | Workspace "Quotefolk staging" | Low |
| Production | Project "Quotefolk production" | Workspace "Quotefolk production" | Set from expected volume, with alerts at 50% and 80% |

**OpenAI** (platform.openai.com):

1. Create a project for each environment.
2. In the project's limits, set a monthly budget with email alerts, and allow only the models Quotefolk uses: the chat model in `OPENAI_MODEL` and the image model in `OPENAI_IMAGE_MODEL`.
3. Create an API key inside that project.

Practice photos always use OpenAI, so production needs an OpenAI key even when chat runs on Anthropic.

**Anthropic** (console.anthropic.com):

1. Create a workspace for each environment.
2. Set the workspace's spend limit.
3. Create an API key inside it.

## Where the keys go

- **Local:** `apps/api/.env`, as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Restart the API and worker after changing them.
- **Staging and production:** `/srv/quotient-api/shared/.env` on the server only.
- **Nowhere else:** not GitHub secrets (CI uses the demo provider and never calls a model), not the web app, and not any `NEXT_PUBLIC_` variable.

## Spending controls in the app

The provider cap is the hard backstop. The API also has its own daily limits:

- `AI_DAILY_APP_LIMIT` and `AI_DAILY_BUSINESS_LIMIT`
- `GUEST_PREVIEW_DAILY_APP_LIMIT` and `GUEST_PREVIEW_DAILY_IP_LIMIT`

The security review found that one anonymous visitor can use up the shared daily pool. Splitting budgets by visitor type and weighting them by tokens is phase 2 work.
