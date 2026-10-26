import fs from 'node:fs/promises';
import type { DraftedQuote, PracticeScenario, QuoteLine } from './types.js';

/**
 * Demo mode (AI_PROVIDER=demo, used in local runs and tests) runs practice without a model: three
 * fixed pressure-washing customers from the prototype, answering from patterns, with bundled photos.
 */

const SIZE =
  /\b(how big|size|sq ?ft|sqft|square|feet|foot|footage|dimensions?|measure\w*|how large|how much (area|space))\b/i;
const SURFACE =
  /\b(surface|concrete|stones?|flagstones?|pavers?|brick|material|made of|what kind|type of)\b/i;
const STAINS =
  /\b(stains?|staining|dirty|dirt|mold|mildew|moss|algae|green|black|condition|oil|rust|last (cleaned|washed)|how long|grime|shape)\b/i;
const ACCESS =
  /\b(water|spigot|hose|faucet|bib|access|gate|get to|get around|park|parking|truck)\b/i;
const TIMING =
  /\b(when|date|timing|timeline|schedule|deadline|soon|by when|what day|weekend|weekday|week)\b/i;
const FURNITURE = /\b(planters?|pots?|furniture|move|moving|plants?|table|chairs?|grill)\b/i;
const SEAL = /\b(seal|sealer|sealing|sealant|protect\w*|coating)\b/i;
const LOCATION = /\b(where|address|located|location|neighbou?rhood|zip|city|part of town)\b/i;
const DISCOUNT = /\b(discount|neighbou?rs?|deal|cheaper|price break|coupon|promo|together)\b/i;
const DAMAGE =
  /\b(loose|wobbl\w*|rocks?|rocking|uneven|broken|crack\w*|damage\w*|repair\w*|fix\w*|sink\w*)\b/i;
const PHOTO_REQUEST =
  /\b(photos?|pictures?|pics?|images?|close[- ]?up|closer|another (shot|angle|look)|show me|send (me )?(a|another|more|one))\b/i;
const PRICE_MENTION = /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i;
const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|ok|okay|great|sounds good|cool|perfect)\b/i;

const PATTERNS: Record<string, RegExp> = {
  size: SIZE,
  surface: SURFACE,
  stains: STAINS,
  access: ACCESS,
  timing: TIMING,
  furniture: FURNITURE,
  seal: SEAL,
  location: LOCATION,
  discount: DISCOUNT,
  damage: DAMAGE,
};

const LABELS: Record<string, { label: string; question: string }> = {
  size: { label: 'size', question: 'How big is the area?' },
  surface: { label: 'the surface', question: 'What is the surface made of?' },
  stains: { label: 'how dirty it is', question: 'How dirty is it, and when was it last cleaned?' },
  access: {
    label: 'water and access',
    question: 'Is there an outside spigot, and can we get to it easily?',
  },
  timing: { label: 'timing', question: 'When do you need it done?' },
  furniture: { label: 'what needs moving', question: 'Is there furniture or planters to move?' },
  seal: { label: 'sealing', question: 'Do you want it sealed afterwards?' },
  location: { label: 'location', question: 'Where is the job?' },
  discount: { label: 'neighbor discounts', question: 'Is a neighbor booking the same day?' },
  damage: { label: 'damage', question: 'Is anything loose, cracked or damaged?' },
};

type DemoCustomer = {
  id: string;
  firstName: string;
  lastInitial: string;
  place: string;
  opener: string;
  photos: string[];
  extraPhoto: { photo: string; text: string };
  areaSqFt: number;
  kindLabel: string;
  facts: [key: string, answer: string][];
  suggestions: string[];
  addOns: { pattern: RegExp; typicalCents: number }[];
  siteVisitLikely: boolean;
  siteVisitCue: string;
  priceNudge: string;
  acceptReply: string;
  siteVisitReply: string;
};

