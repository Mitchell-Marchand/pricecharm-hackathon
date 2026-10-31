import { formatQuantity } from '../pricing/units.js';
import type { AddOnRule, HiddenRules, ServiceRule, SimJob, TradeId, Words } from './owners.js';
import { between, pick, whole, type Rng } from './random.js';

/**
 * The trades the benchmark added in November 2026, each priced the way real businesses in it price,
 * from price pages and cost guides researched on October 31, 2026 (research_notes/Benchmark trade
 * prices): bedrooms and bathrooms, rooms with stairs by the step, vehicle size, lot-size bands and
 * how often the mowing comes, tree height tiers, a rate per foot by material, shares of a truck,
 * crews by the hour, and a menu of set prices. Ranges run from budget to premium, so owners differ
 * the way real ones do. Where the research found little, the note on the rule says so.
 */

export type WideTrade = Exclude<
  TradeId,
  'window-cleaning' | 'pressure-washing' | 'gutters' | 'painting' | 'pest' | 'pools'
>;

/** What every owner draws first, the same way in every trade. */
export type Shared = Pick<HiddenRules, 'roundTo' | 'itemizes' | 'bundle'>;

/** A trade's owners: their names, how their customers talk, how they price, what customers say. */
export type Trade = {
  name: string;
  names: string[];
  words: Words;
  rules: (rng: Rng, shared: Shared) => HiddenRules;
  /** What the customer writes first, with the size as people say it. */
  ask: (rng: Rng, job: SimJob, rule: ServiceRule, size: string) => string;
  /** How they ask for a second service with its own size, when "could you also do X" won't read. */
  also?: (service: string, size: string) => string;
};

export const hello = (rng: Rng) => pick(rng, ['Hi!', 'Hello,', 'Hey there,', 'Hi,']);
export const dollars = (rng: Rng, low: number, high: number) => whole(rng, low, high) * 100;
export const an = (word: string) => (/^[aeiou]/i.test(word) || /^SUV/.test(word) ? 'an' : 'a');

/** A service with a rate per unit and nothing else, for the trades' own rules to build on. */
export const plain = (
  name: string,
  unit: string,
  rate: number,
  sizes: [number, number],
  step: number,
  more: Partial<ServiceRule> = {},
): ServiceRule => ({
  name,
  unit,
  rate,
  sizes,
  step,
  volume: null,
  bands: null,
  height: false,
  ...more,
});

/** Set prices for each size band, each band's price a share of the biggest one's. */
export const bandsOf = (top: number, steps: { upTo: number; share: number }[], round: number) =>
  steps.map(({ upTo, share }) => ({ upTo, cents: Math.round((top * share) / round) * round }));

