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

From every job and quote with a size, the server works out each service's usual rate: the middle price per unit, with the lowest price the owner has charged as a floor (`src/pricing/rates.ts`). When the request's size is known, the draft gets an estimate for the main work at that rate. With three or more jobs at nearby sizes, a total that lands far from the estimate goes out as a wide range and is flagged for the owner.

## Starting prices from other businesses

A business that has never priced a service can get a starting point from other businesses in the same trade (`src/pricing/market.ts`). Each business's own middle rate counts once, and nothing is used until at least five businesses make up the rate. A quote priced this way goes out as a wide range and is flagged for the owner.

It runs when `MARKET_PRICES=on`, which production has had since 2026-10-31: the Terms and Privacy Policy that allow combined figures went live on 2026-10-30, before any real businesses signed up. WhatsApp chats and owners' tests never count (`src/channels/pooled.ts`).

## Outcomes

Customers see their quote before giving any contact details. They can say yes, ask for a site visit, or say they're not going ahead and why. A yes or a visit asks for their name and a phone number or email, and that's what counts: a tap that never gets that far isn't a yes, and the Charm only learns that a price won from a yes with details. Asking for a copy by email, or leaving details to ask a question, makes the quote a lead too. On the per-quote plan the owner pays for leads, not for quotes someone only looked at, and not twice for the same email or phone number within a week. Three days after a quote goes out, a customer who hasn't answered gets one reminder. Once a quote passes its valid days with no answer, it's marked "no answer". A late yes still counts. The worker does both during maintenance (`src/live/followup.ts`).

The accept button says what the owner chose in Settings. Otherwise each quote gets one of three wordings PriceCharm tries ("Looks good to me", "Works for me", "Let's do it"), kept with the quote (`src/live/accept-wording.ts`). Under it: "No payment now. {Owner} will reach out to book a time." "Accept quote" and "Book it" were dropped on 2026-10-29 because they read like signing something. A quote counts for its wording from when the customer first opens it, and it's a yes if they accept within two weeks. Most quotes get the wording most likely to be best so far (Thompson sampling across all businesses), and 40% get any of the three, so each keeps being tried. Owners' tests and owners' own wordings don't count. Every wording still has to mean yes, because a yes with details bills the quote on the accepted-quote plan and tells the Charm the price won. `npm run metrics` shows how each one is doing, and the `customer_contact_opened` and `customer_contact_given` events show how many people who tap go on to leave their details.

## Knowing when it's ready

Each service earns sending on its own separately (`src/pricing/readiness.ts`). A service is ready once:

- it has three prices with a size, from past jobs, practice or real quotes, so its rate can be held to, and
- at least two of its last three drafts came within 15% of what the owner charged, or within the percent the owner sets in Settings (5% to 30%). Those drafts are practice guesses and real quotes the owner reviewed. A practice customer the owner wanted to see first only counts if the AI would have priced it, and then as a miss.

Two misses among the last three and the service goes back to learning, until it matches them again. Nothing has to switch it back: readiness is worked out again for every quote.

Customers always see a price. A quote only waits for the owner when the owner turned off sending on its own, it's over the owner's limit, the customer asked for them, it isn't a service they offer or is out of scope, or there's no price at all (`HOLDS` in `src/live/chat.ts`). Any other doubt (the AI would rather see it first or isn't sure, the size is unknown or far outside the sizes the owner has priced, or the total is far from similar jobs or the usual rate) sends the quote as a range at its widest, or as an estimate if that's how the owner quotes while it learns. It never goes out as a firm price, and the owner's quote page says why.

At signup, quotes go out on their own only if at least one service is already ready. The owner can still turn sending on or off in Settings, and it only ever applies to ready services.

The Ready page and the Train page list every service with where it stands: the sizes it sends on its own, or what it still needs. A service that's short of sized prices offers "Add a job". Any service that isn't ready offers "Practice one", a practice customer for that service only (`focusSituation` in `src/practice/plan.ts`). That customer goes after what the service still needs: a first job, then a size it hasn't seen, then a usual job to check its guess. Owners can do this from the Ready page before they sign up, up to eight practice customers in all.

Setup asks for past jobs the same way. The main service, and any service with a job, shows three slots: a small one, a usual one and a big one. A job remembers the slot it was added to (`past_jobs.size_slot`). Jobs with no readable size, or sized in a different unit from the service's other jobs, say what to fix, because they don't count toward its rate.

Owners can also drop in old quotes and invoices, as many as they like (`src/job-imports.ts`). Each file is stored as it arrives and read in the background, so they can keep going. The jobs it finds wait on one list, where the owner checks the service, description, price and size and saves them together. A file is deleted as soon as it has been read, because invoices carry customers' names and addresses. Up to 20 files can wait on the list at once, and any left there for a week are cleared.

## Agent readiness

One score, 0 to 100%, for how close the agent is to quoting the owner's work without them (`agentReadiness` in `src/pricing/readiness.ts`). It follows the rule above exactly, so 100% means every service sends on its own:

- Each service's progress is half sized jobs (3 needed) and half close guesses (2 of the last 3 within the owner's percent, 15% unless they change it).
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

Add `--generic` to price each one a second way too: the same model with none of the business's history, which is what a capable AI that doesn't know the owner would charge.

## Proving it

`npm run proof` is the one report marketing quotes. It won't give a percentage from fewer than 20 jobs or videos; below that it gives counts.

```sh
npm run proof --workspace @pricecharm/api                          # drafts owners checked, free
npm run proof --workspace @pricecharm/api -- --replay --limit 20   # against a generic AI, two model calls a job
npm run proof --workspace @pricecharm/api -- --videos ~/sam-bench  # SAM against hand counts, Meta only
```

