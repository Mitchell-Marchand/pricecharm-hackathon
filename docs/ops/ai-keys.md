# Dedicated AI keys

PriceCharm needs its own keys, one set per environment, each with a spending cap set at the provider.

Only you can create these keys. They live in your provider accounts.

## Meta (the default)

PriceCharm runs on Meta's models with `AI_PROVIDER=meta`: Muse Spark 1.3 for chat, reading documents and drafting quotes, and Muse Image for practice photos. One key covers both.

1. At dev.meta.ai, create a key for each environment and put it in `META_API_KEY`.
2. On the Billing page, add a card and set a spend limit with alerts.
3. Leave `META_MODEL` on a Standard-mode model such as `muse-spark-1.3`. Never use a `-contributor` model: Contributor mode lets Meta train on what we send, which is customers' photos and owners' prices. The API refuses those models.
4. Free credits work the same way: while a team spends them, Billing says its content "may be used for product improvement." Spend free credits only on local development with made-up data. Staging and production keys belong to a team with "Stop using free credits" turned on, so the privacy policy's promise that providers don't train on what we send stays true.

`META_DRAFT_MODEL` can name a different model just for drafting quotes, such as `muse-wonder-1.0`. Compare candidates with `npm run replay`.

Customers' walk-around videos only work on Meta. Muse Spark 1.2 watches them (`META_VIDEO_MODEL`), because 1.3 doesn't hear audio well yet, and SAM 3.1 counts what's in them (`META_SAM_MODEL`). SAM bills per frame, so a one-minute video costs up to about $1. Videos go up to 100 MB, so production's nginx needs the larger upload limit in `deploy/nginx-site.conf.example` for that one route.

OpenAI and Anthropic still work by setting `AI_PROVIDER` to `openai` or `anthropic`.

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

Practice photos use OpenAI unless the app runs on Meta, so production on Anthropic still needs an OpenAI key.

**Anthropic** (console.anthropic.com):

1. Create a workspace for each environment.
2. Set the workspace's spend limit.
3. Create an API key inside it.

## Where the keys go

- **Local:** `apps/api/.env`, as `META_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Restart the API and worker after changing them.
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
