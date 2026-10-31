import type { Trade } from './wide-trades.js';
import { dollars, hello, plain } from './wide-trades.js';
import { between, pick, whole, type Rng } from './random.js';

/**
 * The held-out trades: interior and exterior painting, pest control and mosquito spraying, and
 * weekly pool service with openings and closings. They were priced the way real businesses price,
 * from price pages and cost guides researched on October 31, 2026 (research_notes/Benchmark trade
 * prices/held-out-painting-pest-pools.md), by someone who never saw the pricing code:
 * - painting: rooms with what's painted in them, high ceilings, a painter's hours, and a rate per
 *   square foot of house that goes up for a second story;
 * - pest control: per-visit prices by home-size band, how often the visits come, a start-up visit,
 *   and mosquito sprays by lot size;
 * - pools: a monthly rate by pool-size band, chemicals only or full service, and openings and
 *   closings by pool type and cover.
 * Ranges run from budget to premium. Where the research found little, the note on the rule says
 * so.
 */

export type HeldOutTrade = 'painting' | 'pest' | 'pools';

/** One price up to the first size, then the same step more for each band past it, up to 5,000. */
const steps = (first: number, width: number, price: number, step: number) =>
  Array.from({ length: Math.ceil((5000 - first) / width) + 1 }, (_, index) => ({
    upTo: first + width * index,
    cents: price + step * index,
  }));

/** Mosquito spray prices by lot size, each a share of the smallest lot's price. */
const lotBands = (rng: Rng, spray: number) =>
  rng() < 0.4
    ? // One price up to half an acre, like most local mosquito programs.
      [
        { upTo: 0.5, cents: spray },
        { upTo: 0.75, cents: Math.round(spray * between(rng, 1.25, 1.5)) },
        { upTo: 1, cents: Math.round(spray * between(rng, 1.55, 2)) },
      ]
    : // A price for every quarter acre: about 2.35× from the smallest lot to an acre.
      [
        { upTo: 0.25, cents: spray },
        { upTo: 0.5, cents: Math.round(spray * between(rng, 1.15, 1.35)) },
        { upTo: 0.75, cents: Math.round(spray * between(rng, 1.5, 1.8)) },
        { upTo: 1, cents: Math.round(spray * between(rng, 1.9, 2.4)) },
      ];

const POOL_WORDS: Record<string, string> = {
  'inground, safety cover': 'an inground pool with a safety cover',
  'inground, tarp and water bags': 'an inground pool with a solid tarp and water bags',
  'above-ground': 'an above-ground pool',
};

