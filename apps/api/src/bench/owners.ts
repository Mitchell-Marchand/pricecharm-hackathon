import { formatQuantity, roundSize } from '../pricing/units.js';
import { quoteTotal, type Discount } from '../practice/types.js';

/**
 * Made-up owners for the benchmark. Each has its own hidden pricing rules and prices every job
 * exactly by them. The Charm only ever sees an owner's past jobs and practice quotes, the way it
 * sees a real owner's, so what it gets right it learned from them. The ranges below are what real
 * businesses in these trades charge, so the owners differ the way real ones do: some cheap, some
 * premium, with their own minimums, surcharges and add-ons.
 */

import { between, pick, seeded, whole, type Rng } from './random.js';
import { BLIND } from './blind-trades.js';
import { HELD_OUT } from './held-out-trades.js';
import { WIDE, type Trade } from './wide-trades.js';

export { seeded, type Rng };

export type TradeId =
  | 'window-cleaning'
  | 'pressure-washing'
  | 'gutters'
  | 'house-cleaning'
  | 'carpet'
  | 'detailing'
  | 'lawn'
  | 'trees'
  | 'fencing'
  | 'junk'
  | 'moving'
  | 'handyman'
  | 'painting'
  | 'pest'
  | 'pools'
  | 'flooring'
  | 'hvac'
  | 'landscaping'
  | 'events';

/** The trades the benchmark started with, and its default, so earlier seeds stay comparable. */
export const CLASSIC_TRADES: TradeId[] = ['window-cleaning', 'pressure-washing', 'gutters'];

/** Every trade the benchmark makes owners for, each pricing its own way. */
export const WIDE_TRADES: TradeId[] = [
  ...CLASSIC_TRADES,
  'house-cleaning',
  'carpet',
  'detailing',
  'lawn',
  'trees',
  'fencing',
  'junk',
  'moving',
  'handyman',
];

/**
 * Trades kept out of all tuning: built from their own research by someone who never saw the
 * pricing code, and run only as part of the sealed test set, to show how the pricing does on
 * businesses it wasn't shaped around.
 */
export const HELD_OUT_TRADES: TradeId[] = ['painting', 'pest', 'pools'];

/**
 * Trades for working on how the pricing carries over to businesses it wasn't built around: built
 * the same way as the held-out ones, from their own research by someone who never saw the pricing
 * code, but open, so the held-out ones can stay sealed.
 */
export const BLIND_TRADES: TradeId[] = ['flooring', 'hvac', 'landscaping', 'events'];

/** Seeds 9001–9100 and the held-out trades: the test set nothing is tuned on. */
export function isSealed(seed: number, trades: TradeId[]) {
  return (seed >= 9001 && seed <= 9100) || trades.some((id) => HELD_OUT_TRADES.includes(id));
}

/** The trades past the first three, each with its own owners, wording and prices. */
const BUILT: Record<Exclude<TradeId, 'window-cleaning' | 'pressure-washing' | 'gutters'>, Trade> = {
  ...WIDE,
  ...HELD_OUT,
  ...BLIND,
};
type Built = keyof typeof BUILT;

export type ServiceRule = {
  name: string;
  /** What the size is counted in: windows, sq ft, ft, bedrooms, acres, loads... */
  unit: string;
  /** Cents per unit. */
  rate: number;
  /** The sizes customers ask about. */
  sizes: [number, number];
  /** Past this size, each unit costs this share of the rate. */
  volume: { above: number; share: number } | null;
  /** Priced by size bands instead of per unit: up to each size, that price. */
  bands: { upTo: number; cents: number }[] | null;
  /** Whether height, or whatever makes this trade's jobs harder to reach, can change the price. */
  height: boolean;
  /** How finely customers give the size, when it isn't whole units (or square feet to 10). */
  step?: number;
  /** A set amount every job of this service starts from, before its size. */
  base?: number;
  /** A second count priced on its own, like bathrooms next to bedrooms, past any the price includes. */
  extra?: { unit: string; rate: number; range: [number, number]; included?: number };
  /** A one-off service, never booked as regular visits, like aerating a lawn. */
  once?: boolean;
  /** What the customer picks that scales the price, like the vehicle's size or the fence's material. */
  options?: { label: string; share: number }[];
  /**
   * Priced by the hour: a crew sized to the job, at that crew's hourly rate, for the hours the
   * owner reckons the size takes, rounded up to the half hour and never under their minimum.
   */
  hourly?: {
    /** Who the crew is, as the quote says it: "movers". */
    who: string;
    crews: { upTo: number; people: number; rate: number }[];
    hours: { base: number; perUnit: number };
    minimum: number;
  };
};

