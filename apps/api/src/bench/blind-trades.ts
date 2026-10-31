import type { AddOnRule } from './owners.js';
import { between, pick, whole, type Rng } from './random.js';
import { dollars, hello, plain, type Trade } from './wide-trades.js';

/**
 * The blind practice trades: flooring, HVAC, landscaping and events, each priced the way real
 * businesses in it price, from price pages and cost guides researched on October 31, 2026
 * (research_notes/Benchmark trade prices/blind-flooring-hvac-landscaping-events.md). They were
 * written from that research alone, without looking at the pricing code, so the pricing can be
 * worked on for businesses it wasn't shaped around while the held-out trades stay sealed. Ranges
 * run from budget to premium, so owners differ the way real ones do. Where the research found
 * little, the note on the rule says so.
 */

export type BlindTrade = 'flooring' | 'hvac' | 'landscaping' | 'events';

/** A price ending in 9, in cents, between two dollar amounts that end in 9: $69, $79 ... $189. */
const nines = (rng: Rng, low: number, high: number) =>
  (whole(rng, (low + 1) / 10, (high + 1) / 10) * 10 - 1) * 100;

const REFINISH: Record<string, string> = {
  'natural finish': 'sand and refinish our hardwood floors, clear finish, no stain',
  stained: 'sand and refinish our hardwood floors and stain them a darker color',
  'screen and recoat': 'screen and recoat our hardwood floors, no sanding, just a fresh coat',
};

const SERVING: Record<string, string> = {
  buffet: 'a staffed buffet',
  'drop-off': 'drop-off only, we’ll serve it ourselves',
  'plated dinner': 'a plated, sit-down dinner',
};