const CUSTOMERS: DemoCustomer[] = [
  {
    id: 'dana',
    firstName: 'Dana',
    lastInitial: 'R',
    place: 'Eastgate',
    opener:
      "Hi! We're listing our house in two weeks and the back patio looks rough. Could you give me a price to pressure wash it? A couple of photos below.",
    photos: ['patio-overview', 'patio-stains'],
    extraPhoto: {
      photo: 'patio-door',
      text: "Here's the spot right outside the sliding door. It's the worst part.",
    },
    areaSqFt: 550,
    kindLabel: 'patios',
    facts: [
      [
        'size',
        "It's about 18 by 24 feet of concrete, plus the stone section in the middle. Maybe 550 sq ft in total.",
      ],
      ['surface', 'Mostly concrete. The middle part is flagstone set in mortar.'],
      [
        'stains',
        "Dark patches everywhere, worst by the door. I don't think it's been cleaned in the six years we've lived here.",
      ],
      [
        'access',
        "There's a spigot by the back door, and you can walk around the side of the house. No gate.",
      ],
      ['timing', 'Ideally by next Friday. The photographer comes the Monday after.'],
      ['furniture', "Just three big planters. They're heavy, but we can help move them."],
      ['seal', "I hadn't thought about sealing. Is it worth it if we're selling?"],
      ['location', "We're in Eastgate, just off Linden Avenue."],
    ],
    suggestions: [
      'Patio wash, about 550 sq ft',
      'Stain pre-treatment',
      'Flagstone joint clean-out',
      'Sealer, one coat',
    ],
    addOns: [{ pattern: /stain|pre-?treat/i, typicalCents: 4000 }],
    siteVisitLikely: false,
    siteVisitCue: '',
    priceNudge:
      'That sounds fair. Could you send it as a quote so I have it in writing for the realtor?',
    acceptReply: 'That works for us, thank you! Could you do next Thursday morning?',
    siteVisitReply: 'Sure. Could you swing by tomorrow afternoon?',
  },
  {
    id: 'marcus',
    firstName: 'Marcus',
    lastInitial: 'T',
    place: 'North Hills',
    opener:
      'Hey, I need the back patio cleaned before a party on the 14th. My neighbor says you give a discount when two houses on the street book together. Is that still a thing? Pics attached.',
    photos: ['table-patio', 'table-stains'],
    extraPhoto: { photo: 'planters', text: "This is by the planters. It's pretty green there." },
    areaSqFt: 700,
    kindLabel: 'patios',
    facts: [
      ['size', 'Around 700 sq ft. The table area is the biggest part.'],
      ['surface', 'Concrete, with a strip of flagstone along the edge.'],
      [
        'stains',
        'Dark spots under the table and green by the planters. Last cleaned maybe three years ago.',
      ],
      [
        'discount',
        'Yeah, Jen at 412 wants hers done too. She said you took 10% off for both houses last year.',
      ],
      ['furniture', "A table, six chairs and a bunch of pots. I'll clear the furniture myself."],
      ['access', 'Hose bib on the side of the house. The gate is 4 feet wide.'],
      ['timing', 'Anytime before the 14th. Weekdays are fine.'],
      ['location', 'North Hills, near the middle school.'],
      ['seal', 'Not worried about sealing. I just want it clean.'],
    ],
    suggestions: [
      'Patio wash, about 700 sq ft',
      'Planter area detail',
      'Move furniture and pots',
      'Neighbor discount',
    ],
    addOns: [{ pattern: /planter|green|algae|detail/i, typicalCents: 3500 }],
    siteVisitLikely: false,
    siteVisitCue: '',
    priceNudge: 'Works for me. Can you send it over as a quote? I want to show Jen.',
    acceptReply: "Perfect. I'll tell Jen to book too. Thanks!",
    siteVisitReply: "Hmm, okay. Can you come by this week? The party's coming up fast.",
  },
  {
    id: 'priya',
    firstName: 'Priya',
    lastInitial: 'S',
    place: 'Old Town',
    opener:
      'Hi there. Our flagstone patio is filthy, and a few stones wobble when you step on them. Can you clean it and fix those? Also wondering about sealing. Photos below.',
    photos: ['flagstone-wide', 'flagstone-edge'],
    extraPhoto: {
      photo: 'flagstone-close',
      text: 'This is the section that moves. The dark stone in the middle rocks the most.',
    },
    areaSqFt: 350,
    kindLabel: 'flagstone',
    facts: [
      [
        'size',
        "The patio is about 12 by 16, and there's a walkway maybe 40 feet long and 3 feet wide. So 300-something sq ft?",
      ],
      ['surface', 'Flagstone. Some is set in mortar and some just sits in sand, I think.'],
      [
        'damage',
        'Five or six stones, maybe. One has a crack across it, and the mortar around them is crumbling.',
      ],
      ['stains', "Black and green all over, mostly where it's shady."],
      ['seal', "We'd like it sealed if it makes sense. Something that won't get slippery."],
      ['access', "The side gate is narrow, about 30 inches. The spigot's on the back wall."],
      ['timing', 'No rush. Sometime this month would be nice.'],
      ['location', 'Old Town, two blocks from the river.'],
    ],
    suggestions: [
      'Flagstone wash, about 350 sq ft',
      'Reset loose stones',
      'Repoint mortar joints',
      'Sealer, two coats',
    ],
    addOns: [
      { pattern: /reset|loose|repair|mortar|repoint/i, typicalCents: 18000 },
      { pattern: /seal/i, typicalCents: 22000 },
    ],
    siteVisitLikely: true,
    siteVisitCue: 'loose and cracked stones',
    priceNudge: "Okay. Could you put that in a quote? I'd like to see what's included.",
    acceptReply: 'That sounds right. Thanks for being upfront about the loose stones.',
    siteVisitReply: 'That makes sense. Could you come by Saturday morning?',
  },
];
const BY_ID = Object.fromEntries(CUSTOMERS.map((customer) => [customer.id, customer]));