export type AddOnRule = {
  label: string;
  /** Per unit of the job's size, once per job, or per item the customer counts. */
  per: 'unit' | 'job' | 'item';
  cents: number;
  /**
   * For a per-unit add-on, the unit it's priced in, when the owner also offers it on a service
   * measured another way. There it costs one unit's worth, the way a carpet cleaner charges pet
   * odor by the room and counts a rug as one room.
   */
  unit?: string;
  /**
   * For per-item add-ons: what's counted, how many customers usually have, and how they say it,
   * with {n} for the count.
   */
  item?: { name: string; range: [number, number]; ask?: string };
};

export type HiddenRules = {
  services: ServiceRule[];
  /** No job for less than this, in cents. */
  minimum: number;
  /** Share added when the job is in bad shape. */
  heavy: number;
  /** Share added for a second story. */
  height: number;
  addOns: AddOnRule[];
  /** Percent off when a customer books two services together. */
  bundle: number;
  /** Every line rounded to this many cents. */
  roundTo: number;
  /** Puts surcharges on their own lines, or folds them into the main price. */
  itemizes: boolean;
  /**
   * How far the owner's price for the main work strays from their own rate, job to job, as a
   * share: real owners price by eye a little. Zero for an owner who follows their rules exactly.
   */
  wobble?: number;
  /** A set amount for a job in bad shape, for owners who charge it that way instead of a share. */
  heavyFlat?: number;
  /** A set amount for the harder access, instead of a share. */
  heightFlat?: number;
  /**
   * For owners whose customers book regular visits: each visit's price for how often they come,
   * as a share off a one-time job (below zero costs more, like mowing every other week).
   */
  recurring?: { label: string; share: number }[];
  /** How often most of their customers book, when that's the price they start from, like weekly mowing. */
  usually?: string;
  /** Prices that end in 9, like $149: the main work to the nearest $10, less a dollar. */
  endsIn9?: boolean;
  /** False for trades whose services aren't booked together, like a standard and a deep clean. */
  together?: boolean;
  /** Services booked together each have their own size, like two TVs and three drywall holes. */
  ownSizes?: boolean;
  /** A set charge on every job, on its own line, like a mover's trip charge. */
  fee?: { label: string; cents: number };
};

export type SimOwner = {
  name: string;
  area: string;
  tradeId: TradeId;
  trade: string;
  rules: HiddenRules;
};

export type SimJob = {
  service: string;
  quantity: number;
  heavy: boolean;
  twoStory: boolean;
  addOns: { label: string; count?: number }[];
  /** A second service booked with it, and its size. */
  second: { service: string; quantity: number } | null;
  /** The second count, for services priced by two, like bathrooms. */
  extra?: number;
  /** What the customer picked from the service's options. */
  option?: string;
  /** How often they want it done, for owners who price regular visits differently. */
  frequency?: string;
};

const AREAS = [
  'Raleigh, NC',
  'Columbus, OH',
  'Boise, ID',
  'Austin, TX',
  'Portland, OR',
  'Nashville, TN',
  'Tampa, FL',
  'Denver, CO',
  'Charlotte, NC',
  'Kansas City, MO',
  'Sacramento, CA',
  'Richmond, VA',
  'Madison, WI',
  'Phoenix, AZ',
  'Grand Rapids, MI',
];

const NAMES: Record<TradeId, string[]> = {
  'window-cleaning': [
    'Crystal View Window Co',
    'Bright Pane Cleaning',
    'Clearview Windows',
    'Shine Brothers Window Washing',
    'Glass Act Window Cleaning',
    'Spotless Panes',
    'Window Wizards',
    'Pane Pros',
    'Streak Free Window Co',
    'Sparkle & Shine Windows',
  ],
  'pressure-washing': [
    'PowerWash Pros',
    'Fresh Coat Washing',
    'Blue Ridge Pressure Washing',
    'Driveway Doctors',
    'Curb Appeal Washing',
    'Hydro Clean Exteriors',
    'Like New Pressure Washing',
    'Clean Slate Washing',
    'Spray Day Exterior Cleaning',
    'Surface Shine',
  ],
  gutters: [
    'Gutter Guys',
    'Clear Flow Gutters',
    'Downspout Pros',
    'Leaf Busters',
    'High Ladder Gutter Co',
    'Fall Line Gutters',
    'Rain Ready Gutters',
    'Overflow Gutter Cleaning',
    'Peak Gutter Care',
    'Clean Sweep Gutters',
  ],
  ...(Object.fromEntries(Object.entries(BUILT).map(([id, trade]) => [id, trade.names])) as Record<
    Built,
    string[]
  >),
};