export const BLIND: Record<BlindTrade, Trade> = {
  flooring: {
    name: 'Flooring',
    names: [
      'Plank & Grain Flooring',
      'Level Line Floors',
      'Oak Hollow Floor Co',
      'Smooth Step Flooring',
      'Heartpine Floor Works',
      'Board by Board Flooring',
      'Sanded & Sealed Floors',
      'Groundwork Flooring Co',
      'Clickfit Floor Installers',
      'Hearth & Floor Co',
    ],
    words: {
      heavy: 'uneven, with dips and a few soft spots in the subfloor',
      heavyLine: 'Leveling and subfloor repair',
      access: 'broken up by a lot of closets and doorways',
      accessLine: 'Closets and doorways',
      accessSay: 'It’s broken up by a lot of closets and doorways.',
      fine: ['The floor is flat and in decent shape.', 'Nothing unusual about it.', ''],
    },
    rules: (rng, shared) => {
      // Three kinds of shop: all-in (planks, install, demo and cleanup in one rate per sq ft,
      // like Potomac Floors at $6.50), install only (the customer buys the planks), and shops that
      // do both. All-in runs $3–5 budget, $6–8.50 typical, $9–12.50 premium; labor alone
      // $1.50–4.50. Plank grade moves the material, not the labor: entry to premium adds $2–3/sf.
      const kind = pick(rng, ['all-in', 'all-in', 'all-in', 'install', 'install', 'both']);
      const grades = [
        { label: 'mid-range planks', share: 1 },
        { label: 'entry-level planks', share: between(rng, 0.75, 0.88) },
        { label: 'premium planks', share: between(rng, 1.2, 1.45) },
      ];
      // Labor alone is about a quarter to a half of an all-in price (Potomac's own breakdown).
      const own = { label: 'our own planks', share: between(rng, 0.3, 0.5) };
      // Some charge less a foot on big jobs (Big Bro, Thumbtack's pro, Potomac); OC Flooring
      // doesn't.
      const bigJobs = () => (rng() < 0.35 ? { above: 800, share: between(rng, 0.78, 0.92) } : null);
      const vinyl = plain(
        'Vinyl plank',
        'sq ft',
        kind === 'install' ? whole(rng, 150, 400) : whole(rng, 450, 900),
        [200, 1200],
        10,
        {
          height: true,
          volume: bigJobs(),
          options: kind === 'install' ? undefined : kind === 'both' ? [...grades, own] : grades,
        },
      );
      // A full sand and refinish, clear finish: $3–3.99 budget, $4.50–5 typical, about $6 premium.
      // Stain adds $0.50–2/sf, or nothing at shops that include it (Potomac); a screen and recoat
      // is $1–2.50/sf.
      const sand = whole(rng, 300, 600);
      const stain = rng() < 0.15 ? 0 : whole(rng, 50, 200);
      const refinishing = plain('Refinishing', 'sq ft', sand, [200, 1200], 10, {
        volume: bigJobs(),
        options: [
          { label: 'natural finish', share: 1 },
          { label: 'stained', share: 1 + stain / sand },
          { label: 'screen and recoat', share: whole(rng, 100, 250) / sand },
        ],
      });
      // Leveling is a set amount ($250–500 slab leveling, $200–600 gap filling) or a rate per
      // sq ft ($0.50–3), which is a small share of an all-in price and a big one of labor alone.
      const flatFix = rng() < 0.5;
      const install = kind === 'install';
      // Furniture moving and demo come with the price at about half the all-in shops.
      const includesDemo = !install && rng() < 0.5;
      const addOns: AddOnRule[] = [
        {
          // Rate cards: $100–175 a step for vinyl, $55–150 a tread for refinishing.
          label: 'Stairs',
          per: 'item',
          cents: dollars(rng, 55, 175),
          item: { name: 'steps', range: [12, 15], ask: 'There’s also a staircase, {n} steps.' },
        },
        // Trim by the foot ($1–5/LF), or one price for the job ($199–599, NYC Wood Floors).
        rng() < 0.6
          ? {
              label: 'Quarter round',
              per: 'item',
              cents: whole(rng, 100, 300),
              item: {
                name: 'feet',
                range: [60, 200],
                ask: 'We’d like new quarter round too, about {n} feet.',
              },
            }
          : { label: 'Quarter round', per: 'job', cents: dollars(rng, 199, 599) },
      ];
      if (!includesDemo)
        addOns.push(
          { label: 'Carpet removal', per: 'unit', cents: whole(rng, 50, 160) },
          {
            label: 'Furniture moving',
            per: 'item',
            cents: dollars(rng, 25, 75),
            item: {
              name: 'rooms',
              range: [1, 4],
              ask: 'We’d need the furniture moved out of one room.|We’d need the furniture moved out of {n} rooms.',
            },
          },
        );
      return {
        ...shared,
        // Totals are left exact (Big Bro) or rounded to $25 or $50 (Housecall Pro's examples).
        roundTo: pick(rng, [100, 100, 2500, 5000]),
        // No flooring source published a discount for booking two services.
        bundle: 0,
        ownSizes: true,
        services: [vinyl, refinishing],
        // Refinishing minimums run $750 (a recoat) to $2,500 (a full sand); no vinyl shop published
        // one. An owner has one minimum for both, so it's drawn from the low end.
        minimum: dollars(rng, 750, 1500),
        heavy: flatFix ? 0 : install ? between(rng, 0.25, 0.6) : between(rng, 0.08, 0.2),
        heavyFlat: flatFix ? dollars(rng, 200, 500) : undefined,
        // Closets and doorways add 15–25% of the labor (RemodelCo), less of an all-in price. Only
        // one source prices it, so many owners don't charge it. No one charges for upstairs.
        height: rng() < 0.4 ? 0 : install ? between(rng, 0.15, 0.25) : between(rng, 0.05, 0.12),
        addOns,
      };
    },
    ask: (rng, job, _rule, size) => {
      if (job.service === 'Refinishing')
        return `${hello(rng)} Could I get a price to ${REFINISH[job.option ?? 'natural finish']}? It’s about ${size}.`;
      const planks =
        !job.option || job.option === 'our own planks'
          ? 'We already have the planks, we just need them put in.'
          : `We’d like you to supply ${job.option}.`;
      return `${hello(rng)} Looking for a price to install vinyl plank flooring, about ${size}. ${planks}`;
    },
    also: (service, size) =>
      service === 'Refinishing'
        ? `Could you also sand and refinish our hardwood floors, about ${size}, clear finish, no stain?`
        : `Could you also install vinyl plank, about ${size}?`,
  },

  hvac: {
    name: 'HVAC',
    names: [
      'Comfort Coil Heating & Air',
      'Steady Breeze HVAC',
      'Blue Flame Furnace & Air',
      'Clean Vent Air Services',
      'Even Temp Heating & Air',
      'Fresh Duct Air Care',
      'Set Point HVAC',
      'Cool Front Heating & Air',
      'Draft Free Comfort Co',
      'Pilot Light Heating & Air',
    ],
    words: {
      heavy: 'really dirty, nobody has touched it in years',
      heavyLine: 'Heavy buildup',
      access: 'ducts in a cramped attic and crawlspace',
      accessLine: 'Attic and crawlspace',
      accessSay: 'The ductwork runs through a cramped attic and crawlspace.',
      fine: ['It gets serviced most years.', 'Nothing wrong with it, just due.', ''],
    },
    rules: (rng, shared) => {
      // A set price per system, trip included: $59–79 on coupons, $89–129 typical, $150–189 as a
      // regular list price. Most owners charge the same for AC, furnace and heat pump; some
      // differ a little, and oil furnaces cost about twice as much (HB Home, PA: $189 vs $89).
      const sameForAll = rng() < 0.55;
      const tune = nines(rng, 69, 179);
      const tuneUps = plain('Tune-ups', 'units', tune, [1, 3], 1, {
        options: [
          { label: 'AC', share: 1 },
          { label: 'gas furnace', share: sameForAll ? 1 : between(rng, 0.85, 1.05) },
          { label: 'heat pump', share: sameForAll ? 1 : between(rng, 1, 1.15) },
          ...(rng() < 0.2 ? [{ label: 'oil furnace', share: between(rng, 1.5, 2.1) }] : []),
        ],
        // Each system after the first: the same price (American AC, LA) or 60–85% of it
        // (Reliable's old $89.99 / $59.99; HVACR Business's advice). Thin: one firm figure.
        volume: rng() < 0.7 ? { above: 1, share: between(rng, 0.6, 0.85) } : null,
      });
      // Duct cleaning is one price per system with every vent included ($249–799: Air Duct Pros
      // $369, CleanFlow $399, San Antonio $449, Houston $780+), or banded by the home's size:
      // Sonic in Seattle steps 8–15% every 500 sq ft, The Duct Guys has two bands, $295 and $395.
      // Each system past the first adds $100 (Brooksville FL), $149 (Sonic), 73% (Air Duct Pros)
      // or the full price again (CleanFlow).
      const banded = rng() < 0.45;
      const first = banded ? dollars(rng, 295, 600) : nines(rng, 249, 799);
      let step = first;
      const bands = !banded
        ? null
        : rng() < 0.6
          ? [1500, 2000, 2500, 3000, 4000].map((upTo, index) => {
              if (index) step = Math.round(step * between(rng, 1.08, 1.15));
              return { upTo, cents: Math.round(step / 100) * 100 };
            })
          : [
              { upTo: 2500, cents: first },
              { upTo: 5000, cents: Math.round((first * between(rng, 1.25, 1.4)) / 100) * 100 },
            ];
      const ducts = plain('Duct cleaning', 'sq ft', 0, [1000, 3500], 100, {
        once: true,
        height: true,
        bands,
        base: banded ? undefined : first,
        extra: {
          unit: 'units',
          rate: Math.round((first * between(rng, 0.25, 1)) / 100) * 100,
          range: [1, 2],
          included: 1,
        },
      });
      return {
        ...shared,
        roundTo: 100,
        // Nearly every price ends in 9: $89, $129, $369, $449.
        endsIn9: rng() < 0.8,
        // Tune-up and duct cleaning bundles turned up once, unverified.
        bundle: 0,
        services: [tuneUps, ducts],
        // The floor is about a service-call fee ($79–99 in business hours).
        minimum: dollars(rng, 69, 99),
        // Every adder found is a set amount: coil cleaning $100–400 on a tune-up, heavy
        // contamination +$200 and up on ducts. Businesses quote it on site, so this is from guides.
        heavy: 0,
        heavyFlat: rng() < 0.7 ? dollars(rng, 100, 250) : undefined,
        // A cramped attic or crawlspace: +$150–300 on duct cleaning (one general table). No
        // business prices attic or rooftop units for tune-ups.
        height: 0,
        heightFlat: rng() < 0.6 ? dollars(rng, 150, 300) : undefined,
        addOns: [
          // $69–99 added to a duct job, $149–199 on its own.
          { label: 'Dryer vent cleaning', per: 'job', cents: nines(rng, 69, 199) },
          // $80–179 per system.
          { label: 'Sanitizing', per: 'job', cents: nines(rng, 79, 179) },
          // $99 (Sonic) to $150–400 (CleanFlow).
          { label: 'Blower cleaning', per: 'job', cents: nines(rng, 79, 249) },
        ],
        // Plans are two visits a year at $73–138 a visit: below a regular one-off price, at or
        // above a coupon one. PV's plan visit costs more than its $79 tune-up.
        recurring:
          rng() < 0.75
            ? [
                {
                  label: 'twice a year',
                  share: 1 - Math.min(13800, Math.max(7300, tune * between(rng, 0.7, 1.2))) / tune,
                },
              ]
            : undefined,
      };
    },
    ask: (rng, job, _rule, size) => {
      if (job.service === 'Duct cleaning') {
        const units = job.extra ?? 1;
        return `${hello(rng)} How much to clean our air ducts? The house is about ${size}, with ${units} HVAC unit${units === 1 ? '' : 's'}.`;
      }
      const count = Math.round(job.quantity);
      const kind = job.option ?? 'AC';
      return count === 1
        ? `${hello(rng)} Could I get a price on a tune-up for our ${kind}? Just the 1 unit.`
        : `${hello(rng)} Could I get a price on tune-ups for our ${kind === 'AC' ? 'AC units' : `${kind}s`}? We have ${count} units.`;
    },
    also: (service, size) =>
      service === 'Duct cleaning'
        ? `Could you also clean the air ducts for one unit while you’re out? The house is about ${size}.`
        : `Could you also do a tune-up on ${size}?`,
  },

  landscaping: {
    name: 'Landscaping',
    names: [
      'Bark & Bloom Landscapes',
      'Garden Edge Landscaping',
      'Rake & Root Landscaping',
      'Hedgerow Landscape Co',
      'Fieldstone Yard Care',
      'Bramble & Birch Landscaping',
      'Tidy Yard Landscaping',
      'Seasons End Landscape Co',
      'Shovel Ready Landscaping',
      'Fresh Bed Landscaping',
    ],
    words: {
      heavy: 'overgrown, full of weeds and old leaves',
      heavyLine: 'Overgrown',
      access: 'beds on a steep slope',
      accessLine: 'Slope',
      accessSay: 'The beds are on a steep slope.',
      fine: ['The beds are in decent shape.', 'Kept up pretty well.', ''],
    },
    rules: (rng, shared) => {
      // Mulch is priced by the cubic yard, delivered and spread: hardwood $65–75 budget, $85–110
      // typical, $125–145 premium. Dyed costs $10–16 a yard more and cedar $26–36 more, whatever
      // the base; some shops charge one price for every kind (Lawn Panther, On The Block).
      const onePrice = rng() < 0.25;
      const yard = dollars(rng, 60, 140);
      const mulch = plain('Mulch & beds', 'yards', yard, [2, 12], 0.5, {
        once: true,
        height: true,
        options: [
          { label: 'shredded hardwood', share: 1 },
          { label: 'dyed black', share: onePrice ? 1 : 1 + dollars(rng, 10, 16) / yard },
          { label: 'cedar', share: onePrice ? 1 : 1 + dollars(rng, 26, 36) / yard },
        ],
        // Most include delivery; some add a trip ($150 Greener Blade, $75–225 Lawn Thumbs).
        base: rng() < 0.3 ? dollars(rng, 60, 150) : undefined,
        // A few charge less a yard on big jobs (Lowcountry $39 to $34 at 10+); most don't.
        volume: rng() < 0.25 ? { above: 8, share: between(rng, 0.85, 0.92) } : null,
      });
      // Cleanups are by the hour, $55–125 a worker with a crew of two (Syracuse $78, Optimum $87,
      // TLC $75 plus a $125 crew chief), about 3–6 crew hours an acre, or a set price by lot size:
      // under a quarter acre $95–300, then about 1.5–2 times that to half an acre and 2.3–4 times
      // to an acre (Its Done, Plowz).
      const quarter = dollars(rng, 95, 300);
      const cleanup =
        rng() < 0.55
          ? plain('Seasonal cleanup', 'acres', 0, [0.1, 1], 0.05, {
              hourly: {
                who: 'workers',
                crews: [{ upTo: 99, people: 2, rate: 2 * dollars(rng, 55, 110) }],
                hours: { base: between(rng, 0.5, 1), perUnit: between(rng, 3, 6) },
                minimum: pick(rng, [1, 1.5, 2]),
              },
            })
          : plain('Seasonal cleanup', 'acres', 0, [0.1, 1], 0.05, {
              bands: [
                { upTo: 0.25, cents: quarter },
                { upTo: 0.5, cents: Math.round((quarter * between(rng, 1.5, 2)) / 500) * 500 },
                { upTo: 1, cents: Math.round((quarter * between(rng, 2.3, 4)) / 500) * 500 },
              ],
            });
      // Weedy, neglected beds: a set amount (Plowz +$25–75, or an hour or two of weeding at
      // $45–110), or a share for cleanups (wet leaves +40%, overgrown up to double).
      const flatHeavy = rng() < 0.5;
      const addOns: AddOnRule[] = [
        // Edging by the foot ($1.50–3.50 DoorstepHQ, $3–6 Lawn Thumbs) or by the bed (Plowz,
        // from $35).
        rng() < 0.6
          ? {
              label: 'Bed edging',
              per: 'item',
              cents: whole(rng, 150, 400),
              item: {
                name: 'feet',
                range: [40, 150],
                ask: 'We’d like the bed edges recut too, about {n} feet.',
              },
            }
          : {
              label: 'Bed edging',
              per: 'item',
              cents: dollars(rng, 35, 50),
              item: {
                name: 'beds',
                range: [2, 6],
                ask: 'We’d like the edges recut on our {n} beds too.',
              },
            },
        // Plowz from $45 a job; by the yard it's $20–60, about $60–180 for a usual bed refresh.
        { label: 'Old mulch removal', per: 'job', cents: dollars(rng, 45, 150) },
      ];
      // Many include disposal (TLC, Plowz, Its Done); the rest charge $50–100 a load.
      if (rng() < 0.55)
        addOns.push({ label: 'Debris haul-away', per: 'job', cents: dollars(rng, 50, 150) });
      return {
        ...shared,
        roundTo: pick(rng, [100, 500, 500]),
        // Bundling 5% (Mowing Magic) to 15–20% (Ware, general estimates); most publish none.
        bundle: pick(rng, [0, 0, 5, 10, 15]),
        services: [mulch, cleanup],
        // Mulch minimums of 2 yards or $150–300; cleanups $80–199.
        minimum: dollars(rng, 100, 300),
        heavy: flatHeavy ? 0 : between(rng, 0.25, 0.75),
        heavyFlat: flatHeavy ? dollars(rng, 25, 150) : undefined,
        // A slope on mulch: +$15–25 a yard (Lawn Thumbs) or +15–30% of the labor (DoorstepHQ).
        // No source prices it on a cleanup.
        height: rng() < 0.3 ? 0 : between(rng, 0.08, 0.25),
        addOns,
        // Spring and fall: no business page gives a per-visit discount (TLC charges the same);
        // guides say up to 20% off a contract.
        recurring:
          rng() < 0.5 ? [{ label: 'spring and fall', share: between(rng, 0, 0.2) }] : undefined,
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Mulch & beds'
        ? `${hello(rng)} Looking for a price to mulch our beds, about ${size} of ${job.option ?? 'shredded hardwood'} mulch, delivered and spread.`
        : `${hello(rng)} We need a cleanup of the yard and beds, leaves and all. The lot is about ${size}.`,
    also: (service, size) =>
      service === 'Seasonal cleanup'
        ? `Could you also clean up the rest of the yard while you’re there? The lot is about ${size}.`
        : `Could you also mulch the beds, about ${size} of shredded hardwood?`,
  },

  events: {
    name: 'Event services',
    names: [
      'Long Table Catering & Rentals',
      'Backyard Feast Catering',
      'Good Party Catering Co',
      'Folding Chair Events',
      'Gather Round Catering',
      'Full Plate Events',
      'Open Air Party Rentals',
      'Second Helping Catering',
      'Big Picnic Catering & Rentals',
      'Toast & Tablecloth Events',
    ],
    words: {
      // Only one caterer published a rush fee (Chef Juan's, 20% inside five days).
      heavy: 'last minute, the party is only four days away',
      heavyLine: 'Rush fee',
      access: 'up a flight of stairs from the street',
      accessLine: 'Stairs and long carry',
      accessSay: 'Everything has to go up a flight of stairs from the street.',
      fine: ['We have a few weeks to plan.', 'The date is a couple of months out.', ''],
    },
    rules: (rng, shared) => {
      // Catering is priced per guest by how it's served: a staffed buffet $16–25 budget (BBQ,
      // tacos), $27–48 typical, $55+ premium. Most add an 18–20% service charge on the bill and
      // some charge none (Chef Juan's, MileHighCook); there's no way to add a share of the whole
      // job, so it's folded into the price per guest. Drop-off runs 5–15% under a buffet and
      // carries no service charge; plated runs 1.4–2 times a buffet, offered by the pricier ones.
      const charge = rng() < 0.6 ? between(rng, 1.18, 1.2) : 1;
      const food = dollars(rng, 16, 55);
      const catering = plain(
        'Catering',
        'guests',
        Math.round((food * charge) / 100) * 100,
        [20, 150],
        5,
        {
          options: [
            { label: 'buffet', share: 1 },
            { label: 'drop-off', share: between(rng, 0.85, 0.95) / charge },
            ...(food >= 3000 ? [{ label: 'plated dinner', share: between(rng, 1.4, 2) }] : []),
          ],
          // Some charge less a guest for big parties (Cali BBQ: $19 up to 50 guests, $17 past it).
          volume: rng() < 0.35 ? { above: 50, share: between(rng, 0.8, 0.92) } : null,
        },
      );
      // Rentals are a table, chairs and linen per guest: a folding chair $1.95–3.50, an eighth of
      // a 60" round ($10–15) and of its linen ($13.50–18), so $3.25–7 a guest. Resin chairs
      // ($3.50–4.75) and chiavari ($5–10) scale the set.
      const rentals = plain('Rentals', 'guests', whole(rng, 325, 700), [30, 150], 5, {
        height: true,
        options: [
          { label: 'folding chairs', share: 1 },
          { label: 'white resin chairs', share: between(rng, 1.2, 1.45) },
          { label: 'chiavari chairs', share: between(rng, 1.5, 2.3) },
        ],
      });
      const rush = rng();
      return {
        ...shared,
        roundTo: pick(rng, [100, 100, 500]),
        // No catering-and-rentals bundle turned up.
        bundle: 0,
        ownSizes: true,
        services: [catering, rentals],
        // Rental shops' order minimums are $135–150; caterers' run $180–1,400 or 10–30 guests.
        // An owner has one minimum, so it's drawn between, and catering starts at 20 guests.
        minimum: dollars(rng, 150, 600),
        // A rush: 20% (Chef Juan's) or a set $100–150 (DJ Boots' last-minute fee). Thin.
        heavy: rush < 0.4 ? between(rng, 0.15, 0.25) : 0,
        heavyFlat: rush >= 0.4 && rush < 0.6 ? dollars(rng, 100, 150) : undefined,
        // Stairs or a long carry for rentals: $150 at Lounge, the only one with a number;
        // AAA says stairs cost extra.
        height: 0,
        heightFlat: rng() < 0.6 ? dollars(rng, 100, 200) : undefined,
        // Delivery on every order: rental zones $35–75, flat $99–200; caterers $15–150.
        fee: rng() < 0.85 ? { label: 'Delivery', cents: dollars(rng, 25, 200) } : undefined,
        addOns: [
          // A frame tent comes to $7–14 per seated guest (20x20 $295–490 for 32–40 guests,
          // 20x40 $530–840 for 64–80).
          { label: 'Tent rental', per: 'unit', cents: whole(rng, 700, 1400) },
          // China $3.50 a guest (Gary's) to a $9.80 place setting (Taza).
          { label: 'China and silverware', per: 'unit', cents: whole(rng, 350, 1000) },
          // About $1 per table and $0.50 per chair each way (Hill Country), $1–2.50 a guest.
          { label: 'Setup and takedown', per: 'unit', cents: whole(rng, 100, 250) },
          {
            // Servers $35–65 an hour (Everyday Edibles, Las Vegas, Chef Juan's), for four hours.
            label: 'Servers',
            per: 'item',
            cents: 4 * dollars(rng, 35, 65),
            item: {
              name: 'servers',
              range: [1, 4],
              ask: 'We’d like a server for about four hours.|We’d like {n} servers for about four hours.',
            },
          },
        ],
      };
    },
    ask: (rng, job, _rule, size) => {
      const party = pick(rng, [
        'a graduation party',
        'a backyard birthday party',
        'a family reunion',
        'an anniversary party',
      ]);
      return job.service === 'Catering'
        ? `${hello(rng)} Looking for catering for ${party}, ${size}. We’d like ${SERVING[job.option ?? 'buffet']}.`
        : `${hello(rng)} We need tables and ${job.option ?? 'folding chairs'} for ${size}, for ${party}.`;
    },
    also: (service, size) =>
      service === 'Rentals'
        ? `We’d also need tables and folding chairs for ${size}.`
        : `Could you also cater it, ${size}, as a staffed buffet?`,
  },
};
