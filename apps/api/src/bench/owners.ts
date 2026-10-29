import { formatQuantity } from '../pricing/units.js';
import { quoteTotal, type Discount } from '../practice/types.js';

/**
 * Made-up owners for the benchmark. Each has its own hidden pricing rules and prices every job
 * exactly by them. The Charm only ever sees an owner's past jobs and practice quotes, the way it
 * sees a real owner's, so what it gets right it learned from them. The ranges below are what real
 * businesses in these trades charge, so the owners differ the way real ones do: some cheap, some
 * premium, with their own minimums, surcharges and add-ons.
 */

export type Rng = () => number;

/** A repeatable random sequence (mulberry32), so a seed always makes the same owners and jobs. */
export function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();
const whole = (rng: Rng, low: number, high: number) => Math.round(between(rng, low, high));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export type TradeId = 'window-cleaning' | 'pressure-washing' | 'gutters';

type ServiceRule = {
  name: string;
  unit: 'windows' | 'sq ft' | 'ft';
  /** Cents per unit. */
  rate: number;
  /** The sizes customers ask about. */
  sizes: [number, number];
  /** Past this size, each unit costs this share of the rate. */
  volume: { above: number; share: number } | null;
  /** Priced by size bands instead of per unit: up to each size, that price. */
  bands: { upTo: number; cents: number }[] | null;
  /** Whether height can change this service's price. */
  height: boolean;
};

type AddOnRule = {
  label: string;
  /** Per unit of the job's size, once per job, or per item the customer counts. */
  per: 'unit' | 'job' | 'item';
  cents: number;
  /** For per-item add-ons: what's counted, and how many customers usually have. */
  item?: { name: string; range: [number, number] };
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
};

export const TRADE_NAMES: Record<TradeId, string> = {
  'window-cleaning': 'Window cleaning',
  'pressure-washing': 'Pressure washing',
  gutters: 'Gutter cleaning',
};