export const TRADE_NAMES: Record<TradeId, string> = {
  'window-cleaning': 'Window cleaning',
  'pressure-washing': 'Pressure washing',
  gutters: 'Gutter cleaning',
  ...(Object.fromEntries(Object.entries(BUILT).map(([id, trade]) => [id, trade.name])) as Record<
    Built,
    string
  >),
};

/** How each trade's customers and owners put what changes a price. */
export type Words = {
  /** A job in bad shape, as customers describe it after "it's". */
  heavy: string;
  /** The owner's line for it, when not "Extra for" what the customer said. */
  heavyLine?: string;
  /** The harder access, as customers and the job's record put it. */
  access: string;
  /** The owner's line for it. */
  accessLine: string;
  /** How customers say it, when it isn't in the trade's first sentence. */
  accessSay?: string;
  /** What a customer says about a job in ordinary shape, when not the first three trades'. */
  fine?: string[];
};

const CLASSIC_ACCESS = { access: 'two-story', accessLine: 'Second story' };

const WORDS: Record<TradeId, Words> = {
  'window-cleaning': { heavy: 'heavy hard-water stains', ...CLASSIC_ACCESS },
  'pressure-washing': { heavy: 'heavy moss and stains', ...CLASSIC_ACCESS },
  gutters: { heavy: 'packed with debris', ...CLASSIC_ACCESS },
  ...(Object.fromEntries(Object.entries(BUILT).map(([id, trade]) => [id, trade.words])) as Record<
    Built,
    Words
  >),
};

function service(
  rng: Rng,
  name: string,
  unit: ServiceRule['unit'],
  rate: [number, number],
  sizes: [number, number],
  height: boolean,
): ServiceRule {
  const cents = whole(rng, rate[0], rate[1]);
  const style = rng();
  // Most owners charge per unit. Some give big jobs a lower rate; a few price by size bands.
  const volume =
    style < 0.25
      ? {
          above: Math.round(sizes[0] + (sizes[1] - sizes[0]) * 0.6),
          share: between(rng, 0.75, 0.9),
        }
      : null;
  const bands =
    style > 0.85
      ? [0.35, 0.65, 1].map((share) => {
          const upTo = Math.round(sizes[0] + (sizes[1] - sizes[0]) * share);
          return { upTo, cents: Math.round((cents * upTo * between(rng, 0.85, 1)) / 1000) * 1000 };
        })
      : null;
  return { name, unit, rate: cents, sizes, volume, bands, height };
}

function rulesFor(rng: Rng, tradeId: TradeId): HiddenRules {
  const shared = {
    roundTo: pick(rng, [100, 500, 500, 2500]),
    itemizes: rng() < 0.7,
    bundle: pick(rng, [0, 0, 10, 10, 15]),
  };
  if (tradeId in BUILT) return BUILT[tradeId as Built].rules(rng, shared);
  if (tradeId === 'window-cleaning')
    return {
      ...shared,
      services: [
        service(rng, 'Exterior windows', 'windows', [400, 1200], [8, 45], true),
        service(rng, 'Interior windows', 'windows', [300, 900], [8, 45], true),
      ],
      minimum: whole(rng, 99, 250) * 100,
      heavy: pick(rng, [0, between(rng, 0.15, 0.4), between(rng, 0.15, 0.4)]),
      height: pick(rng, [0, between(rng, 0.15, 0.4), between(rng, 0.15, 0.4)]),
      addOns: [
        { label: 'Screens', per: 'unit', cents: whole(rng, 100, 400) },
        { label: 'Tracks and sills', per: 'unit', cents: whole(rng, 100, 300) },
      ],
    };
  if (tradeId === 'pressure-washing') {
    const all = [
      service(rng, 'Driveways', 'sq ft', [10, 35], [300, 1500], false),
      service(rng, 'House wash', 'sq ft', [8, 30], [1200, 3500], true),
      service(rng, 'Patios & pavers', 'sq ft', [15, 45], [150, 800], false),
    ];
    const skip = Math.floor(rng() * 3);
    return {
      ...shared,
      services: all.filter((_, index) => index !== skip),
      minimum: whole(rng, 125, 300) * 100,
      heavy: between(rng, 0.2, 0.5),
      height: pick(rng, [0, between(rng, 0.1, 0.3)]),
      addOns: [
        { label: 'Sealing', per: 'unit', cents: whole(rng, 15, 60) },
        { label: 'Gutter brightening', per: 'job', cents: whole(rng, 50, 150) * 100 },
      ],
    };
  }
  return {
    ...shared,
    services: [
      service(rng, 'Gutter clean-out', 'ft', [75, 250], [80, 300], true),
      service(rng, 'Gutter brightening', 'ft', [100, 300], [80, 300], true),
    ],
    minimum: whole(rng, 99, 200) * 100,
    heavy: pick(rng, [0, between(rng, 0.15, 0.4)]),
    height: between(rng, 0.25, 0.6),
    addOns: [
      {
        label: 'Downspout flush',
        per: 'item',
        cents: whole(rng, 10, 25) * 100,
        item: { name: 'downspouts', range: [1, 6] },
      },
      { label: 'Roof debris removal', per: 'job', cents: whole(rng, 40, 100) * 100 },
    ],
  };
}

