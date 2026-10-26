# Quotefolk onboarding prototype

A clickable prototype of the new flow: landing page, the three setup steps (business, past jobs, practice quotes), "Your AI is ready", account creation and "You're live". Everything runs in the browser on mock data. Nothing is sent to a server, and progress is kept in local storage.

## Run it

```sh
npm ci
npm run dev --workspace @quotefolk/prototype
```

Run these from the repository root, then open http://127.0.0.1:3200. It needs Node 24 (see `.nvmrc`).

`npm run build --workspace @quotefolk/prototype` typechecks, builds one self-contained HTML file in `dist/index.html`, and writes `dist/quotefolk-onboarding.html`, the same page in the fragment format used for publishing it as a shareable Artifact.

## What's real and what's mocked

- **Practice customers** answer from fixed fact sheets in `src/data/scenarios.ts`. They reply to questions about size, surface, stains, access, timing, discounts, damage and sealing, and send another photo when asked.
- **The AI's private guess** (`src/lib/learn.ts`) learns a per-square-foot rate and add-on prices from past jobs and earlier practice quotes. It's a stand-in for the real pricing engine described in the plan.
- **Invoice import, Google sign-in, emails and texts** are simulated, and the screens say so.
- **Photos** are crops of generated practice photos from the local dev environment, so every scenario is pressure washing. Other trades show a note about that.
- The **Prototype** menu in the header jumps to any screen and fills in sample answers for skipped steps. **Start over** clears everything.

## Structure

- `src/styles.css`: design tokens (light and dark), type scale and the quote form styles.
- `src/components/`: shared pieces. `QuoteForm.tsx` is the signature quote card.
- `src/screens/`: one file per screen, plus `QuoteBuilder.tsx` and `CustomerDemo.tsx`.
- `src/lib/store.tsx`: app state and the sample data used when jumping ahead.

The components are plain React and Tailwind, so they can move into the real Next.js app in phase 3 of the plan.