/** How customers describe a job in bad shape, by trade. */
const HEAVY: Record<TradeId, string> = {
  'window-cleaning': 'heavy hard-water stains',
  'pressure-washing': 'heavy moss and stains',
  gutters: 'packed with debris',
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

/** The owners: the same number in each trade, the same ones for the same seed. */
export function simulatedOwners(seed: number, count: number): SimOwner[] {
  const rng = seeded(seed);
  const trades: TradeId[] = ['window-cleaning', 'pressure-washing', 'gutters'];
  return Array.from({ length: count }, (_, index) => {
    const tradeId = trades[index % trades.length];
    const names = NAMES[tradeId];
    return {
      name: names[Math.floor(index / trades.length) % names.length],
      area: pick(rng, AREAS),
      tradeId,
      trade: TRADE_NAMES[tradeId],
      rules: rulesFor(rng, tradeId),
    };
  });
}

const rounded = (cents: number, to: number) => Math.max(to, Math.round(cents / to) * to);

function workPrice(rule: ServiceRule, quantity: number) {
  if (rule.bands)
    return (rule.bands.find((band) => quantity <= band.upTo) ?? rule.bands.at(-1)!).cents;
  if (rule.volume && quantity > rule.volume.above)
    return Math.round(
      rule.rate * rule.volume.above +
        rule.rate * rule.volume.share * (quantity - rule.volume.above),
    );
  return rule.rate * quantity;
}

export type OwnerQuote = {
  lines: { label: string; amountCents: number }[];
  discount: Discount | null;
};

/** What this owner charges for the job, written the way they write a quote. */
export function ownerQuote(owner: SimOwner, job: SimJob): OwnerQuote {
  const { rules } = owner;
  const main = rules.services.find((item) => item.name === job.service)!;
  const base = workPrice(main, job.quantity);
  const heavy = job.heavy ? Math.round(base * rules.heavy) : 0;
  const height = job.twoStory && main.height ? Math.round(base * rules.height) : 0;
  const lines: { label: string; amountCents: number }[] = [];
  const size = formatQuantity(job.quantity, main.unit);
  if (rules.itemizes) {
    lines.push({ label: `${main.name}, ${size}`, amountCents: base });
    if (heavy) lines.push({ label: `Extra for ${HEAVY[owner.tradeId]}`, amountCents: heavy });
    if (height) lines.push({ label: 'Second story', amountCents: height });
  } else lines.push({ label: `${main.name}, ${size}`, amountCents: base + heavy + height });
  if (job.second) {
    const other = rules.services.find((item) => item.name === job.second!.service)!;
    lines.push({
      label: `${other.name}, ${formatQuantity(job.second.quantity, other.unit)}`,
      amountCents: workPrice(other, job.second.quantity),
    });
  }
  for (const wanted of job.addOns) {
    const rule = rules.addOns.find((item) => item.label === wanted.label)!;
    const amount =
      rule.per === 'unit'
        ? rule.cents * job.quantity
        : rule.per === 'item'
          ? rule.cents * (wanted.count ?? 1)
          : rule.cents;
    lines.push({
      label: rule.per === 'item' ? `${rule.label} (${wanted.count ?? 1})` : rule.label,
      amountCents: amount,
    });
  }
  for (const line of lines) line.amountCents = rounded(line.amountCents, rules.roundTo);
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
  const quantity =
    shape === 'small'
      ? low
      : shape === 'bigger'
        ? Math.round(low + (high - low) * between(rng, 0.7, 0.95))
        : shape === 'heavy'
          ? Math.round(low + (high - low) * between(rng, 0.6, 0.85))
          : shape === 'any'
            ? Math.round(between(rng, low, high))
            : Math.round(low + (high - low) * between(rng, 0.35, 0.55));
  const sized =
    rule.unit === 'windows' || rule.unit === 'ft' ? quantity : Math.round(quantity / 10) * 10;
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
  return {
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
      (shape === 'bigger' || (shape === 'any' && rng() < 0.25)) && rule === first
        ? {
            service: second.name,
            // Windows and gutters come as one house; a pressure-washing extra has its own size.
            quantity:
              second.unit === rule.unit && owner.tradeId !== 'pressure-washing'
                ? sized
                : Math.round(
                    (second.sizes[0] +
                      (second.sizes[1] - second.sizes[0]) * between(rng, 0.3, 0.6)) /
                      10,
                  ) * 10,
          }
        : null,
  };
}

const unitOf = (owner: SimOwner, name: string) =>
  owner.rules.services.find((item) => item.name === name)!.unit;

/** The job as the customer chat would record it, for the drafts to price from. */
export function jobSpec(owner: SimOwner, job: SimJob) {
  return {
    quantity: job.quantity,
    unit: unitOf(owner, job.service),
    condition: job.heavy ? HEAVY[owner.tradeId] : '',
    access: job.twoStory ? 'two-story' : '',
    extras: [
      ...(job.second
        ? [
            `${job.second.service} (${formatQuantity(job.second.quantity, unitOf(owner, job.second.service))})`,
          ]
        : []),
      ...job.addOns.map((addOn) => (addOn.count ? `${addOn.label} (${addOn.count})` : addOn.label)),
    ],
    timing: '',
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
  else
    parts.push(
      `${pick(rng, ['Hi,', 'Hello,', 'Hey!'])} Need a quote for ${job.service === 'Gutter brightening' ? 'brightening the outside of our gutters' : 'cleaning out our gutters'}. ${job.twoStory ? 'Two-story' : 'Single-story'} house, about ${size} of gutter.`,
    );
  if (job.heavy)
    parts.push(
      pick(rng, [
        `Fair warning, it's ${HEAVY[owner.tradeId]}.`,
        `It's in rough shape: ${HEAVY[owner.tradeId]}.`,
      ]),
    );
  else parts.push(pick(rng, ['Not too bad, just due.', 'Pretty normal, nothing crazy.', '']));
  if (job.second)
    parts.push(
      job.second.quantity === job.quantity && unitOf(owner, job.second.service) === rule.unit
        ? `Could you do the ${job.second.service.toLowerCase()} too?`
        : `Could you also do ${job.second.service.toLowerCase()}, about ${formatQuantity(job.second.quantity, unitOf(owner, job.second.service))}?`,
    );
  for (const addOn of job.addOns)
    parts.push(
      addOn.count
        ? `There are ${addOn.count} downspouts that need flushing.`
        : `Please add ${addOn.label.toLowerCase()}.`,
    );
  if (askDiscount) parts.push('My neighbor might want the same done. Any discount?');
  return parts.filter(Boolean).join(' ');
}

/** A past job as an owner would enter it in setup: what it was, its size, and the price. */
export function pastJobRecord(owner: SimOwner, job: SimJob) {
  const rule = owner.rules.services.find((item) => item.name === job.service)!;
  const quote = ownerQuote(owner, job);
  const details = [
    job.twoStory ? 'two-story' : '',
    job.heavy ? HEAVY[owner.tradeId] : '',
    ...jobSpec(owner, job).extras.map((extra) => `plus ${extra.toLowerCase()}`),
  ].filter(Boolean);
  return {
    service: rule.name,
    description: `${formatQuantity(job.quantity, rule.unit)}${details.length ? `, ${details.join(', ')}` : ''}`,
    size: formatQuantity(job.quantity, rule.unit),
    priceCents: quoteTotal(quote),
    discount: quote.discount,
  };
}
