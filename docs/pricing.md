# How PriceCharm prices a job

Each business's AI prices from that business's own history. The server does the math and checks every draft before it goes anywhere.

## What it learns from

| Source | Where it comes from | What it adds |
| --- | --- | --- |
| Past jobs | Setup and the Train page, typed in or read from an old invoice | Prices for real jobs, with size, materials and discounts |
| Practice | Pretend customers during setup and on the Train page | Which questions the owner asks, how they write line items, and when they want to see a job first |
| Real quotes | Every quote the owner reviewed, plus any a customer answered | The owner's current prices, every change they made to the AI's draft, and how the customer answered |
| Corrections | Lines the owner edits under "What your AI picked up" | Rules in the owner's own words |

A quote the AI sent on its own only counts once the customer accepts it or turns it down, so the AI doesn't learn from its own unchecked guesses.

When a history passes 50 examples, the draft gets the ones most like the request: the same service first, then the closest size, then the most recent.

## Sizes and rates

The customer chat records each job as fields: size and unit, condition, access, add-ons and timing (`lead_chats.spec_json`). Past jobs and practice customers get their size read from what was written, like "about 900 sq ft" or "24 windows" (`src/pricing/units.ts`).

From every job and quote with a size, the server works out each service's usual rate: the middle price per unit, with the lowest price the owner has charged as a floor (`src/pricing/rates.ts`). When the request's size is known, the draft gets an estimate for the main work at that rate. With three or more jobs at nearby sizes, a total that lands far from the estimate goes to the owner instead of the customer.

## Starting prices from other businesses

A business that has never priced a service can get a starting point from other businesses in the same trade (`src/pricing/market.ts`). Each business's own middle rate counts once, and nothing is used until at least five businesses make up the rate. A quote priced this way always waits for the owner.

This is off unless `MARKET_PRICES=on`. Turn it on only once the Terms and Privacy Policy that allow combined figures are live, and after any existing businesses have had the 30 days' notice the Terms promise.

## Outcomes

Customers see their quote before giving any contact details. They can say yes, ask for a site visit, or say they're not going ahead and why. A yes or a visit asks for their name and a phone number or email, and that's what counts: a tap that never gets that far isn't a yes, and the Charm only learns that a price won from a yes with details. Asking for a copy by email, or leaving details to ask a question, makes the quote a lead too. On the per-quote plan the owner pays for leads, not for quotes someone only looked at, and not twice for the same email or phone number within a week. Three days after a quote goes out, a customer who hasn't answered gets one reminder. Once a quote passes its valid days with no answer, it's marked "no answer". A late yes still counts. The worker does both during maintenance (`src/live/followup.ts`).

The accept button says what the owner chose in Settings. Otherwise each quote gets one of three wordings PriceCharm tries ("Looks good to me", "Works for me", "Let's do it"), kept with the quote (`src/live/accept-wording.ts`). Under it: "No payment now. {Owner} will reach out to book a time." "Accept quote" and "Book it" were dropped on 2026-10-29 because they read like signing something. A quote counts for its wording from when the customer first opens it, and it's a yes if they accept within two weeks. Most quotes get the wording most likely to be best so far (Thompson sampling across all businesses), and 40% get any of the three, so each keeps being tried. Owners' tests and owners' own wordings don't count. Every wording still has to mean yes, because a yes with details bills the quote on the accepted-quote plan and tells the Charm the price won. `npm run metrics` shows how each one is doing, and the `customer_contact_opened` and `customer_contact_given` events show how many people who tap go on to leave their details.

## Knowing when it's ready

Each service earns sending on its own separately (`src/pricing/readiness.ts`). A service is ready once:

- it has three prices with a size, from past jobs, practice or real quotes, so its rate can be held to, and
- at least two of its last three drafts came within 15% of what the owner charged. Those drafts are practice guesses and real quotes the owner reviewed. A practice customer the owner wanted to see first only counts if the AI would have priced it, and then as a miss.

Two misses among the last three and the service goes back to waiting for the owner, until it matches them again. Nothing has to switch it back: readiness is worked out again for every quote.

Even for a ready service, a quote waits when the size is unknown, or far outside the sizes the owner has priced (under half the smallest, or over one and a half times the largest).

At signup, quotes go out on their own only if at least one service is already ready. The owner can still turn sending on or off in Settings, and it only ever applies to ready services.

The Ready page and the Train page list every service with where it stands: the sizes it sends on its own, or what it still needs. A service that's short of sized prices offers "Add a job". Any service that isn't ready offers "Practice one", a practice customer for that service only (`focusSituation` in `src/practice/plan.ts`). That customer goes after what the service still needs: a first job, then a size it hasn't seen, then a usual job to check its guess. Owners can do this from the Ready page before they sign up, up to eight practice customers in all.

Setup asks for past jobs the same way. The main service, and any service with a job, shows three slots: a small one, a usual one and a big one. A job remembers the slot it was added to (`past_jobs.size_slot`). Jobs with no readable size, or sized in a different unit from the service's other jobs, say what to fix, because they don't count toward its rate.

Owners can also drop in old quotes and invoices, as many as they like (`src/job-imports.ts`). Each file is stored as it arrives and read in the background, so they can keep going. The jobs it finds wait on one list, where the owner checks the service, description, price and size and saves them together. A file is deleted as soon as it has been read, because invoices carry customers' names and addresses. Up to 20 files can wait on the list at once, and any left there for a week are cleared.

## Agent readiness

One score, 0 to 100%, for how close the agent is to quoting the owner's work without them (`agentReadiness` in `src/pricing/readiness.ts`). It follows the rule above exactly, so 100% means every service sends on its own:

- Each service's progress is half sized jobs (3 needed) and half close guesses (2 of the last 3 within 15%).
- Services are weighted by how often they come up: one for being offered, plus each past job and each real request in the last 90 days. A service they rarely do barely moves it.
- It also names the one step that would raise it most, "Add a House wash job with its size" or "Practice a Driveways job", and by how much.

It shows on the Ready screen, the deploy step, the dashboard and the Train page. It never blocks going live.

## Choosing the model

Each quote records the provider, model and prompt version that drafted it (`live_quotes.engine_json`). Drafting can use a stronger model than the chat with `OPENAI_DRAFT_MODEL` or `ANTHROPIC_DRAFT_MODEL`.

To compare models, replay quotes owners already priced. Each one is drafted from only what the business had taught it before that quote:

```sh
npm run replay --workspace @pricecharm/api -- --model gpt-5 --limit 20
```

It calls the model once per quote, so it costs money. With `AI_PROVIDER=demo` it measures the rate card alone, for free, which is the baseline a model has to beat.