export const WIDE: Record<WideTrade, Trade> = {
  'house-cleaning': {
    name: 'House cleaning',
    names: [
      'Tidy Nest Cleaning',
      'Fresh Start Home Cleaning',
      'Neat Street Cleaning',
      'Happy Home Cleaners',
      'Sunny Day Cleaning Co',
      'Bright Corners Cleaning',
      'Crisp & Clean Homes',
      'Polished Home Cleaning',
      'Dust Bunny Cleaning',
      'Homeward Clean',
    ],
    words: {
      heavy: 'full of pet hair from our two dogs',
      heavyLine: 'Pet hair',
      access: '',
      accessLine: '',
      fine: ['Pretty tidy, just needs a good clean.', 'Normal amount of mess.', ''],
    },
    rules: (rng, shared) => {
      // Most price a one-bedroom, one-bath home and add for each bedroom and bathroom past it;
      // some raise the step for bigger homes.
      const one = dollars(rng, 110, 200);
      const bed = dollars(rng, 20, 50);
      const bath = dollars(rng, 15, 35);
      const climbing = rng() < 0.3;
      const extra = {
        unit: 'bathrooms',
        rate: bath,
        range: [1, 4] as [number, number],
        included: 1,
      };
      const steps = [
        0,
        bed,
        bed,
        Math.round(bed * between(rng, 1.2, 1.6)),
        Math.round(bed * between(rng, 1.4, 2)),
      ];
      const standard = climbing
        ? plain('Standard clean', 'bedrooms', 0, [1, 5], 1, {
            bands: steps.map((_, index) => ({
              upTo: index + 1,
              cents: one + steps.slice(0, index + 1).reduce((sum, add) => sum + add, 0),
            })),
            extra,
          })
        : plain('Standard clean', 'bedrooms', bed, [1, 5], 1, { base: one - bed, extra });
      // A deep clean is the standard price plus a set amount, or the standard price times more.
      const deep =
        rng() < 0.6
          ? { ...standard, name: 'Deep clean', base: (standard.base ?? 0) + dollars(rng, 50, 150) }
          : (() => {
              const times = between(rng, 1.3, 1.6);
              const scale = (cents: number) => Math.round(cents * times);
              return {
                ...standard,
                name: 'Deep clean',
                rate: scale(standard.rate),
                base: standard.base === undefined ? undefined : scale(standard.base),
                bands:
                  standard.bands?.map((band) => ({ ...band, cents: scale(band.cents) })) ?? null,
                extra: { ...extra, rate: scale(extra.rate) },
              };
            })();
      return {
        ...shared,
        roundTo: pick(rng, [500, 1000, 1000]),
        endsIn9: rng() < 0.3,
        bundle: 0,
        together: false,
        services: [standard, deep],
        minimum: dollars(rng, 115, 210),
        // Pets are a set fee wherever the research found one, never a share.
        heavy: 0,
        heavyFlat: rng() < 0.8 ? dollars(rng, 25, 50) : undefined,
        height: 0,
        addOns: [
          {
            label: 'Interior windows',
            per: 'item',
            cents: dollars(rng, 4, 8),
            item: {
              name: 'windows',
              range: [6, 20],
              ask: 'We’d also like {n} windows washed on the inside.',
            },
          },
          { label: 'Inside the oven', per: 'job', cents: dollars(rng, 25, 45) },
          { label: 'Inside the fridge', per: 'job', cents: dollars(rng, 25, 45) },
        ],
        // 20% off weekly, 15% every other week, 10% monthly is the most common pattern.
        recurring:
          rng() < 0.85
            ? [
                { label: 'every week', share: between(rng, 0.15, 0.2) },
                { label: 'every two weeks', share: between(rng, 0.1, 0.15) },
                { label: 'every month', share: between(rng, 0.05, 0.1) },
              ]
            : undefined,
      };
    },
    ask: (rng, job, rule, size) =>
      `${hello(rng)} Could I get a price on a ${job.service.toLowerCase()}? It's ${size}, ${formatQuantity(job.extra ?? 1, rule.extra?.unit ?? 'bathrooms')}.`,
  },

  carpet: {
    name: 'Carpet cleaning',
    names: [
      'Deep Pile Carpet Care',
      'Fresh Fiber Carpet Cleaning',
      'Steam Team Carpets',
      'Clean Step Carpet Co',
      'Rug Rescue',
      'Soft Floor Carpet Care',
      'True Clean Carpets',
      'Carpet Revival',
      'Plush Carpet Cleaning',
      'Fiber Fresh Cleaners',
    ],
    words: {
      // Rarely priced; one business charged a set upgrade, and most say nothing.
      heavy: 'heavily soiled, the high-traffic spots are dark',
      heavyLine: 'Heavy soil',
      access: '',
      accessLine: '',
      fine: ['Normal wear, nothing major.', 'Just due for a cleaning.', ''],
    },
    rules: (rng, shared) => {
      // A set price per room (up to about 250 sq ft each), or a higher price for the first
      // couple of rooms and less for each one after.
      const perRoom = rng() < 0.6;
      const carpet = perRoom
        ? plain('Carpet', 'rooms', dollars(rng, 40, 80), [1, 8], 1)
        : plain('Carpet', 'rooms', dollars(rng, 75, 105), [1, 8], 1, {
            volume: { above: 2, share: between(rng, 0.45, 0.7) },
          });
      const rugRate = whole(rng, 50, 200);
      const rugs = plain('Area rugs', 'sq ft', rugRate, [24, 150], 1);
      return {
        ...shared,
        roundTo: pick(rng, [100, 500, 500]),
        endsIn9: rng() < 0.4,
        bundle: 0,
        services: [carpet, rugs],
        minimum: dollars(rng, 99, 180),
        heavy: 0,
        heavyFlat: rng() < 0.5 ? dollars(rng, 35, 60) : undefined,
        height: 0,
        addOns: [
          {
            label: 'Stairs',
            per: 'item',
            cents: dollars(rng, 3, 8),
            item: { name: 'steps', range: [12, 15], ask: 'There’s also a staircase, {n} steps.' },
          },
          { label: 'Pet odor treatment', per: 'unit', cents: dollars(rng, 15, 50) },
          { label: 'Sofa cleaning', per: 'job', cents: dollars(rng, 85, 135) },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Carpet'
        ? `${hello(rng)} Looking to get our carpets cleaned, ${size}.`
        : `${hello(rng)} Can you clean an area rug? It's about ${size}.`,
    also: (service, size) =>
      service === 'Area rugs'
        ? `Could you also clean an area rug, about ${size}?`
        : `Could you also do the carpet, ${size}?`,
  },

  detailing: {
    name: 'Auto detailing',
    names: [
      'Mirror Finish Detailing',
      'Glossworks Auto Detail',
      'Road Ready Detailing',
      'Showroom Shine Mobile Detail',
      'Clean Machine Detailing',
      'Polish Pros Auto Spa',
      'Spotless Rides',
      'Detail Doctor',
      'Wax On Mobile Detailing',
      'Fresh Ride Detailing',
    ],
    words: {
      heavy: 'covered in dog hair',
      heavyLine: 'Pet hair removal',
      access: '',
      accessLine: '',
      fine: ['Normal daily-driver dirt.', 'Not too bad, just due.', ''],
    },
    rules: (rng, shared) => {
      // A grid of packages by vehicle size: an SUV 8–29% over a sedan, the biggest 13–50% over.
      const suv = 1 + between(rng, 0.08, 0.29);
      const options = [
        { label: 'sedan', share: 1 },
        { label: 'SUV', share: suv },
        { label: 'pickup truck', share: Math.max(1.13, suv + between(rng, 0.05, 0.21)) },
      ];
      const full = dollars(rng, 150, 350);
      const twoCars = rng() < 0.35 ? { above: 1, share: between(rng, 0.85, 0.95) } : null;
      const service = (name: string, rate: number) =>
        plain(name, 'cars', rate, [1, 1.7], 1, { options, volume: twoCars });
      return {
        ...shared,
        roundTo: 500,
        endsIn9: rng() < 0.5,
        bundle: 0,
        together: false,
        services: [
          service('Full detail', full),
          service('Interior detail', Math.round((full * between(rng, 0.65, 0.85)) / 100) * 100),
        ],
        minimum: dollars(rng, 75, 130),
        // Pet hair is a set fee everywhere the research found it; a few shops charge nothing.
        heavy: 0,
        heavyFlat: rng() < 0.85 ? dollars(rng, 25, 90) : undefined,
        height: 0,
        addOns: [
          { label: 'Headlight restoration', per: 'job', cents: dollars(rng, 60, 120) },
          { label: 'Ozone odor treatment', per: 'job', cents: dollars(rng, 45, 150) },
          { label: 'Engine bay cleaning', per: 'job', cents: dollars(rng, 35, 100) },
        ],
        // A few shops sell maintenance plans well below a one-time detail.
        recurring:
          rng() < 0.4
            ? [
                { label: 'every month', share: between(rng, 0.25, 0.4) },
                { label: 'every three months', share: between(rng, 0.1, 0.2) },
              ]
            : undefined,
      };
    },
    ask: (rng, job) => {
      const option = job.option ?? 'sedan';
      const cars = Math.round(job.quantity);
      const what =
        cars === 1
          ? `my ${option}`
          : `our ${cars} cars, both ${option === 'SUV' ? 'SUVs' : `${option}s`}`;
      return `${hello(rng)} How much for ${an(job.service)} ${job.service.toLowerCase()} on ${what}?`;
    },
  },

  lawn: {
    name: 'Lawn care',
    names: [
      'Green Stripe Lawn Care',
      'Cut Above Mowing',
      'Fresh Cut Lawn Co',
      'Yard Pros Lawn Service',
      'Blade Runners Lawn Care',
      'Green Acres Mowing',
      'Neat Edge Lawn Care',
      'Turf Tamers',
      'Sunday Lawn Co',
      'Grass Masters',
    ],
    words: {
      heavy: 'overgrown, the grass is over a foot tall',
      heavyLine: 'Overgrown',
      access: '',
      accessLine: '',
      fine: ['Normal lawn, kept up.', 'Nothing unusual.', ''],
    },
    rules: (rng, shared) => {
      // Mowing is a set price per visit by lot-size band (the norm), or a base plus a rate per
      // acre for owners who step every thousand square feet. The price is for weekly service.
      const quarter = dollars(rng, 35, 65);
      const banded = rng() < 0.7;
      const mowing = banded
        ? plain('Mowing', 'acres', 0, [0.1, 1.2], 0.05, {
            bands: [
              { upTo: 0.25, cents: quarter },
              { upTo: 0.5, cents: Math.round(quarter * between(rng, 1.15, 1.4)) },
              { upTo: 0.75, cents: Math.round(quarter * between(rng, 1.45, 1.8)) },
              { upTo: 1, cents: Math.round(quarter * between(rng, 1.8, 2.3)) },
              { upTo: 1.5, cents: Math.round(quarter * between(rng, 2.3, 3.2)) },
            ],
          })
        : plain('Mowing', 'acres', dollars(rng, 40, 90), [0.1, 1.2], 0.05, {
            base: dollars(rng, 25, 40),
          });
      const aeration = plain('Aeration', 'acres', dollars(rng, 200, 500), [0.1, 1.2], 0.05, {
        base: dollars(rng, 40, 80),
        once: true,
      });
      return {
        ...shared,
        roundTo: pick(rng, [100, 100, 500]),
        bundle: pick(rng, [0, 0, 0, 5, 10]),
        services: [mowing, aeration],
        minimum: dollars(rng, 30, 55),
        // Mostly a share of the visit (50% to double), sometimes a set amount.
        ...(rng() < 0.7
          ? { heavy: between(rng, 0.4, 1) }
          : { heavy: 0, heavyFlat: dollars(rng, 20, 60) }),
        height: 0,
        addOns: [
          { label: 'Bagging clippings', per: 'job', cents: dollars(rng, 5, 15) },
          { label: 'Overseeding', per: 'unit', cents: dollars(rng, 500, 1100) },
        ],
        // Weekly is the base; every other week costs 12–30% more a visit, a one-time cut ~50% more.
        usually: 'every week',
        recurring: [
          { label: 'every week', share: 0 },
          { label: 'every two weeks', share: -between(rng, 0.12, 0.3) },
          { label: 'one time', share: -between(rng, 0.4, 0.6) },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Mowing'
        ? `${hello(rng)} Looking for mowing on our lot, about ${size}.`
        : `${hello(rng)} Could I get a price to aerate our lawn? The lot is about ${size}.`,
  },

  trees: {
    name: 'Tree service',
    names: [
      'Tall Timber Tree Care',
      'Branch Out Tree Service',
      'Canopy Tree Experts',
      'Oak & Ash Tree Co',
      'Timber Line Tree Service',
      'Rooted Tree Care',
      'High Limb Tree Service',
      'Heartwood Tree Co',
      'Treetop Arborists',
      'Evergreen Tree Pros',
    ],
    words: {
      // Every source says dead trees cost more, almost none says how much.
      heavy: 'dead and leaning',
      heavyLine: 'Dead tree',
      access: 'right next to the house',
      accessLine: 'Near the house',
      accessSay: 'It’s right next to the house.',
      fine: ['Healthy tree, nothing tricky.', 'Open yard, easy to get to.', ''],
    },
    rules: (rng, shared) => {
      // Removal is quoted per tree by height tier (under 30 ft, 30–60, 60–80, 80+), or for some
      // owners by the foot, steeper past 60 ft.
      const small = dollars(rng, 200, 600);
      const medium = Math.round(small * between(rng, 2, 3.2));
      const large = Math.round(medium * between(rng, 1.6, 2.2));
      const removal =
        rng() < 0.6
          ? plain('Removal', 'ft', 0, [15, 90], 5, {
              height: true,
              bands: [
                { upTo: 30, cents: small },
                { upTo: 60, cents: medium },
                { upTo: 80, cents: large },
                { upTo: 120, cents: Math.round(large * between(rng, 1.4, 2)) },
              ],
            })
          : plain('Removal', 'ft', dollars(rng, 12, 25), [15, 90], 5, {
              height: true,
              volume: { above: 60, share: between(rng, 1.3, 1.8) },
            });
      const trimSmall = dollars(rng, 150, 400);
      const trimMedium = Math.round(trimSmall * between(rng, 2, 3));
      const trimming = plain('Trimming', 'ft', 0, [15, 80], 5, {
        height: true,
        bands: [
          { upTo: 30, cents: trimSmall },
          { upTo: 60, cents: trimMedium },
          { upTo: 120, cents: Math.round(trimMedium * between(rng, 1.8, 2.5)) },
        ],
      });
      return {
        ...shared,
        roundTo: pick(rng, [2500, 5000, 5000]),
        bundle: pick(rng, [0, 10, 15, 20]),
        ownSizes: true,
        services: [removal, trimming],
        minimum: dollars(rng, 150, 250),
        heavy: rng() < 0.6 ? between(rng, 0.2, 0.4) : 0,
        // Near the house is a share of the job: 15–50%.
        height: between(rng, 0.15, 0.5),
        addOns: [
          {
            label: 'Stump grinding',
            per: 'item',
            cents: dollars(rng, 100, 250),
            item: {
              name: 'stumps',
              range: [1, 3],
              ask: 'There’s also a stump to grind.|There are also {n} stumps to grind.',
            },
          },
          { label: 'Haul-away', per: 'job', cents: dollars(rng, 75, 250) },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Removal'
        ? `${hello(rng)} We need a tree taken down, about ${size} tall.`
        : `${hello(rng)} Could you trim a tree for us? It's about ${size} tall.`,
    also: (service, size) =>
      service === 'Trimming'
        ? `Could you also trim another tree, about ${size} tall?`
        : `Could you also take down another tree, about ${size} tall?`,
  },

  fencing: {
    name: 'Fencing',
    names: [
      'Straight Line Fence Co',
      'Post & Rail Fencing',
      'Good Neighbor Fence',
      'Picket Pros',
      'Fence Masters',
      'Boundary Fence Co',
      'Sturdy Post Fencing',
      'Yard Line Fence',
      'Cedar & Steel Fence Co',
      'Property Line Fencing',
    ],
    words: {
      heavy: 'on a steep slope',
      heavyLine: 'Slope',
      access: '',
      accessLine: '',
      fine: ['Flat yard, easy digging.', 'Nothing in the way.', ''],
    },
    rules: (rng, shared) => {
      // A rate per foot installed, by material: 6 ft wood privacy as the base, chain link at
      // about half, vinyl above it. Some owners charge less a foot on long runs.
      const wood = dollars(rng, 20, 70);
      const fence = plain('New fence', 'ft', wood, [50, 300], 10, {
        options: [
          { label: 'wood privacy', share: 1 },
          { label: 'chain link', share: between(rng, 0.4, 0.6) },
          { label: 'vinyl', share: between(rng, 1.05, 1.4) },
        ],
        volume: rng() < 0.4 ? { above: 150, share: between(rng, 0.75, 0.9) } : null,
      });
      return {
        ...shared,
        roundTo: pick(rng, [100, 100, 500, 2500]),
        bundle: 0,
        services: [fence, plain('Staining', 'ft', dollars(rng, 4, 12), [50, 300], 10)],
        // No business published one; small jobs "may carry a minimum".
        minimum: dollars(rng, 400, 900),
        // A slope is a share: 8–25%.
        heavy: between(rng, 0.08, 0.25),
        height: 0,
        addOns: [
          {
            label: 'Walk gate',
            per: 'item',
            cents: dollars(rng, 150, 500),
            item: { name: 'gates', range: [1, 2], ask: 'We need a gate too.|We need {n} gates.' },
          },
          { label: 'Old fence removal', per: 'unit', cents: dollars(rng, 3, 8) },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'New fence'
        ? `${hello(rng)} Looking for a price on a new ${job.option ?? 'wood privacy'} fence, about ${size}, 6 feet tall.`
        : `${hello(rng)} How much to stain our fence? It's about ${size}.`,
  },

  junk: {
    name: 'Junk removal',
    names: [
      'Haul Yeah Junk Removal',
      'Junk Be Gone',
      'Clear Out Crew',
      'Load Lifters Junk Hauling',
      'Curbside Haulers',
      'Garage Rescue Junk Removal',
      'Dump Run Pros',
      'Trash Dash Hauling',
      'Clutter Busters',
      'Big Truck Junk Co',
    ],
    words: {
      heavy: 'a lot of heavy stuff, like concrete and dirt',
      heavyLine: 'Heavy materials',
      access: 'all upstairs, on the second floor',
      accessLine: 'Stairs',
      accessSay: 'It’s all upstairs, on the second floor.',
      fine: ['Mostly boxes and old furniture.', 'Normal household stuff.', ''],
    },
    rules: (rng, shared) => {
      // Set prices by how much of the truck it fills, each a share of a full load: an eighth
      // 23–32%, a quarter 32–48%, half 61–68%, three quarters 81–89%. Some price every eighth,
      // others only quarters, so three eighths costs what half does.
      const full = dollars(rng, 450, 1000);
      const shares = {
        eighth: between(rng, 0.23, 0.32),
        quarter: between(rng, 0.32, 0.48),
        half: between(rng, 0.61, 0.68),
        threeQuarters: between(rng, 0.81, 0.89),
      };
      const fine = rng() < 0.5;
      const steps = [
        { upTo: 0.125, share: shares.eighth },
        { upTo: 0.25, share: shares.quarter },
        ...(fine ? [{ upTo: 0.375, share: (shares.quarter + shares.half) / 2 }] : []),
        { upTo: 0.5, share: shares.half },
        ...(fine ? [{ upTo: 0.625, share: (shares.half + shares.threeQuarters) / 2 }] : []),
        { upTo: 0.75, share: shares.threeQuarters },
        ...(fine ? [{ upTo: 0.875, share: (shares.threeQuarters + 1) / 2 }] : []),
        { upTo: 1, share: 1 },
      ];
      const loads = plain('Garage cleanouts', 'loads', 0, [0.125, 1], 0.125, {
        height: true,
        bands: bandsOf(full, steps, 500),
      });
      const items = plain('Single items', 'items', dollars(rng, 60, 130), [1, 4], 1, {
        height: true,
        volume: rng() < 0.6 ? { above: 1, share: between(rng, 0.5, 0.85) } : null,
      });
      const flatHeavy = rng() < 0.6;
      const stairs = rng() < 0.4;
      return {
        ...shared,
        roundTo: pick(rng, [500, 2500]),
        endsIn9: rng() < 0.3,
        bundle: 0,
        together: false,
        services: [loads, items],
        minimum: dollars(rng, 99, 164),
        heavy: flatHeavy ? 0 : between(rng, 0.15, 0.3),
        heavyFlat: flatHeavy ? dollars(rng, 50, 100) : undefined,
        // Most include carrying from anywhere in the home; some charge for stairs.
        height: 0,
        heightFlat: stairs ? dollars(rng, 25, 75) : undefined,
        addOns: [
          {
            label: 'Freon disposal',
            per: 'item',
            cents: dollars(rng, 35, 75),
            item: {
              name: 'fridges',
              range: [1, 2],
              ask: 'One of the things is an old fridge.|There are {n} old fridges or freezers.',
            },
          },
          {
            label: 'Tire disposal',
            per: 'item',
            cents: dollars(rng, 5, 30),
            item: { name: 'tires', range: [2, 6], ask: 'Plus {n} old tires.' },
          },
        ],
      };
    },
    ask: (rng, job, _rule, size) =>
      job.service === 'Garage cleanouts'
        ? `${hello(rng)} We're clearing out the garage. I'd guess it's about ${size}.`
        : `${hello(rng)} Could you haul away ${Math.round(job.quantity) === 1 ? 'one big item, an old couch' : `${Math.round(job.quantity)} big items, old furniture`}?`,
  },

  moving: {
    name: 'Moving',
    names: [
      'Steady Hands Moving',
      'Box & Dolly Movers',
      'Next Door Movers',
      'Heavy Lifters Moving Co',
      'Smooth Move Crew',
      'Hometown Movers',
      'Big Lift Moving',
      'Careful Crew Movers',
      'Packed & Moved',
      'Easy Street Moving',
    ],
    words: {
      heavy: 'a lot of heavy furniture',
      heavyLine: 'Heavy furniture',
      access: 'a third-floor walk-up',
      accessLine: 'Stairs',
      accessSay: 'We’re on the third floor, no elevator.',
      fine: ['Normal amount of stuff.', 'Everything will be boxed up.', ''],
    },
    rules: (rng, shared) => {
      // An hourly rate for the crew, truck included, by crew size: about $50–85 more an hour for
      // each mover added. Hours follow the home's size, never under the owner's minimum.
      const two = dollars(rng, 85, 200);
      const three = two + dollars(rng, 50, 85);
      const four = three + dollars(rng, 50, 90);
      const smallCrew = rng() < 0.5 ? 1 : 2;
      const minimum = pick(rng, [2, 2.5, 3]);
      const moves = plain('Local moves', 'bedrooms', 0, [1, 4], 1, {
        height: true,
        hourly: {
          who: 'movers',
          crews: [
            { upTo: smallCrew, people: 2, rate: two },
            { upTo: 3, people: 3, rate: three },
            { upTo: 99, people: 4, rate: four },
          ],
          hours: { base: between(rng, 1.8, 2.8), perUnit: between(rng, 0.9, 1.5) },
          minimum,
        },
        // Weekends cost $6–25 an hour more for half the owners.
        options:
          rng() < 0.5
            ? [
                { label: 'weekday', share: 1 },
                { label: 'weekend', share: between(rng, 1.05, 1.12) },
              ]
            : undefined,
      });
      const packing = plain('Packing', 'bedrooms', 0, [1, 4], 1, {
        hourly: {
          who: 'packers',
          crews: [{ upTo: 99, people: 2, rate: 2 * dollars(rng, 35, 55) }],
          hours: { base: between(rng, 0.5, 1), perUnit: between(rng, 1, 1.5) },
          minimum: 2,
        },
      });
      const stairsFlat = rng() < 0.5;
      const trip = rng() < 0.6;
      return {
        ...shared,
        roundTo: 100,
        bundle: 0,
        services: [moves, packing],
        minimum: two * minimum,
        heavy: rng() < 0.6 ? between(rng, 0.1, 0.2) : 0,
        // Some charge a set amount for stairs; others bill the extra time.
        height: stairsFlat ? 0 : between(rng, 0.1, 0.2),
        heightFlat: stairsFlat ? dollars(rng, 50, 150) : undefined,
        fee: trip ? { label: 'Trip charge', cents: dollars(rng, 75, 150) } : undefined,
        addOns: [
          {
            label: 'Piano',
            per: 'item',
            cents: dollars(rng, 100, 350),
            item: { name: 'pianos', range: [1, 1], ask: 'We also have an upright piano.' },
          },
          {
            label: 'Bed disassembly',
            per: 'item',
            cents: dollars(rng, 25, 50),
            item: {
              name: 'beds',
              range: [1, 3],
              ask: 'One bed needs taking apart and putting back together.|{n} beds need taking apart and putting back together.',
            },
          },
        ],
      };
    },
    ask: (rng, job, _rule, size) => {
      const when =
        job.option === 'weekend'
          ? ' We’d want to move on a weekend.'
          : job.option === 'weekday'
            ? ' A weekday works for us.'
            : '';
      return job.service === 'Local moves'
        ? `${hello(rng)} We're moving out of a ${size.replace(/s$/, '')} place, staying in town.${when}`
        : `${hello(rng)} Could you pack up our ${size.replace(/s$/, '')} place before a move?`;
    },
  },

  handyman: {
    name: 'Handyman',
    names: [
      'Fix It Right Handyman',
      'Honey Do Pros',
      'Handy Hands Home Repair',
      'Toolbelt Handyman Co',
      'Odd Jobs Plus',
      'Level & Plumb Handyman',
      'Fixit Home Services',
      'Small Jobs Handyman',
      'Hammer Time Repairs',
      'Punch List Pros',
    ],
    words: {
      heavy: 'old plaster walls, not drywall',
      heavyLine: 'Plaster walls',
      access: 'high ceilings, about 12 feet',
      accessLine: 'High ceilings',
      accessSay: 'The ceilings are high, about 12 feet.',
      fine: ['Pretty standard.', 'Nothing unusual.', ''],
    },
    rules: (rng, shared) => {
      // A menu of set prices (the first TV or patch, less for each after), or by the hour with a
      // minimum. Hourly owners bill the extra time for hard jobs; menu owners add a set amount.
      const menu = rng() < 0.55;
      const rate = dollars(rng, 50, 125);
      const hourly = (perUnit: [number, number]) => ({
        who: 'handyman',
        crews: [{ upTo: 99, people: 1, rate }],
        hours: { base: 0.5, perUnit: between(rng, perUnit[0], perUnit[1]) },
        minimum: pick(rng, [1, 1.5, 2]),
      });
      const tv = menu
        ? plain('TV mounting', 'items', dollars(rng, 100, 225), [1, 3], 1, {
            height: true,
            volume: { above: 1, share: between(rng, 0.6, 0.9) },
          })
        : plain('TV mounting', 'items', 0, [1, 3], 1, {
            height: true,
            hourly: hourly([0.75, 1.25]),
          });
      const drywall = menu
        ? plain('Drywall', 'items', dollars(rng, 120, 275), [1, 4], 1, {
            height: true,
            volume: { above: 1, share: between(rng, 0.3, 0.6) },
          })
        : plain('Drywall', 'items', 0, [1, 4], 1, { height: true, hourly: hourly([0.5, 0.8]) });
      return {
        ...shared,
        roundTo: menu ? 500 : 100,
        endsIn9: menu && rng() < 0.5,
        bundle: 0,
        ownSizes: true,
        services: [tv, drywall],
        minimum: dollars(rng, 75, 200),
        heavy: menu ? 0 : between(rng, 0.15, 0.3),
        heavyFlat: menu ? dollars(rng, 40, 75) : undefined,
        height: menu ? 0 : between(rng, 0.15, 0.3),
        heightFlat: menu ? dollars(rng, 25, 75) : undefined,
        fee: rng() < 0.4 ? { label: 'Trip fee', cents: dollars(rng, 30, 80) } : undefined,
        addOns: [
          { label: 'In-wall cord hiding', per: 'unit', cents: dollars(rng, 60, 100) },
          { label: 'Paint touch-up', per: 'job', cents: dollars(rng, 40, 80) },
        ],
      };
    },
    ask: (rng, job) => {
      const count = Math.round(job.quantity);
      return job.service === 'TV mounting'
        ? `${hello(rng)} Could you mount ${count === 1 ? 'a TV' : `${count} TVs`} for us?`
        : `${hello(rng)} I have ${count === 1 ? 'a hole' : `${count} holes`} in the drywall to patch.`;
    },
    also: (service, size) => {
      const count = Number.parseInt(size, 10) || 1;
      return service === 'Drywall'
        ? `And patch ${count === 1 ? 'a hole' : `${count} holes`} in the drywall while you're here.`
        : `And mount ${count === 1 ? 'a TV' : `${count} TVs`} while you're here.`;
    },
  },
};

/** Unused here, kept so an add-on rule written in this file is checked against the shape. */
export type { AddOnRule };
