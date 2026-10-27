# Dedicated AI keys

PriceCharm needs its own keys, one set per environment, each with a spending cap set at the provider.

Only you can create these keys. They live in your provider accounts.

## What to create

| Environment | OpenAI | Anthropic | Suggested monthly cap |
| --- | --- | --- | --- |
| Local development | Project "PriceCharm dev" | Workspace "PriceCharm dev" | Low, such as $20 |
| Staging | Project "PriceCharm staging" | Workspace "PriceCharm staging" | Low |
| Production | Project "PriceCharm production" | Workspace "PriceCharm production" | Set from expected volume, with alerts at 50% and 80% |

**OpenAI** (platform.openai.com):

1. Create a project for each environment.
2. In the project's limits, set a monthly budget with email alerts, and allow only the models PriceCharm uses: the chat model in `OPENAI_MODEL`, the drafting model in `OPENAI_DRAFT_MODEL` if you set one, and the image model in `OPENAI_IMAGE_MODEL`.
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

The provider cap is the hard backstop. The API also counts AI calls per UTC day, in these pools:

| Setting | Default | Covers |
| --- | --- | --- |
| `AI_DAILY_APP_LIMIT` | 1000 | Every AI call |
| `AI_DAILY_BUSINESS_LIMIT` | 100 | One business's own work: past jobs, practice, its own test chats |
| `AI_DAILY_CUSTOMER_APP_LIMIT` | 600 | Customer chat on every business's link, together |
| `AI_DAILY_BUSINESS_CUSTOMER_LIMIT` | 200 | Customer chat on one business's link |
| `AI_DAILY_CUSTOMER_IP_LIMIT` | 60 | Customer chat from one address, across all businesses |
| `AI_DAILY_DRAFT_APP_LIMIT` | 400 | Setups that haven't signed up yet, together |
| `AI_DRAFT_LIFETIME_LIMIT` | 150 | One setup before signup, in total |
| `AI_DAILY_DEMO_LIMIT` | 300 | The live demo on the website, all visitors together |
| `AI_DAILY_DEMO_IP_LIMIT` | 40 | The live demo, from one address |

Customer chat can't touch an owner's allowance, and customers together can't use more than their pool, so signed-up owners always have the rest of the app limit. Setups before signup have a pool of their own for the same reason, and so does the live demo, where each chat is also capped at 12 calls. Starting setup, signup, demo chats and new customer chats also need a Turnstile check on staging and production.

The pools count calls, not tokens, so a chat with several photos costs more than its count suggests. Set the provider cap with that in mind.