export const HELD_OUT: Record<HeldOutTrade, Trade> = {
  painting: {
    name: 'Painting',
    names: [
      'Brush & Roller Painting Co',
      'True Line Painters',
      'Even Coat Painting',
      'Cut In Painting Co',
      'Drop Cloth Painters',
      'Fine Edge House Painting',
      'Steady Brush Painting',
      'Primer & Finish Co',
      'Eggshell Painting Co',
      'Open House Painters',
    ],
    words: {
      // Heavy prep is a share of the job almost everywhere: 20–50%, "over 60%" for bad exteriors.
      heavy: 'peeling and cracked in spots, so it needs a lot of prep',
      heavyLine: 'Extra prep',
      // Wall prices assume 8-foot ceilings; 12-foot walls add 20–50%.
      access: '12-foot ceilings',
      accessLine: 'High ceilings',
      accessSay: 'The ceilings are tall, about 12 feet.',
      fine: [
        'Paint’s in decent shape, just tired.',
        'Nothing peeling, just due for fresh paint.',
        '',
      ],
    },
    rules: (rng, shared) => {
      // Interior is priced per bedroom-size room: the walls, two coats, paint and standard prep
      // included, $250–600. Trim and ceilings are their own lines on the price pages; against
      // the walls, baseboards and a door add 17–37% and a ceiling 20–58% more. A few small
      // painters bill a painter's hours instead, about $35–75 an hour each, paint folded in.
      const trim = between(rng, 1.2, 1.4);
      const options = [
        { label: 'walls only', share: 1 },
        { label: 'walls and trim', share: trim },
        { label: 'walls, trim and ceilings', share: trim + between(rng, 0.25, 0.6) },
      ];
      const crew = rng() < 0.5 ? 1 : 2;
      const interior =
        rng() < 0.2
          ? plain('Interior', 'rooms', 0, [1, 8], 1, {
              height: true,
              options,
              hourly: {
                who: crew === 1 ? 'painter' : 'painters',
                crews: [{ upTo: 99, people: crew, rate: crew * dollars(rng, 35, 75) }],
                // About 150 sq ft an hour on 350–400 sq ft of wall, two coats, plus cutting in.
                hours: {
                  base: between(rng, 1, 2),
                  perUnit: crew === 1 ? between(rng, 5, 7) : between(rng, 2.5, 3.5),
                },
                minimum: pick(rng, [2, 3, 4]),
              },
            })
          : plain('Interior', 'rooms', dollars(rng, 250, 600), [1, 8], 1, {
              height: true,
              options,
              // Each room past the first few 10–20% cheaper, from the price by room count.
              volume: rng() < 0.35 ? { above: 3, share: between(rng, 0.8, 0.92) } : null,
            });
      // Exterior is priced by the house's square feet, trim and siding, prep and paint included:
      // $1.25–5 a square foot for one story. A second story costs 20–55% more. Siding material
      // matters too, but the sources disagree on which costs more, so it's left out.
      const perFoot = whole(rng, 125, 500);
      const style = rng();
      const exterior = plain('Exterior', 'sq ft', perFoot, [1000, 3500], 100, {
        options: [
          { label: 'one-story', share: 1 },
          { label: 'two-story', share: between(rng, 1.2, 1.55) },
        ],
        // Some bid by house size; some charge less a foot on big houses.
        volume: style < 0.2 ? { above: 2500, share: between(rng, 0.8, 0.92) } : null,
        bands:
          style > 0.75
            ? [1500, 2000, 2500, 3000, 4000].map((upTo) => ({
                upTo,
                cents: Math.round((perFoot * upTo * between(rng, 0.85, 1)) / 5000) * 5000,
              }))
            : null,
      });
      const flatPrep = rng() < 0.2;
      return {
        ...shared,
        // Line items in $5–25 steps, bids in $50s; no painter's price ended in 9.
        roundTo: pick(rng, [500, 1000, 2500, 2500, 5000]),
        services: [interior, exterior],
        // Project minimums run from $150 for small painters to $950–1,200 for the bigger firms.
        minimum: pick(rng, [150, 250, 300, 400, 500, 500, 950, 1000, 1200]) * 100,
        heavy: flatPrep ? 0 : between(rng, 0.15, 0.45),
        heavyFlat: flatPrep ? dollars(rng, 100, 300) : undefined,
        height: between(rng, 0.2, 0.5),
        addOns: [
          {
            // Doors and frames: $40–120 inside, more for a front door; one price per owner.
            label: 'Doors',
            per: 'item',
            cents: dollars(rng, 50, 150),
            item: {
              name: 'doors',
              range: [1, 4],
              ask: 'There’s also a door to paint.|There are also {n} doors to paint.',
            },
          },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Interior'
        ? `${hello(rng)} Could I get a price to paint ${size} inside, ${job.option ?? 'walls only'}? They’re normal bedroom-size rooms.${job.twoStory ? '' : ' Regular-height ceilings.'}`
        : `${hello(rng)} Looking for a price to paint the outside of our house. It’s ${job.option === 'two-story' ? 'a two-story' : 'a one-story'} house, about ${size}.`,
    // A second exterior is always priced at one story, so the customer says so.
    also: (service, size) =>
      service === 'Exterior'
        ? `Could you also paint the outside? It’s a one-story house, about ${size}.`
        : `Could you also paint ${size} inside, walls only?`,
  },

  pest: {
    name: 'Pest control',
    names: [
      'Porch Light Pest Control',
      'Quiet Home Pest Control',
      'Barrier Line Pest Co',
      'Sweetgrass Pest Control',
      'Tight Seal Pest Control',
      'Hollow Creek Pest Services',
      'Front Step Pest Control',
      'Fieldstone Pest Control',
      'Back Porch Pest & Mosquito',
      'Screen Door Pest Control',
    ],
    words: {
      // Nobody publishes a surcharge for a bad infestation; most quote it case by case.
      heavy: 'a bad infestation, we see bugs every day',
      heavyLine: 'Heavy infestation',
      access: '',
      accessLine: '',
      fine: [
        'Nothing major, we just want to stay ahead of it.',
        'Normal amount of bugs for around here.',
        '',
      ],
    },
    rules: (rng, shared) => {
      // General pest is priced per visit by the home's square feet: one price up to 2,000–3,000
      // sq ft, then $5–30 more for each 500–2,000 sq ft past it. A quarterly visit at the
      // smallest size runs $65–175.
      const visit = dollars(rng, 65, 175);
      const first = pick(rng, [2000, 2500, 3000]);
      const width = pick(rng, [500, 1000, 1000, 2000]);
      const general = plain('General pests', 'sq ft', 0, [1200, 4500], 100, {
        bands: steps(first, width, visit, dollars(rng, 5, 30)),
      });
      // Mosquito spray is priced per treatment by lot size, every three weeks through the
      // season: $45–100 for the smallest lot. A one-time spray before an event costs 1.3–2.5×
      // a program visit. It runs on its own schedule, not the house plan's visits.
      const spray = dollars(rng, 45, 100);
      const mosquitoes = plain('Mosquitoes', 'acres', 0, [0.1, 1], 0.05, {
        once: true,
        bands: lotBands(rng, spray),
        options: [
          { label: 'every three weeks', share: 1 },
          { label: 'one-time spray', share: between(rng, 1.3, 2.5) },
        ],
      });
      // A monthly visit runs $40–80 whatever the quarterly price (Corpus Christi $60 against
      // $65, NEARPEST $79 against $135); every two months falls between (67–78% of quarterly).
      // One time, without a plan, is 1.1–2.4× a plan visit.
      const month = Math.min(0.6, Math.max(0.08, 1 - dollars(rng, 40, 80) / visit));
      const twoMonths = month * between(rng, 0.45, 0.8);
      const startUp = rng() < 0.6;
      return {
        ...shared,
        roundTo: pick(rng, [100, 500, 500]),
        // $49, $99, $149, $249 are everywhere; the rest end in 5 or 0.
        endsIn9: rng() < 0.45,
        services: [general, mosquitoes],
        // No one posts a minimum; the smallest size band is the floor.
        minimum: Math.min(dollars(rng, 45, 95), spray),
        heavy: rng() < 0.65 ? between(rng, 0.2, 0.5) : 0,
        height: 0,
        usually: 'every three months',
        recurring: [
          { label: 'every three months', share: 0 },
          { label: 'every two months', share: twoMonths },
          { label: 'every month', share: month },
          // Plan-only owners start every customer with an initial visit and don't do one-offs.
          ...(startUp ? [] : [{ label: 'one time', share: -between(rng, 0.1, 1.4) }]),
        ],
        // The initial visit is 0.7–1.8× a plan visit ($75–300), the same at every size here,
        // though some owners step it with the house.
        fee: startUp
          ? {
              label: 'Initial service',
              cents: Math.max(7500, Math.round((visit * between(rng, 0.7, 1.8)) / 500) * 500),
            }
          : undefined,
        addOns: [
          {
            // $50 a nest past the first at one owner, $50–150 as an add-on; some include them.
            label: 'Wasp nests',
            per: 'item',
            cents: dollars(rng, 50, 150),
            item: {
              name: 'nests',
              range: [1, 3],
              ask: 'There’s also a wasp nest by the back door.|There are also {n} wasp nests around the house.',
            },
          },
          {
            // $15–27 a station set out, some charging a fill fee on top; thin data.
            label: 'Rodent bait stations',
            per: 'item',
            cents: dollars(rng, 15, 40),
            item: {
              name: 'stations',
              range: [2, 6],
              ask: 'We’d also like {n} rodent bait stations around the outside.',
            },
          },
          { label: 'Flea and tick yard treatment', per: 'job', cents: dollars(rng, 75, 180) },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'General pests'
        ? `${hello(rng)} Could I get a price on pest control for our house? It’s about ${size}.`
        : job.option === 'one-time spray'
          ? `${hello(rng)} Could you spray our yard for mosquitoes once, before a party? The lot is about ${size}.`
          : `${hello(rng)} We’d like our yard sprayed for mosquitoes every three weeks this season. The lot is about ${size}.`,
    // A second mosquito service is always priced as the three-week program.
    also: (service, size) =>
      service === 'Mosquitoes'
        ? `Could you also spray the yard for mosquitoes every three weeks? The lot is about ${size}.`
        : `Could you also do pest control for the house? It’s about ${size}.`,
  },

  pools: {
    name: 'Pool service',
    names: [
      'Deep End Pool Care',
      'Cannonball Pool Service',
      'Cool Deck Pool Service',
      'Backstroke Pool Care',
      'Waterline Pool Service',
      'Sunny Splash Pool Care',
      'Lane Line Pools',
      'Shallow End Pool Co',
      'Pool Day Service Co',
      'Steady Tide Pool Care',
    ],
    words: {
      // Heavy trees add $10–30 a month or 20–30%; a debris fee at opening runs about $100.
      heavy: 'full of leaves, with big trees hanging over it',
      heavyLine: 'Heavy debris',
      access: '',
      accessLine: '',
      fine: ['Water’s clear, it’s been kept up.', 'Normal backyard pool.', ''],
    },
    rules: (rng, shared) => {
      // Weekly service is a flat monthly rate, $80–280 for a standard pool, by pool-size band:
      // most step up once or twice past 15,000–25,000 gallons, some only past 28,000 (20%).
      const month = dollars(rng, 80, 280);
      const first = pick(rng, [15000, 20000, 20000, 25000]);
      const next = between(rng, 1.1, 1.3);
      const bands =
        rng() < 0.7
          ? [
              { upTo: first, cents: month },
              { upTo: first + 10000, cents: Math.round(month * next) },
              { upTo: 40000, cents: Math.round(month * (next + between(rng, 0.1, 0.3))) },
            ]
          : [
              { upTo: 28000, cents: month },
              { upTo: 40000, cents: Math.round(month * between(rng, 1.15, 1.25)) },
            ];
      const weekly = plain('Weekly service', 'gallons', 0, [8000, 35000], 1000, {
        bands,
        // Chemicals only, with no cleaning, costs 55–80% of full service where it's offered.
        options:
          rng() < 0.6
            ? [
                { label: 'full service', share: 1 },
                { label: 'chemicals only', share: between(rng, 0.55, 0.8) },
              ]
            : undefined,
      });
      // An opening or a closing, each a set price: $250–650 inground with a safety cover. A
      // tarp with water bags costs 7–35% more, and above-ground 65–95% of inground. Some
      // take 10–30% off the second visit when both are booked.
      const openings = plain('Openings & closings', 'visits', dollars(rng, 250, 650), [1, 2], 1, {
        once: true,
        volume: rng() < 0.4 ? { above: 1, share: between(rng, 0.7, 0.9) } : null,
        options: [
          { label: 'inground, safety cover', share: 1 },
          { label: 'inground, tarp and water bags', share: between(rng, 1.07, 1.35) },
          { label: 'above-ground', share: between(rng, 0.65, 0.95) },
        ],
      });
      return {
        ...shared,
        // Monthly rates end in 0 or 5; a few owners end in 9.
        roundTo: pick(rng, [500, 500, 1000, 2500]),
        endsIn9: rng() < 0.2,
        // Package deals are mostly on openings and closings themselves; thin data past that.
        bundle: pick(rng, [0, 0, 0, 5, 10]),
        services: [weekly, openings],
        // No one posts one; "starting at" prices act as the floor.
        minimum: Math.min(dollars(rng, 50, 120), Math.round(month * 0.6)),
        heavy: rng() < 0.75 ? between(rng, 0.15, 0.35) : 0,
        height: 0,
        // Every two weeks costs 20–38% less a month; some owners only come weekly.
        usually: 'every week',
        recurring:
          rng() < 0.6
            ? [
                { label: 'every week', share: 0 },
                { label: 'every two weeks', share: between(rng, 0.2, 0.38) },
              ]
            : [{ label: 'every week', share: 0 }],
        addOns: [
          {
            // +$10–50 a month on weekly service, $20–75 at most openings.
            label: 'Attached spa',
            per: 'item',
            cents: dollars(rng, 20, 60),
            item: { name: 'spas', range: [1, 1], ask: 'There’s an attached spa too.' },
          },
          // $55–150 a cleaning; the trade's average is about $111.
          { label: 'Filter cleaning', per: 'job', cents: dollars(rng, 55, 150) },
          // $35–100, about $67 on average.
          { label: 'Salt cell cleaning', per: 'job', cents: dollars(rng, 35, 100) },
        ],
      };
    },
    ask: (rng, job, _rule, size) => {
      if (job.service === 'Weekly service') {
        const what =
          job.option === 'chemicals only'
            ? 'just chemicals and a water check'
            : job.option === 'full service'
              ? 'full service, cleaning and chemicals'
              : 'cleaning and chemicals';
        return `${hello(rng)} Looking for regular pool service, ${what}. Our pool is about ${size}.`;
      }
      const pool = POOL_WORDS[job.option ?? 'inground, safety cover'];
      return Math.round(job.quantity) === 1
        ? `${hello(rng)} Could I get a price to ${pick(rng, ['open our pool for the summer', 'close our pool for the winter'])}? It’s ${pool}.`
        : `${hello(rng)} We need our pool opened in the spring and closed in the fall, so two visits. It’s ${pool}.`;
    },
    // Openings booked with weekly service are always priced as inground with a safety cover.
    also: (service, size) => {
      if (service !== 'Openings & closings')
        return `Could you also take on weekly service? The pool is about ${size}.`;
      return (Number.parseInt(size, 10) || 1) === 1
        ? 'Could you also close it for the winter? It’s inground, with a safety cover.'
        : 'Could you also open it in the spring and close it in the fall? It’s inground, with a safety cover.';
    },
  },
};