/**
 * The owners: the same number in each trade, the same ones for the same seed. Messy owners are
 * the same owners pricing by eye: each job's main work strays up to 2–8% from their own rate.
 */
export function simulatedOwners(
  seed: number,
  count: number,
  messy = false,
  trades: TradeId[] = CLASSIC_TRADES,
): SimOwner[] {
  const rng = seeded(seed);
  // Its own sequence, so messy owners keep the same rules as tidy ones.
  const eye = seeded(seed + 7777);
  return Array.from({ length: count }, (_, index) => {
    const tradeId = trades[index % trades.length];
    const names = NAMES[tradeId];
    const owner = {
      name: names[Math.floor(index / trades.length) % names.length],
      area: pick(rng, AREAS),
      tradeId,
      trade: TRADE_NAMES[tradeId],
      rules: rulesFor(rng, tradeId),
    };
    const wobble = pick(eye, [0.02, 0.04, 0.06, 0.08]);
    return messy ? { ...owner, rules: { ...owner.rules, wobble } } : owner;
  });
}

/** A number from -1 to 1 that's always the same for the same job, for how far the owner strays. */
function jobWobble(job: SimJob) {
  let hash = 2166136261;
  for (const char of JSON.stringify(job)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) / 4294967295) * 2 - 1;
}

const rounded = (cents: number, to: number) => Math.max(to, Math.round(cents / to) * to);

/** The crew and hours an hourly owner books for a job this size. */
export function crewFor(rule: ServiceRule, quantity: number) {
  const { crews, hours, minimum } = rule.hourly!;
  const crew = crews.find((item) => quantity <= item.upTo) ?? crews.at(-1)!;
  const booked = Math.max(minimum, Math.ceil((hours.base + hours.perUnit * quantity) * 2) / 2);
  return { ...crew, hours: booked };
}

function sizePrice(rule: ServiceRule, quantity: number) {
  if (rule.hourly) {
    const crew = crewFor(rule, quantity);
    return crew.rate * crew.hours;
  }
  if (rule.bands)
    return (rule.bands.find((band) => quantity <= band.upTo) ?? rule.bands.at(-1)!).cents;
  if (rule.volume && quantity > rule.volume.above)
    return Math.round(
      rule.rate * rule.volume.above +
        rule.rate * rule.volume.share * (quantity - rule.volume.above),
    );
  return rule.rate * quantity;
}

/** The main work's price: its size, any base and second count, scaled by what the customer picked. */
function workPrice(rule: ServiceRule, quantity: number, job?: Pick<SimJob, 'extra' | 'option'>) {
  let cents = sizePrice(rule, quantity) + (rule.base ?? 0);
  if (rule.extra && job?.extra)
    cents += rule.extra.rate * Math.max(0, job.extra - (rule.extra.included ?? 0));
  const option = rule.options?.find((item) => item.label === job?.option);
  return option ? Math.round(cents * option.share) : cents;
}

/** How often the customer wants it, when it changes this owner's price. */
const visitShare = (rules: HiddenRules, job: SimJob) =>
  rules.recurring?.find((item) => item.label === job.frequency)?.share ?? 0;