1. **Drafts owners checked.** Each draft as it was made, before the owner priced the job, against what the owner charged: real quotes the owner reviewed before sending, and the AI's guess on each practice customer. Nothing is re-run, so it's free.
2. **Against a generic AI.** Every job an owner priced, drafted again by their Charm (from only what the business had taught it before that job) and by the same model with none of their prices. Both are held to their best price, so a Charm that would have asked to see the job first still counts with the lines it gave. It says on how many jobs each one came closer to the owner.
3. **Counting from video.** Each video goes through the same measuring as a customer's walk-around. The report compares SAM's count, and Muse Spark's count from watching it, with a hand count. The folder holds the videos and a `counts.json`:

```json
[{ "file": "front-of-house.mp4", "trade": "window cleaning", "service": "Exterior windows", "counts": { "windows": 11 } }]
```

Film these ourselves; customers' videos aren't ours to use for this. Count by hand from the video, each window once.

It lists how many jobs each business adds, with its id. Leave out our own test accounts with `--skip <id,id>`, or look at one business with `--business <id>`. `--json <file>` saves the numbers. On the server, run it from the live release. Give it the shared uploads folder, which PM2 normally passes in, so the replay sees customers' photos:

```sh
cd /srv/quotient-api/current/apps/api
UPLOAD_DIR=/srv/quotient-api/shared/uploads npm run proof:production -- --replay
```

It prints business names and numbers, never customer details.

## The simulated-owner benchmark

Real owners' data takes time to build up. Until it has, `bash scripts/bench.sh` measures the same thing on made-up businesses ([src/bench/owners.ts](../apps/api/src/bench/owners.ts)). Each has its own hidden prices, drawn from what real businesses in its trade charge:

- a rate per window, square foot or foot of gutter (some lower it on big jobs, a few price by size bands);
- a minimum;
- extra for a job in bad shape and for a second story;
- add-ons;
- a discount for two services;
- how they round, and whether they put extras on their own lines.

Each owner goes through setup like a real one: ten past jobs, then setup's six practice customers, answered by their rules. Then each owner's Charm prices new jobs it has never seen, next to the same model with none of the owner's prices, and both are compared with what the owner's rules say.

```sh
bash scripts/bench.sh --owners 30 --tests 6 --curve --json bench.json
```

`--curve` also prices every job from the past jobs alone, to show what practice adds. `--json` saves every owner's rules and every price for a closer look. It runs on a fresh `quoting_bench` database in the local container, with the AI keys in `apps/api/.env`. It costs two model calls a job (three with `--curve`), so a full run is a few hundred. The numbers are about simulated owners and say so wherever they're used; the proof report is the one for real owners.

Working on formula pricing, `--formula-only` skips the Charm's usual draft and the generic AI, for about half the calls. `--json` also keeps every answer the model gave, and `--replay <run.json>` runs again on those answers instead of the model, so a change to how prices are worked out from them is scored for free. A call the saved run never made fails rather than reaching the model; add `--fill` to send just those calls to the model, so only what a change asks anew is paid for. The report lists each kind of call with its failures, so timeouts and the quicker last try at a formula show up.

To see whether a change helped, run the old and new code on the same fresh seed and line the runs up job for job:

```sh
npm run bench:compare --workspace @pricecharm/api -- old.json new.json
```

It counts the jobs the change fixed and broke, with an exact McNemar test on the split, and the owners who came out better or worse. One 30-owner seed moves about 5 points either way by chance, so a single run can't settle a small change; a paired comparison can.

### Trades

`--trades classic`, the default, is window cleaning, pressure washing and gutters, as every run before November 2026 was, so old seeds still compare. `--trades wide` adds nine trades that price their own ways ([src/bench/wide-trades.ts](../apps/api/src/bench/wide-trades.ts), from the research in `research_notes/Benchmark trade prices/`):

- house cleaning by bedrooms and bathrooms, with regular-visit discounts;
- carpet by the room;
- detailing by vehicle size;
- mowing by lot-size band and how often;
- trees by height tier;
- fences by the foot and material;
- junk by share of the truck;
- moving by crew and hour;
- handyman by the task or the hour.

### Measures

Every report and comparison measures prices the same way ([src/bench/metrics.ts](../apps/api/src/bench/metrics.ts)):

- within 10% and 15%;
- median, mean and 90th-percentile miss;
- the share priced high, and the average signed miss;
- the worst miss.

A job with no price counts as a 100% miss. Each measure is reported overall, by trade, by how the owner prices, and by whether the owner's own past jobs and practice quotes showed what the job needed. When they didn't, no pricing could be sure without asking, so those jobs are counted apart from the ones it could have priced right. Ranges come from drawing owners again with replacement, keeping each owner's jobs together.

Formula quotes it doubts go to a real customer as a range. For example, a size far from any the owner priced, a size between two of their prices that jump, a rate far from theirs, or less than anything they've charged. The report shows how close the firm quotes and the ranged ones came, and how many firm quotes were more than 25% or 50% off.

### Deciding

A change is kept when within 10% or the mean miss gets better past what chance would do, measured by owner-resampled ranges on paired jobs or McNemar. Neither can get clearly worse, and no trade, pricing shape or kind of job can get clearly worse. `bench:compare` prints the verdict.

Changes to how prices are worked out from the model's answers are compared on free replays. Changes to what the model is asked are compared on the same fresh seeds, run both ways.

### The sealed test set

Seeds 9001–9100 and three held-out trades are sealed: painting, pest control and pool service, built by someone who never saw the pricing code. Nothing is tuned on them. The benchmark refuses them without `--sealed`, and `--trades sealed` is every trade. Each sealed run is written to `bench-results/sealed-runs.log` with when, what and which code, so it's plain how often the set has been looked at. Run it only at milestones.