export function demoScenario(position: number, services: string[]): PracticeScenario {
  const customer = CUSTOMERS[position % CUSTOMERS.length];
  return {
    demoId: customer.id,
    firstName: customer.firstName,
    lastInitial: customer.lastInitial,
    place: customer.place,
    serviceName:
      services.find((name) => /patio|paver|flat/i.test(name)) ?? services[0] ?? 'Patio cleaning',
    opener: customer.opener,
    facts: customer.facts.map(([key, answer]) => ({ key, ...LABELS[key], answer })),
    photos: customer.photos.map((photo) => ({ scene: photo, photoId: null })),
    extraPhoto: { scene: customer.extraPhoto.photo, text: customer.extraPhoto.text, photoId: null },
    suggestions: customer.suggestions,
    siteVisitLikely: customer.siteVisitLikely,
    siteVisitCue: customer.siteVisitCue,
    acceptReply: customer.acceptReply,
    siteVisitReply: customer.siteVisitReply,
  };
}

/** The bundled photo for a demo scene. */
export function demoPhoto(scene: string): Promise<Buffer> {
  if (!/^[a-z-]+$/.test(scene)) throw new Error('Unknown demo photo.');
  return fs.readFile(new URL(`../../assets/practice/${scene}.jpg`, import.meta.url));
}

const NOT_SURE = [
  "Hmm, I'm not sure. What should I look for?",
  'Good question. I honestly don’t know.',
  "I'd have to check. Does that change the price much?",
];

