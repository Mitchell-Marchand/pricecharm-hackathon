import type { PhotoKey } from '../assets/photos';

export interface Fact {
  key: string;
  pattern: RegExp;
  answer: string;
}

export interface AddOnHint {
  pattern: RegExp;
  typicalCents: number;
}

export interface Scenario {
  id: string;
  customer: string;
  firstName: string;
  initials: string;
  place: string;
  tone: 'canary' | 'pink' | 'blue';
  opener: string;
  photos: PhotoKey[];
  extraPhoto: { photo: PhotoKey; text: string };
  areaSqFt: number;
  kindLabel: string;
  facts: Fact[];
  suggestions: string[];
  addOnHints: AddOnHint[];
  /** The AI expects this one to need a look in person (loose stone, damage). */
  siteVisitLikely: boolean;
  siteVisitCue: string;
  priceNudge: string;
  acceptReply: string;
  siteVisitReply: string;
}

// Shared question patterns. Word boundaries keep "ft" from matching "left" and so on.
const SIZE = /\b(how big|size|sq ?ft|sqft|square|feet|foot|footage|dimensions?|measure\w*|how large|how much (area|space))\b/i;
const SURFACE = /\b(surface|concrete|stones?|flagstones?|pavers?|brick|material|made of|what kind|type of)\b/i;
const STAINS = /\b(stains?|staining|dirty|dirt|mold|mildew|moss|algae|green|black|condition|oil|rust|last (cleaned|washed)|how long|grime|shape)\b/i;
const ACCESS = /\b(water|spigot|hose|faucet|bib|access|gate|get to|get around|park|parking|truck)\b/i;
const TIMING = /\b(when|date|timing|timeline|schedule|deadline|soon|by when|what day|weekend|weekday|week)\b/i;
const FURNITURE = /\b(planters?|pots?|furniture|move|moving|plants?|table|chairs?|grill)\b/i;
const SEAL = /\b(seal|sealer|sealing|sealant|protect\w*|coating)\b/i;
const LOCATION = /\b(where|address|located|location|neighbou?rhood|zip|city|part of town)\b/i;
const DISCOUNT = /\b(discount|neighbou?rs?|deal|cheaper|price break|coupon|promo|together)\b/i;
const DAMAGE = /\b(loose|wobbl\w*|rocks?|rocking|uneven|broken|crack\w*|damage\w*|repair\w*|fix\w*|sink\w*)\b/i;

export const PHOTO_REQUEST =
  /\b(photos?|pictures?|pics?|images?|close[- ]?up|closer|another (shot|angle|look)|show me|send (me )?(a|another|more|one))\b/i;
export const PRICE_MENTION = /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i;
export const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|ok|okay|great|sounds good|cool|perfect)\b/i;