const EIGHTHS = [
  'an eighth of a truckload',
  'a quarter of a truckload',
  'three eighths of a truckload',
  'half a truckload',
  'five eighths of a truckload',
  'three quarters of a truckload',
  'seven eighths of a truckload',
  'a full truckload',
];

/** A size the way people say it: "24 windows", or a share of a truck, like "half a truckload". */
export function sizeWords(quantity: number, unit: string) {
  if (unit !== 'loads') return formatQuantity(quantity, unit);
  const eighths = Math.round(quantity * 8);
  if (eighths >= 1 && eighths <= 8) return EIGHTHS[eighths - 1];
  return formatQuantity(quantity, unit);
}

/** The main work's line, the way the owner writes it: what, how big, and anything picked. */
function mainLabel(main: ServiceRule, job: SimJob) {
  const size = sizeWords(job.quantity, main.unit);
  if (main.hourly) {
    const crew = crewFor(main, job.quantity);
    return `${main.name}, ${size}: ${crew.people} ${main.hourly.who}, ${crew.hours} hours`;
  }
  return [
    `${main.name}, ${size}`,
    main.extra && job.extra ? formatQuantity(job.extra, main.extra.unit) : '',
    job.option ?? '',
    job.frequency && job.frequency !== ONE_TIME ? job.frequency : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export type OwnerQuote = {
  lines: { label: string; amountCents: number }[];
  discount: Discount | null;
};

/** What this owner charges for the job, written the way they write a quote. */
export function ownerQuote(owner: SimOwner, job: SimJob): OwnerQuote {
  const { rules } = owner;
  const main = rules.services.find((item) => item.name === job.service)!;
  const base = Math.round(
    workPrice(main, job.quantity, job) *
      (1 - visitShare(rules, job)) *
      (1 + (rules.wobble ?? 0) * jobWobble(job)),
  );
  const heavy = job.heavy ? (rules.heavyFlat ?? Math.round(base * rules.heavy)) : 0;
  const height =
    job.twoStory && main.height ? (rules.heightFlat ?? Math.round(base * rules.height)) : 0;
  const lines: { label: string; amountCents: number }[] = [];
  const label = mainLabel(main, job);
  const words = WORDS[owner.tradeId];
  if (rules.itemizes) {
    lines.push({ label, amountCents: base });
    if (heavy)
      lines.push({ label: words.heavyLine ?? `Extra for ${words.heavy}`, amountCents: heavy });
    if (height) lines.push({ label: words.accessLine, amountCents: height });
  } else lines.push({ label, amountCents: base + heavy + height });
  if (job.second) {
    const other = rules.services.find((item) => item.name === job.second!.service)!;
    lines.push({
      label: `${other.name}, ${formatQuantity(job.second.quantity, other.unit)}`,
      amountCents: workPrice(other, job.second.quantity, { option: job.option }),
    });
  }
  for (const wanted of job.addOns) {
    const rule = rules.addOns.find((item) => item.label === wanted.label)!;
    const amount =
      rule.per === 'unit'
        ? rule.cents * (rule.unit && rule.unit !== main.unit ? 1 : job.quantity)
        : rule.per === 'item'
          ? rule.cents * (wanted.count ?? 1)
          : rule.cents;
    lines.push({
      label: rule.per === 'item' ? `${rule.label} (${wanted.count ?? 1})` : rule.label,
      amountCents: amount,
    });
  }
  if (rules.fee) lines.push({ label: rules.fee.label, amountCents: rules.fee.cents });
  for (const line of lines) line.amountCents = rounded(line.amountCents, rules.roundTo);
  if (rules.endsIn9)
    lines[0].amountCents = Math.max(900, Math.round(lines[0].amountCents / 1000) * 1000 - 100);
  // The minimum is for the whole job, so a small one is raised on its main line.
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (subtotal < rules.minimum) lines[0].amountCents += rules.minimum - subtotal;
  const discount: Discount | null =
    job.second && rules.bundle
      ? { kind: 'percent', value: rules.bundle, reason: 'Two services together' }
      : null;
  return { lines, discount };
}

export const ownerTotal = (owner: SimOwner, job: SimJob) => quoteTotal(ownerQuote(owner, job));

/**
 * A job a customer might ask for. Shape picks the kind; the rest is drawn at random. With extra,
 * the job asks for that one of the owner's add-ons.
 */
export function drawJob(
  rng: Rng,
  owner: SimOwner,
  shape: 'typical' | 'plain' | 'bigger' | 'tricky' | 'heavy' | 'tall' | 'small' | 'other' | 'any',
  extra?: number,
): SimJob {
  const [first, second] = owner.rules.services;
  const rule =
    shape === 'other'
      ? second
      : shape === 'tall'
        ? (owner.rules.services.find((item) => item.height) ?? first)
        : shape === 'any' && rng() < 0.3
          ? second
          : first;
  const [low, high] = rule.sizes;
  const raw =
    shape === 'small'
      ? low
      : shape === 'bigger'
        ? low + (high - low) * between(rng, 0.7, 0.95)
        : shape === 'heavy'
          ? low + (high - low) * between(rng, 0.6, 0.85)
          : shape === 'any'
            ? between(rng, low, high)
            : // A practice job that shows one extra or condition is big enough that a minimum
              // can't hide what it costs.
              shape === 'plain' || shape === 'other' || shape === 'tall'
              ? low + (high - low) * between(rng, 0.55, 0.8)
              : low + (high - low) * between(rng, 0.35, 0.55);
  const sized = sizeOf(rule, raw);
  const addOns: SimJob['addOns'] = [];
  const wantsAddOns =
    shape === 'bigger' ? 1 : shape === 'any' ? (rng() < 0.4 ? 1 + Math.floor(rng() * 2) : 0) : 0;
  const wanted =
    extra === undefined
      ? owner.rules.addOns
          .slice()
          .sort(() => rng() - 0.5)
          .slice(0, wantsAddOns)
      : [owner.rules.addOns[extra % owner.rules.addOns.length]];
  for (const addOn of wanted)
    addOns.push({
      label: addOn.label,
      count: addOn.item ? whole(rng, addOn.item.range[0], addOn.item.range[1]) : undefined,
    });
  const job: SimJob = {
    service: rule.name,
    quantity: sized,
    heavy: shape === 'tricky' || shape === 'heavy' || (shape === 'any' && rng() < 0.35),
    twoStory:
      rule.height &&
      (shape === 'tricky' ||
        shape === 'tall' ||
        ((shape === 'any' || shape === 'typical') && rng() < 0.45)),
    addOns,
    second:
      (shape === 'bigger' || (shape === 'any' && rng() < 0.25)) &&
      rule === first &&
      owner.rules.together !== false
        ? {
            service: second.name,
            // Windows and gutters come as one house; a pressure-washing extra has its own size.
            quantity:
              second.unit === rule.unit &&
              owner.tradeId !== 'pressure-washing' &&
              !owner.rules.ownSizes
                ? sized
                : otherSize(
                    owner,
                    second,
                    second.sizes[0] + (second.sizes[1] - second.sizes[0]) * between(rng, 0.3, 0.6),
                  ),
          }
        : null,
  };
  // What only some trades ask, drawn after the rest so the first three trades' jobs stay the same.
  if (rule.extra) {
    const [fewest, most] = rule.extra.range;
    job.extra =
      shape === 'small'
        ? fewest
        : whole(rng, fewest, Math.max(fewest, Math.min(most, Math.ceil(sized))));
  }
  if (rule.options) job.option = pick(rng, rule.options).label;
  if (owner.rules.recurring && !rule.once)
    job.frequency =
      (shape === 'any' || shape === 'typical') && rng() < 0.5
        ? pick(rng, owner.rules.recurring).label
        : (owner.rules.usually ?? ONE_TIME);
  return job;
}

/** Every size priced for each service in these jobs, by lowercase name. */
export function sizesShown(jobs: SimJob[]) {
  const sizes: Record<string, number[]> = {};
  for (const job of jobs) {
    (sizes[job.service.toLowerCase()] ??= []).push(job.quantity);
    if (job.second) (sizes[job.second.service.toLowerCase()] ??= []).push(job.second.quantity);
  }
  return sizes;
}

/**
 * A size past any priced for the service priced at the fewest sizes: half the smallest, or one and
 * a half times the biggest. Two practice customers at these sizes after setup (--practice stretch)
 * set against two at usual sizes (--practice more), on 2026-11-01: the jobs they reached went 65%
 * to 71% within 10%, but adding any two quotes moved the owner's other prices about as much, so
 * neither came out ahead, and the app doesn't do this.
 */
export function stretchSize(
  services: string[],
  sizes: Record<string, number[]>,
  side: 'bigger' | 'smaller',
): { service: string; around: number } | null {
  const sizesOf = (service: string) => sizes[service.toLowerCase()] ?? [];
  const service = services
    .slice()
    .sort((a, b) => sizesOf(a).length - sizesOf(b).length)
    .at(0);
  const priced = service ? sizesOf(service) : [];
  if (!service || !priced.length) return null;
  const around =
    side === 'bigger' ? roundSize(Math.max(...priced) * 1.5) : roundSize(Math.min(...priced) * 0.5);
  return side === 'bigger' || around < Math.min(...priced) ? { service, around } : null;
}

/** A plain job for one service at the size given, nothing else asked. */
export function stretchedJob(rng: Rng, owner: SimOwner, service: string, around: number): SimJob {
  const [main] = owner.rules.services;
  const job = drawJob(rng, owner, service === main.name ? 'plain' : 'other');
  const rule = owner.rules.services.find((item) => item.name === service)!;
  job.quantity = sizeOf(rule, around);
  if (rule.extra && job.extra !== undefined)
    job.extra = Math.max(rule.extra.range[0], Math.min(job.extra, Math.ceil(job.quantity)));
  return job;
}

/** "There's also a stump to grind.|There are also {n} stumps to grind." for this many. */
function sayCount(ask: string, count: number) {
  const [one, many = one] = ask.split('|');
  return (count === 1 ? one : many).replace('{n}', String(count));
}

/** What a customer who wants it done once says, for owners who price regular visits. */
export const ONE_TIME = 'one time';

/**
 * A size the way customers give it: whole windows and feet, square feet to the nearest 10, or to
 * the service's own step, like a quarter of a truck.
 */
function sizeOf(rule: ServiceRule, raw: number) {
  if (rule.step)
    return Number(Math.max(rule.step, Math.round(raw / rule.step) * rule.step).toFixed(3));
  const whole = Math.round(raw);
  return rule.unit === 'windows' || rule.unit === 'ft' ? whole : Math.round(whole / 10) * 10;
}

/** A second service's own size: square feet to 10 in the first three trades, else its own step. */
function otherSize(owner: SimOwner, rule: ServiceRule, raw: number) {
  return CLASSIC_TRADES.includes(owner.tradeId) ? Math.round(raw / 10) * 10 : sizeOf(rule, raw);
}

/**
 * The owner's past jobs: three of their main service, small, usual and big, nothing unusual, then
 * with --past more, of any kind, the way an owner's invoices run.
 */
export function pastJobs(rng: Rng, owner: SimOwner, count: number): SimJob[] {
  const rule = owner.rules.services[0];
  const [low, high] = rule.sizes;
  const first = [0.2, 0.5, 0.85].map((share) => {
    const raw = low + (high - low) * share;
    const job: SimJob = {
      service: rule.name,
      quantity: rule.step
        ? sizeOf(rule, raw)
        : rule.unit === 'sq ft'
          ? Math.round(raw / 10) * 10
          : Math.round(raw),
      heavy: false,
      twoStory: rule.height && rng() < 0.4,
      addOns: [],
      second: null,
    };
    // Plain jobs: the first count in proportion, the most usual choice, done once.
    if (rule.extra)
      job.extra = Math.max(
        rule.extra.range[0],
        Math.min(rule.extra.range[1], Math.round(job.quantity * 0.7)),
      );
    if (rule.options) job.option = rule.options[0].label;
    if (owner.rules.recurring) job.frequency = owner.rules.usually ?? ONE_TIME;
    return job;
  });
  return [
    ...first,
    ...Array.from({ length: Math.max(0, count - 3) }, () => drawJob(rng, owner, 'any')),
  ];
}

const unitOf = (owner: SimOwner, name: string) =>
  owner.rules.services.find((item) => item.name === name)!.unit;

/** The job as the customer chat would record it, for the drafts to price from. */
export function jobSpec(owner: SimOwner, job: SimJob) {
  return {
    quantity: job.quantity,
    unit: unitOf(owner, job.service),
    condition: job.heavy ? WORDS[owner.tradeId].heavy : '',
    access: job.twoStory ? WORDS[owner.tradeId].access : '',
    extras: [
      ...(job.second
        ? [
            `${job.second.service} (${formatQuantity(job.second.quantity, unitOf(owner, job.second.service))})`,
          ]
        : []),
      ...job.addOns.map((addOn) => (addOn.count ? `${addOn.label} (${addOn.count})` : addOn.label)),
    ],
    timing: job.frequency && job.frequency !== ONE_TIME ? job.frequency : '',
  };
}

/** What the customer writes, in plain words, with everything the price depends on. */
export function customerMessage(rng: Rng, owner: SimOwner, job: SimJob, askDiscount = false) {
  const rule = owner.rules.services.find((item) => item.name === job.service)!;
  const size = formatQuantity(job.quantity, rule.unit);
  const story = job.twoStory ? 'two-story' : 'one-story';
  const parts: string[] = [];
  if (owner.tradeId === 'window-cleaning')
    parts.push(
      `${pick(rng, ['Hi!', 'Hello,', 'Hey there,'])} Could I get a quote for ${job.service === 'Interior windows' ? 'the inside of our windows' : 'our windows, outside'}? It's a ${story} house with ${size}.`,
    );
  else if (owner.tradeId === 'pressure-washing')
    parts.push(
      `${pick(rng, ['Hi,', 'Hello!', 'Hey,'])} Looking for a price on ${job.service === 'House wash' ? `a house wash. The house is ${story}, about ${size} of siding` : `our ${job.service.toLowerCase()}, about ${size}`}.`,
    );
  else if (owner.tradeId === 'gutters')
    parts.push(
      `${pick(rng, ['Hi,', 'Hello,', 'Hey!'])} Need a quote for ${job.service === 'Gutter brightening' ? 'brightening the outside of our gutters' : 'cleaning out our gutters'}. ${job.twoStory ? 'Two-story' : 'Single-story'} house, about ${size} of gutter.`,
    );
  else
    parts.push(
      BUILT[owner.tradeId as Built].ask(rng, job, rule, sizeWords(job.quantity, rule.unit)),
    );
  const words = WORDS[owner.tradeId];
  if (job.twoStory && words.accessSay) parts.push(words.accessSay);
  if (job.heavy)
    parts.push(
      pick(rng, [`Fair warning, it's ${words.heavy}.`, `It's in rough shape: ${words.heavy}.`]),
    );
  else
    parts.push(
      pick(rng, words.fine ?? ['Not too bad, just due.', 'Pretty normal, nothing crazy.', '']),
    );
  const also = BUILT[owner.tradeId as Built]?.also;
  if (job.second) {
    const size = sizeWords(job.second.quantity, unitOf(owner, job.second.service));
    parts.push(
      job.second.quantity === job.quantity &&
        unitOf(owner, job.second.service) === rule.unit &&
        !owner.rules.ownSizes
        ? `Could you do the ${job.second.service.toLowerCase()} too?`
        : also
          ? also(job.second.service, size)
          : `Could you also do ${job.second.service.toLowerCase()}, about ${size}?`,
    );
  }
  for (const addOn of job.addOns) {
    const item = owner.rules.addOns.find((rule) => rule.label === addOn.label)?.item;
    parts.push(
      addOn.count
        ? sayCount(item?.ask ?? 'There are {n} downspouts that need flushing.', addOn.count)
        : `Please add ${addOn.label.toLowerCase()}.`,
    );
  }
  if (job.frequency)
    parts.push(
      job.frequency === ONE_TIME
        ? pick(rng, ['Just a one-time job for now.', 'Only once for now.'])
        : `We'd want it ${job.frequency}.`,
    );
  if (askDiscount) parts.push('My neighbor might want the same done. Any discount?');
  return parts.filter(Boolean).join(' ');
}

/** A past job as an owner would enter it in setup: what it was, its size, and the price. */
export function pastJobRecord(owner: SimOwner, job: SimJob) {
  const rule = owner.rules.services.find((item) => item.name === job.service)!;
  const quote = ownerQuote(owner, job);
  const words = WORDS[owner.tradeId];
  const details = [
    rule.extra && job.extra ? formatQuantity(job.extra, rule.extra.unit) : '',
    job.option ?? '',
    job.frequency && job.frequency !== ONE_TIME ? job.frequency : '',
    job.twoStory ? words.access : '',
    job.heavy ? words.heavy : '',
    ...jobSpec(owner, job).extras.map((extra) => `plus ${extra.toLowerCase()}`),
  ].filter(Boolean);
  return {
    service: rule.name,
    description: `${sizeWords(job.quantity, rule.unit)}${details.length ? `, ${details.join(', ')}` : ''}`,
    size: formatQuantity(job.quantity, rule.unit),
    priceCents: quoteTotal(quote),
    discount: quote.discount,
  };
}