export function demoReply(
  scenario: PracticeScenario,
  text: string,
  context: { photoSent: boolean; turn: number },
): { reply: string; askedKeys: string[]; sendPhoto: boolean; mentionsPrice: boolean } {
  const customer = BY_ID[scenario.demoId ?? ''] ?? CUSTOMERS[0];
  const message = text.trim();
  if (PHOTO_REQUEST.test(message))
    return context.photoSent
      ? {
          reply: "That's all the photos I have right now. Anything else you need?",
          askedKeys: [],
          sendPhoto: false,
          mentionsPrice: false,
        }
      : { reply: scenario.extraPhoto.text, askedKeys: [], sendPhoto: true, mentionsPrice: false };
  const matches = scenario.facts.filter((fact) => PATTERNS[fact.key]?.test(message));
  if (!matches.length && PRICE_MENTION.test(message))
    return { reply: customer.priceNudge, askedKeys: [], sendPhoto: false, mentionsPrice: true };
  if (matches.length) {
    const answered = matches.slice(0, 2);
    return {
      reply: answered.map((fact) => fact.answer).join(' '),
      askedKeys: answered.map((fact) => fact.key),
      sendPhoto: false,
      mentionsPrice: false,
    };
  }
  if (SMALL_TALK.test(message) && message.length < 40)
    return {
      reply: 'Of course! Ask me anything about the job.',
      askedKeys: [],
      sendPhoto: false,
      mentionsPrice: false,
    };
  return {
    reply: NOT_SURE[context.turn % NOT_SURE.length],
    askedKeys: [],
    sendPhoto: false,
    mentionsPrice: false,
  };
}

export function sqFt(text: string): number | null {
  const match = text
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*f(?:ee|oo)t|sf)\b/i);
  return match ? Number(match[1]) : null;
}

const round5 = (cents: number) => Math.max(0, Math.round(cents / 500) * 500);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

type PriorQuote = {
  scenario: PracticeScenario;
  lines: QuoteLine[];
  discount: { kind: string; value: number } | null;
};

/** The prototype's stand-in for the AI's guess: a rate per square foot plus learned add-ons. */
export function demoDraftQuote(input: {
  scenario: PracticeScenario;
  jobs: { priceCents: number; size: string; description: string }[];
  prior: PriorQuote[];
}): DraftedQuote {
  const customer = BY_ID[input.scenario.demoId ?? ''] ?? CUSTOMERS[0];
  const fromPractice = input.prior.flatMap((item) => {
    const area = BY_ID[item.scenario.demoId ?? '']?.areaSqFt;
    return area && item.lines[0] ? [item.lines[0].amountCents / area] : [];
  });
  const fromJobs = input.jobs.flatMap((job) => {
    const area = sqFt(job.size) ?? sqFt(job.description);
    return area ? [job.priceCents / area] : [];
  });
  const rate = fromPractice.length
    ? fromPractice.reduce((sum, value) => sum + value, 0) / fromPractice.length
    : fromJobs.length
      ? median(fromJobs)
      : 45;
  const lines = [
    { label: input.scenario.suggestions[0], amountCents: round5(rate * customer.areaSqFt) },
  ];
  for (const addOn of customer.addOns) {
    const earlier = [...input.prior]
      .reverse()
      .flatMap((item) => item.lines.slice(1))
      .find((line) => addOn.pattern.test(line.label));
    lines.push({
      label: input.scenario.suggestions.find((label) => addOn.pattern.test(label)) ?? 'Add-on',
      amountCents: earlier?.amountCents ?? addOn.typicalCents,
    });
  }
  const percentOff =
    customer.id === 'marcus'
      ? [...input.prior].reverse().find((item) => item.discount?.kind === 'percent')?.discount
          ?.value
      : undefined;
  return {
    decision: customer.siteVisitLikely ? 'site_visit' : 'quote',
    reason: customer.siteVisitLikely ? `the ${customer.siteVisitCue}` : '',
    lines,
    discount: percentOff
      ? { kind: 'percent', value: percentOff, reason: 'Neighbor discount' }
      : null,
    start: 'Next week',
    duration: '',
    confidence: fromPractice.length || fromJobs.length ? 'medium' : 'low',
    reasoning: 'Demo mode: a rate per square foot from your jobs and practice quotes.',
  };
}

/** "Charges about $0.51 per sq ft for patios", when the size is known. */
export function demoRateLine(scenario: PracticeScenario, mainCents: number): string {
  const customer = BY_ID[scenario.demoId ?? ''];
  if (!customer) return '';
  const perFoot = mainCents / customer.areaSqFt / 100;
  return `Charges about $${perFoot.toFixed(2)} per sq ft for ${customer.kindLabel}`;
}