/** How each fact reads in the owner's summary ("Asks about ...") and as a customer question. */
export const FACT_LABELS: Record<string, { short: string; question: string }> = {
  size: { short: 'size', question: 'How big is the area?' },
  surface: { short: 'the surface', question: 'What is the surface made of?' },
  stains: { short: 'how dirty it is', question: 'How dirty is it, and when was it last cleaned?' },
  access: { short: 'water and access', question: 'Is there an outside spigot, and can we get to it easily?' },
  timing: { short: 'timing', question: 'When do you need it done?' },
  furniture: { short: 'what needs moving', question: 'Is there furniture or planters to move?' },
  seal: { short: 'sealing', question: 'Do you want it sealed afterwards?' },
  location: { short: 'location', question: 'Where is the job?' },
  discount: { short: 'neighbor discounts', question: 'Is a neighbor booking the same day?' },
  damage: { short: 'damage', question: 'Is anything loose, cracked or damaged?' },
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'dana',
    customer: 'Dana R.',
    firstName: 'Dana',
    initials: 'DR',
    place: 'Eastgate',
    tone: 'canary',
    opener:
      "Hi! We're listing our house in two weeks and the back patio looks rough. Could you give me a price to pressure wash it? A couple of photos below.",
    photos: ['patio-overview', 'patio-stains'],
    extraPhoto: { photo: 'patio-door', text: "Here's the spot right outside the sliding door. It's the worst part." },
    areaSqFt: 550,
    kindLabel: 'patios',
    facts: [
      {
        key: 'size',
        pattern: SIZE,
        answer: "It's about 18 by 24 feet of concrete, plus the stone section in the middle. Maybe 550 sq ft in total.",
      },
      { key: 'surface', pattern: SURFACE, answer: 'Mostly concrete. The middle part is flagstone set in mortar.' },
      {
        key: 'stains',
        pattern: STAINS,
        answer: "Dark patches everywhere, worst by the door. I don't think it's been cleaned in the six years we've lived here.",
      },
      {
        key: 'access',
        pattern: ACCESS,
        answer: "There's a spigot by the back door, and you can walk around the side of the house. No gate.",
      },
      { key: 'timing', pattern: TIMING, answer: 'Ideally by next Friday. The photographer comes the Monday after.' },
      { key: 'furniture', pattern: FURNITURE, answer: "Just three big planters. They're heavy, but we can help move them." },
      { key: 'seal', pattern: SEAL, answer: "I hadn't thought about sealing. Is it worth it if we're selling?" },
      { key: 'location', pattern: LOCATION, answer: "We're in Eastgate, just off Linden Avenue." },
    ],
    suggestions: ['Patio wash, about 550 sq ft', 'Stain pre-treatment', 'Flagstone joint clean-out', 'Sealer, one coat'],
    addOnHints: [{ pattern: /stain|pre-?treat/i, typicalCents: 4000 }],
    siteVisitLikely: false,
    siteVisitCue: '',
    priceNudge: 'That sounds fair. Could you send it as a quote so I have it in writing for the realtor?',
    acceptReply: 'That works for us, thank you! Could you do next Thursday morning?',
    siteVisitReply: 'Sure. Could you swing by tomorrow afternoon?',
  },
  {
    id: 'marcus',
    customer: 'Marcus T.',
    firstName: 'Marcus',
    initials: 'MT',
    place: 'North Hills',
    tone: 'pink',
    opener:
      'Hey, I need the back patio cleaned before a party on the 14th. My neighbor says you give a discount when two houses on the street book together. Is that still a thing? Pics attached.',
    photos: ['table-patio', 'table-stains'],
    extraPhoto: { photo: 'planters', text: "This is by the planters. It's pretty green there." },
    areaSqFt: 700,
    kindLabel: 'patios',
    facts: [
      { key: 'size', pattern: SIZE, answer: 'Around 700 sq ft. The table area is the biggest part.' },
      { key: 'surface', pattern: SURFACE, answer: 'Concrete, with a strip of flagstone along the edge.' },
      {
        key: 'stains',
        pattern: STAINS,
        answer: 'Dark spots under the table and green by the planters. Last cleaned maybe three years ago.',
      },
      {
        key: 'discount',
        pattern: DISCOUNT,
        answer: 'Yeah, Jen at 412 wants hers done too. She said you took 10% off for both houses last year.',
      },
      {
        key: 'furniture',
        pattern: FURNITURE,
        answer: "A table, six chairs and a bunch of pots. I'll clear the furniture myself.",
      },
      { key: 'access', pattern: ACCESS, answer: 'Hose bib on the side of the house. The gate is 4 feet wide.' },
      { key: 'timing', pattern: TIMING, answer: 'Anytime before the 14th. Weekdays are fine.' },
      { key: 'location', pattern: LOCATION, answer: 'North Hills, near the middle school.' },
      { key: 'seal', pattern: SEAL, answer: 'Not worried about sealing. I just want it clean.' },
    ],
    suggestions: ['Patio wash, about 700 sq ft', 'Planter area detail', 'Move furniture and pots', 'Neighbor discount'],
    addOnHints: [{ pattern: /planter|green|algae|detail/i, typicalCents: 3500 }],
    siteVisitLikely: false,
    siteVisitCue: '',
    priceNudge: 'Works for me. Can you send it over as a quote? I want to show Jen.',
    acceptReply: "Perfect. I'll tell Jen to book too. Thanks!",
    siteVisitReply: "Hmm, okay. Can you come by this week? The party's coming up fast.",
  },
  {
    id: 'priya',
    customer: 'Priya S.',
    firstName: 'Priya',
    initials: 'PS',
    place: 'Old Town',
    tone: 'blue',
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
      {
        key: 'size',
        pattern: SIZE,
        answer:
          "The patio is about 12 by 16, and there's a walkway maybe 40 feet long and 3 feet wide. So 300-something sq ft?",
      },
      { key: 'surface', pattern: SURFACE, answer: 'Flagstone. Some is set in mortar and some just sits in sand, I think.' },
      {
        key: 'damage',
        pattern: DAMAGE,
        answer: 'Five or six stones, maybe. One has a crack across it, and the mortar around them is crumbling.',
      },
      { key: 'stains', pattern: STAINS, answer: "Black and green all over, mostly where it's shady." },
      { key: 'seal', pattern: SEAL, answer: "We'd like it sealed if it makes sense. Something that won't get slippery." },
      { key: 'access', pattern: ACCESS, answer: "The side gate is narrow, about 30 inches. The spigot's on the back wall." },
      { key: 'timing', pattern: TIMING, answer: 'No rush. Sometime this month would be nice.' },
      { key: 'location', pattern: LOCATION, answer: 'Old Town, two blocks from the river.' },
    ],
    suggestions: ['Flagstone wash, about 350 sq ft', 'Reset loose stones', 'Repoint mortar joints', 'Sealer, two coats'],
    addOnHints: [
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

export const SCENARIOS_BY_ID = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, scenario])) as Record<
  string,
  Scenario
>;

export const PRACTICE_COUNT = SCENARIOS.length;
