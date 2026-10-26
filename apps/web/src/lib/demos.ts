import type { Quote, QuoteLine } from './quote';
import { round5 } from './util';

/**
 * Sample businesses for the home page and /demo, one for every trade. The demo runs entirely in
 * the browser from this data: no AI, no network, and nothing the visitor types is kept.
 */
export interface DemoOption {
  label: string;
  /** Scales the service's base price. */
  factor: number;
  /** How the answer reads on the quote line, after the service: "Move-out clean, 3 bedrooms". */
  line: string;
}

export interface DemoExtra {
  label: string;
  /** A line this answer adds to the quote. None means it adds nothing. */
  add?: { label: string; amountCents: number };
}

/** A quote a customer already accepted, for the rotating example at the top of the home page. */
export interface HeroExample {
  number: number;
  customer: { name: string; place: string; initials: string; tone: 'canary' | 'pink' | 'blue' };
  request: string;
  facts: string[];
  /** Bundled photo keys, for the trades that have sample photos. */
  photos?: ('patio-overview' | 'patio-stains')[];
  lines: { label: string; amountCents: number }[];
}

export interface Demo {
  tradeId: string;
  business: string;
  owner: string;
  area: string;
  /** Base price for each of the trade's services, for the middle answer to the size question. */
  prices: Record<string, number>;
  size: { ask: string; options: DemoOption[] };
  extra?: { ask: string; options: DemoExtra[] };
  start: string;
  duration: string;
  included: string[];
  excluded: string[];
  hero?: HeroExample;
}

export const DEMOS: Demo[] = [
  {
    tradeId: 'pressure-washing',
    business: 'Moss & Stone Exterior Care',
    owner: 'Maya',
    area: 'Portland, OR',
    prices: {
      Driveways: 22000,
      'House wash': 38000,
      'Patios & pavers': 25000,
      'Decks & fences': 30000,
      'Roof soft wash': 55000,
      'Commercial flatwork': 60000,
    },
    size: {
      ask: 'About how big is the area? A rough guess is fine.',
      options: [
        { label: 'Under 300 sq ft', factor: 0.7, line: 'under 300 sq ft' },
        { label: '300 to 700 sq ft', factor: 1, line: 'about 500 sq ft' },
        { label: 'Over 700 sq ft', factor: 1.5, line: 'about 900 sq ft' },
        { label: 'Not sure', factor: 1, line: 'size confirmed on arrival' },
      ],
    },
    extra: {
      ask: 'Any oil, rust or dark stains you want treated?',
      options: [
        { label: 'Yes, treat them', add: { label: 'Stain pre-treatment', amountCents: 4500 } },
        { label: 'No, just clean it' },
      ],
    },
    start: 'Next week',
    duration: '3 hours',
    included: ['Hot-water surface clean', 'Rinse of nearby walls and windows'],
    excluded: ['Sealing'],
    hero: {
      number: 1038,
      customer: { name: 'Dana R.', place: 'Eastgate', initials: 'DR', tone: 'canary' },
      request:
        'Hi! We’re listing the house soon. Could you give me a price to pressure wash the back patio?',
      facts: ['About 550 sq ft', 'Dark stains by the door'],
      photos: ['patio-overview', 'patio-stains'],
      lines: [
        { label: 'Patio wash, about 550 sq ft', amountCents: 28000 },
        { label: 'Stain pre-treatment', amountCents: 4500 },
      ],
    },
  },
  {
    tradeId: 'window-cleaning',
    business: 'Clearview Window Co.',
    owner: 'Ben',
    area: 'Boise, ID',
    prices: {
      'Exterior windows': 18000,
      'Interior windows': 15000,
      'Screens & tracks': 9000,
      Skylights: 12000,
      Storefronts: 14000,
    },
    size: {
      ask: 'About how many windows?',
      options: [
        { label: 'Up to 15', factor: 0.65, line: 'up to 15 windows' },
        { label: '15 to 30', factor: 1, line: 'about 24 windows' },
        { label: '30 or more', factor: 1.5, line: 'about 36 windows' },
        { label: 'Not sure', factor: 1, line: 'count confirmed on arrival' },
      ],
    },
    extra: {
      ask: 'Are any of them on a second story?',
      options: [
        { label: 'Yes', add: { label: 'Second-story ladder work', amountCents: 4000 } },
        { label: 'No, all ground floor' },
      ],
    },
    start: 'This week',
    duration: '4 hours',
    included: ['Squeegee clean', 'Sills and frames wiped'],
    excluded: ['Hard water stain removal'],
  },
  {
    tradeId: 'gutters',
    business: 'Highline Gutter Care',
    owner: 'Tom',
    area: 'Columbus, OH',
    prices: {
      'Gutter clean-out': 17500,
      'Downspout flush': 7500,
      'Gutter guards': 120000,
      'Gutter brightening': 22000,
    },
    size: {
      ask: 'How tall is the house?',
      options: [
        { label: 'One story', factor: 0.8, line: 'one-story house' },
        { label: 'Two stories', factor: 1.2, line: 'two-story house' },
        { label: 'Three or more', factor: 1.6, line: 'three-story house' },
      ],
    },
    extra: {
      ask: 'Do any downspouts back up when it rains?',
      options: [
        {
          label: 'Yes, a couple',
          add: { label: 'Downspout flush, 2 downspouts', amountCents: 5000 },
        },
        { label: 'No' },
      ],
    },
    start: 'Next week',
    duration: '2 hours',
    included: ['Debris bagged and hauled away', 'Downspouts checked'],
    excluded: ['Gutter repairs'],
  },
  {
    tradeId: 'house-cleaning',
    business: 'Brightside Cleaning Co.',
    owner: 'Rosa',
    area: 'Austin, TX',
    prices: {
      'Standard clean': 16000,
      'Deep clean': 28000,
      'Move-out clean': 34000,
      'Recurring visits': 14000,
    },
    size: {
      ask: 'How big is the home?',
      options: [
        { label: '1–2 bedrooms', factor: 0.75, line: '1–2 bedrooms' },
        { label: '3 bedrooms', factor: 1, line: '3 bedrooms' },
        { label: '4 or more', factor: 1.35, line: '4+ bedrooms' },
      ],
    },
    extra: {
      ask: 'Want the inside of the oven and fridge done too?',
      options: [
        { label: 'Yes, both', add: { label: 'Inside oven and fridge', amountCents: 6000 } },
        { label: 'No thanks' },
      ],
    },
    start: 'This week',
    duration: '5 hours',
    included: ['Kitchen, baths and every room', 'Baseboards and inside cabinets'],
    excluded: ['Outside windows', 'Carpet shampoo'],
    hero: {
      number: 2114,
      customer: { name: 'Priya S.', place: 'Westlake', initials: 'PS', tone: 'pink' },
      request:
        'Hi! We move out on the 30th. Could I get a price for a move-out clean? 3 bed, 2 bath.',
      facts: ['3 bed, 2 bath', 'About 1,800 sq ft', 'Empty by the 28th'],
      lines: [
        { label: 'Move-out clean, 3 bed 2 bath', amountCents: 34000 },
        { label: 'Inside oven and fridge', amountCents: 6000 },
      ],
    },
  },
  {
    tradeId: 'carpet',
    business: 'FreshStep Carpet Care',
    owner: 'Dev',
    area: 'Raleigh, NC',
    prices: { Carpet: 22000, Upholstery: 15000, 'Area rugs': 9000, 'Stain removal': 8000 },
    size: {
      ask: 'How many rooms?',
      options: [
        { label: '1–2 rooms', factor: 0.6, line: '2 rooms' },
        { label: '3–4 rooms', factor: 1, line: '4 rooms' },
        { label: '5 or more', factor: 1.5, line: '6 rooms' },
      ],
    },
    extra: {
      ask: 'Any pets in the home?',
      options: [
        { label: 'Yes', add: { label: 'Pet odor treatment', amountCents: 4500 } },
        { label: 'No pets' },
      ],
    },
    start: 'Next week',
    duration: '3 hours',
    included: ['Hot-water extraction', 'Pre-spray on high-traffic areas'],
    excluded: ['Moving heavy furniture'],
  },
  {
    tradeId: 'lawn',
    business: 'Greenline Lawn Care',
    owner: 'Luis',
    area: 'Charlotte, NC',
    prices: { Mowing: 5500, Fertilizing: 8500, Aeration: 14000, 'Leaf cleanup': 22000 },
    size: {
      ask: 'About how big is the yard?',
      options: [
        { label: 'Under ¼ acre', factor: 0.8, line: 'under ¼ acre' },
        { label: 'About ¼ acre', factor: 1, line: 'about ¼ acre' },
        { label: '½ acre or more', factor: 1.8, line: 'about ½ acre' },
      ],
    },
    extra: {
      ask: 'Want the edges trimmed and the clippings bagged?',
      options: [
        { label: 'Yes, please', add: { label: 'Edging and bagging', amountCents: 2000 } },
        { label: 'Just the main job' },
      ],
    },
    start: 'This week',
    duration: '1 hour',
    included: ['Walks and driveway blown off'],
    excluded: ['Weed control'],
    hero: {
      number: 3307,
      customer: { name: 'Mark T.', place: 'Brookside', initials: 'MT', tone: 'blue' },
      request:
        'Hi! Can you do a spring cleanup and then mow every week? Corner lot, front and back.',
      facts: ['About ¼ acre', 'Front and back', 'Weekly after'],
      lines: [
        { label: 'Spring cleanup, about ¼ acre', amountCents: 18000 },
        { label: 'First mow, edge and blow', amountCents: 5500 },
      ],
    },
  },
  {
    tradeId: 'landscaping',
    business: 'Fernwood Landscapes',
    owner: 'Claire',
    area: 'Denver, CO',
    prices: {
      Planting: 45000,
      'Mulch & beds': 38000,
      Hardscape: 420000,
      Irrigation: 160000,
      'Seasonal cleanup': 30000,
    },
    size: {
      ask: 'How big is the area?',
      options: [
        { label: 'A bed or two', factor: 0.6, line: 'a bed or two' },
        { label: 'Front or back yard', factor: 1, line: 'one yard' },
        { label: 'The whole property', factor: 2, line: 'whole property' },
      ],
    },
    extra: {
      ask: 'Should we haul away the old plants and debris?',
      options: [
        { label: 'Yes', add: { label: 'Haul-away of old plants and debris', amountCents: 9500 } },
        { label: 'No, leave it' },
      ],
    },
    start: 'In 2 weeks',
    duration: '1 day',
    included: ['Materials and labor', 'Cleanup at the end of each day'],
    excluded: ['Permits', 'Tree work'],
  },
  {
    tradeId: 'trees',
    business: 'Summit Tree Service',
    owner: 'Jake',
    area: 'Knoxville, TN',
    prices: { Trimming: 55000, Removal: 140000, 'Stump grinding': 25000, 'Storm cleanup': 80000 },
    size: {
      ask: 'About how tall is the tree?',
      options: [
        { label: 'Under 25 ft', factor: 0.6, line: 'under 25 ft' },
        { label: '25 to 50 ft', factor: 1, line: 'about 40 ft' },
        { label: 'Over 50 ft', factor: 1.8, line: 'over 50 ft' },
      ],
    },
    extra: {
      ask: 'Want the wood hauled away?',
      options: [
        {
          label: 'Yes, haul it',
          add: { label: 'Haul-away of wood and branches', amountCents: 18000 },
        },
        { label: 'Leave it for firewood' },
      ],
    },
    start: 'Next week',
    duration: '1 day',
    included: ['Climber and ground crew', 'Lawn raked after'],
    excluded: ['Permits, if the city requires one'],
  },
  {
    tradeId: 'painting',
    business: 'True Coat Painting',
    owner: 'Sam',
    area: 'Chicago, IL',
    prices: { Interior: 120000, Exterior: 450000, Cabinets: 380000, 'Decks & fences': 90000 },
    size: {
      ask: 'How much are we painting?',
      options: [
        { label: 'One room', factor: 0.45, line: 'one room' },
        { label: '2–3 rooms', factor: 1, line: '2–3 rooms' },
        { label: 'Most of the house', factor: 2.4, line: 'most of the house' },
      ],
    },
    extra: {
      ask: 'Any patching needed before we paint?',
      options: [
        { label: 'A few nail holes', add: { label: 'Patch and sand', amountCents: 12000 } },
        { label: 'Some bigger repairs', add: { label: 'Drywall repair', amountCents: 30000 } },
        { label: 'No, walls are good' },
      ],
    },
    start: 'In 2 weeks',
    duration: '2 days',
    included: ['Two coats', 'Furniture moved and covered', 'Daily cleanup'],
    excluded: ['Ceilings', 'Trim, unless listed'],
    hero: {
      number: 4021,
      customer: { name: 'Jenna L.', place: 'Oak Park', initials: 'JL', tone: 'pink' },
      request: 'Hi! We’d like the living room and hallway painted. Walls only, same color family.',
      facts: ['About 450 sq ft of wall', '9 ft ceilings', 'Light gray now'],
      lines: [
        { label: 'Living room and hallway walls, 2 coats', amountCents: 115000 },
        { label: 'Patch and sand nail holes', amountCents: 12000 },
      ],
    },
  },
  {
    tradeId: 'handyman',
    business: 'Benchmark Home Repair',
    owner: 'Ray',
    area: 'Sacramento, CA',
    prices: { Repairs: 18000, 'Mounting & assembly': 12000, Drywall: 22000, 'Doors & trim': 26000 },
    size: {
      ask: 'How big is the job?',
      options: [
        { label: 'Under an hour', factor: 0.6, line: 'under an hour' },
        { label: 'A few hours', factor: 1, line: 'about 3 hours' },
        { label: 'A full day', factor: 2.2, line: 'about a day' },
      ],
    },
    extra: {
      ask: 'Do you need us to pick up the materials?',
      options: [
        { label: 'Yes, please', add: { label: 'Materials pickup', amountCents: 3500 } },
        { label: 'I have everything' },
      ],
    },
    start: 'This week',
    duration: '3 hours',
    included: ['Labor and basic hardware', 'Cleanup'],
    excluded: ['Materials over $50', 'Electrical and plumbing'],
  },
  {
    tradeId: 'junk',
    business: 'Clean Sweep Junk Removal',
    owner: 'Marcus',
    area: 'Phoenix, AZ',
    prices: {
      'Single items': 9500,
      'Garage cleanouts': 39500,
      'Estate cleanouts': 120000,
      'Construction debris': 45000,
    },
    size: {
      ask: 'About how much is there?',
      options: [
        { label: 'A few items', factor: 0.35, line: 'a few items' },
        { label: 'Half a truck', factor: 1, line: 'about half a truck' },
        { label: 'A full truck', factor: 1.8, line: 'about a full truck' },
      ],
    },
    extra: {
      ask: 'Any appliances or mattresses?',
      options: [
        { label: 'Yes', add: { label: 'Appliance or mattress disposal', amountCents: 4500 } },
        { label: 'No' },
      ],
    },
    start: 'This week',
    duration: '2 hours',
    included: ['Loading and hauling', 'Donation drop-off where we can', 'Sweep-out'],
    excluded: ['Paint and hazardous waste'],
    hero: {
      number: 5189,
      customer: { name: 'Ellen W.', place: 'Riverside', initials: 'EW', tone: 'canary' },
      request: 'Hi! I’m clearing out my mom’s garage. Old furniture, boxes and a broken freezer.',
      facts: ['About half a truck', 'Ground-level garage', '1 appliance'],
      lines: [
        { label: 'Garage cleanout, about half a truck', amountCents: 39500 },
        { label: 'Freezer disposal', amountCents: 4500 },
      ],
    },
  },
  {
    tradeId: 'moving',
    business: 'Steady Hands Moving',
    owner: 'Andre',
    area: 'Atlanta, GA',
    prices: {
      'Local moves': 95000,
      Packing: 45000,
      'Loading only': 38000,
      'Specialty items': 30000,
    },
    size: {
      ask: 'How big is the move?',
      options: [
        { label: 'Studio or 1 bedroom', factor: 0.6, line: '1 bedroom' },
        { label: '2–3 bedrooms', factor: 1, line: '2–3 bedrooms' },
        { label: '4 or more', factor: 1.6, line: '4+ bedrooms' },
      ],
    },
    extra: {
      ask: 'Any stairs at either end?',
      options: [
        { label: 'Yes', add: { label: 'Stairs, 2 flights', amountCents: 9000 } },
        { label: 'No stairs' },
      ],
    },
    start: 'In 2 weeks',
    duration: '6 hours',
    included: ['3 movers and a 26 ft truck', 'Blankets and wrapping'],
    excluded: ['Boxes and packing supplies'],
  },
  {
    tradeId: 'fencing',
    business: 'Straight Line Fence Co.',
    owner: 'Dale',
    area: 'Tulsa, OK',
    prices: { 'New fence': 420000, Repairs: 45000, Gates: 85000, Staining: 90000 },
    size: {
      ask: 'About how many feet of fence?',
      options: [
        { label: 'Under 50 ft', factor: 0.4, line: 'under 50 ft' },
        { label: '50 to 150 ft', factor: 1, line: 'about 120 ft' },
        { label: 'Over 150 ft', factor: 1.8, line: 'about 200 ft' },
      ],
    },
    extra: {
      ask: 'Should we tear out and haul away an old fence?',
      options: [
        { label: 'Yes', add: { label: 'Old fence tear-out and haul-away', amountCents: 60000 } },
        { label: 'No old fence' },
      ],
    },
    start: 'In 2 weeks',
    duration: '2 days',
    included: ['Posts set in concrete', 'Cleanup'],
    excluded: ['Permits', 'Property survey'],
  },
  {
    tradeId: 'decks',
    business: 'Deckhand Builders',
    owner: 'Kim',
    area: 'Minneapolis, MN',
    prices: {
      'New decks': 1200000,
      'Deck repair': 90000,
      Pavers: 650000,
      'Staining & sealing': 85000,
    },
    size: {
      ask: 'How big is it?',
      options: [
        { label: 'Under 150 sq ft', factor: 0.6, line: 'under 150 sq ft' },
        { label: '150 to 300 sq ft', factor: 1, line: 'about 250 sq ft' },
        { label: 'Over 300 sq ft', factor: 1.6, line: 'about 400 sq ft' },
      ],
    },
    extra: {
      ask: 'Any boards that need replacing?',
      options: [
        { label: 'A few', add: { label: 'Replace damaged boards', amountCents: 25000 } },
        { label: 'No, they’re solid' },
      ],
    },
    start: 'In 2 weeks',
    duration: '2 days',
    included: ['Materials', 'Cleanup and haul-away'],
    excluded: ['Permits'],
  },
  {
    tradeId: 'roofing',
    business: 'Keystone Roofing',
    owner: 'Nate',
    area: 'Omaha, NE',
    prices: { Repairs: 65000, Replacement: 1450000, Inspections: 25000, Gutters: 120000 },
    size: {
      ask: 'How big is the house?',
      options: [
        { label: 'Under 1,500 sq ft', factor: 0.7, line: 'under 1,500 sq ft' },
        { label: '1,500 to 2,500 sq ft', factor: 1, line: 'about 2,000 sq ft' },
        { label: 'Over 2,500 sq ft', factor: 1.5, line: 'about 3,000 sq ft' },
      ],
    },
    extra: {
      ask: 'Is it leaking right now?',
      options: [
        { label: 'Yes', add: { label: 'Temporary leak patch', amountCents: 15000 } },
        { label: 'No leaks' },
      ],
    },
    start: 'Next week',
    duration: '1 day',
    included: ['Old material hauled away', 'Magnet sweep for nails'],
    excluded: ['Rotten decking, priced per sheet'],
  },
  {
    tradeId: 'flooring',
    business: 'Groundwork Flooring',
    owner: 'Elena',
    area: 'San Antonio, TX',
    prices: { Hardwood: 650000, Tile: 480000, 'Vinyl plank': 380000, Refinishing: 280000 },
    size: {
      ask: 'About how big is the area?',
      options: [
        { label: 'One room', factor: 0.4, line: 'one room' },
        { label: '2–3 rooms', factor: 1, line: 'about 600 sq ft' },
        { label: 'Most of the house', factor: 2.2, line: 'about 1,400 sq ft' },
      ],
    },
    extra: {
      ask: 'Is there old flooring to take up?',
      options: [
        {
          label: 'Yes',
          add: { label: 'Old floor removal and disposal', amountCents: 75000 },
        },
        { label: 'No' },
      ],
    },
    start: 'In 2 weeks',
    duration: '3 days',
    included: ['Install and transitions', 'Furniture moved'],
    excluded: ['Subfloor repair'],
  },
  {
    tradeId: 'hvac',
    business: 'Comfort Air Heating & Cooling',
    owner: 'Greg',
    area: 'Dallas, TX',
    prices: {
      'Service calls': 12900,
      'Tune-ups': 14900,
      Installs: 780000,
      'Duct cleaning': 45000,
    },
    size: {
      ask: 'What kind of system is it?',
      options: [
        { label: 'Central AC', factor: 1, line: 'central AC' },
        { label: 'Furnace', factor: 1, line: 'furnace' },
        { label: 'Heat pump', factor: 1.2, line: 'heat pump' },
        { label: 'Not sure', factor: 1, line: 'system checked on arrival' },
      ],
    },
    extra: {
      ask: 'Want a tune-up while we’re there?',
      options: [
        { label: 'Yes', add: { label: 'Tune-up', amountCents: 8900 } },
        { label: 'No thanks' },
      ],
    },
    start: 'This week',
    duration: '2 hours',
    included: ['Diagnosis and written findings'],
    excluded: ['Parts, quoted before any repair'],
    hero: {
      number: 6230,
      customer: { name: 'Tom H.', place: 'Lakewood', initials: 'TH', tone: 'blue' },
      request:
        'Hi! Our AC runs but the upstairs won’t cool down. Can someone look at it this week?',
      facts: ['Central AC', 'About 12 years old', 'Upstairs too warm'],
      lines: [
        { label: 'Service call and diagnosis', amountCents: 12900 },
        { label: 'Refrigerant recharge, 2 lbs', amountCents: 24000 },
      ],
    },
  },
  {
    tradeId: 'plumbing',
    business: 'Northside Plumbing',
    owner: 'Will',
    area: 'Milwaukee, WI',
    prices: {
      'Service calls': 14500,
      'Water heaters': 165000,
      Drains: 22500,
      Fixtures: 28000,
    },
    size: {
      ask: 'How soon do you need us?',
      options: [
        { label: 'Today', factor: 1.5, line: 'same day' },
        { label: 'This week', factor: 1, line: 'this week' },
        { label: 'No rush', factor: 0.9, line: 'flexible timing' },
      ],
    },
    extra: {
      ask: 'Anything else we should check while we’re there?',
      options: [
        {
          label: 'Yes, a few things',
          add: { label: 'Check of other fixtures', amountCents: 6500 },
        },
        { label: 'No, just this' },
      ],
    },
    start: 'This week',
    duration: '2 hours',
    included: ['Labor and standard fittings', 'Cleanup'],
    excluded: ['Drywall repair after access'],
  },
  {
    tradeId: 'electrical',
    business: 'Brightwire Electric',
    owner: 'Omar',
    area: 'Tampa, FL',
    prices: { 'Service calls': 13500, Panels: 280000, Lighting: 45000, 'EV chargers': 140000 },
    size: {
      ask: 'How big is the job?',
      options: [
        { label: 'One spot', factor: 0.5, line: 'one location' },
        { label: 'A few rooms', factor: 1, line: 'a few rooms' },
        { label: 'The whole house', factor: 2.5, line: 'whole house' },
      ],
    },
    extra: {
      ask: 'Is the electrical panel more than 30 years old?',
      options: [
        { label: 'Yes', add: { label: 'Panel safety check', amountCents: 9500 } },
        { label: 'No, or not sure' },
      ],
    },
    start: 'Next week',
    duration: '4 hours',
    included: ['Licensed electrician', 'Permit filing'],
    excluded: ['Drywall patching'],
  },
  {
    tradeId: 'pools',
    business: 'Clearwater Pool Co.',
    owner: 'Kyle',
    area: 'Scottsdale, AZ',
    prices: {
      'Weekly service': 16000,
      'Openings & closings': 32000,
      Repairs: 25000,
      'Green-to-clean': 55000,
    },
    size: {
      ask: 'How big is the pool?',
      options: [
        { label: 'Under 15,000 gal', factor: 0.8, line: 'under 15,000 gal' },
        { label: '15,000 to 25,000 gal', factor: 1, line: 'about 20,000 gal' },
        { label: 'Over 25,000 gal', factor: 1.4, line: 'over 25,000 gal' },
      ],
    },
    extra: {
      ask: 'Is there a spa attached?',
      options: [{ label: 'Yes', add: { label: 'Spa', amountCents: 6000 } }, { label: 'No' }],
    },
    start: 'This week',
    duration: '2 hours',
    included: ['Chemicals and balancing', 'Skimming and brushing'],
    excluded: ['Equipment parts'],
  },
  {
    tradeId: 'pest',
    business: 'Guardline Pest Control',
    owner: 'Nina',
    area: 'Orlando, FL',
    prices: { 'General pests': 15000, Termites: 95000, Rodents: 32000, Mosquitoes: 9500 },
    size: {
      ask: 'How big is the home?',
      options: [
        { label: 'Under 1,500 sq ft', factor: 0.85, line: 'under 1,500 sq ft' },
        { label: '1,500 to 3,000 sq ft', factor: 1, line: 'about 2,200 sq ft' },
        { label: 'Over 3,000 sq ft', factor: 1.4, line: 'over 3,000 sq ft' },
      ],
    },
    extra: {
      ask: 'Any pets or kids at home?',
      options: [
        { label: 'Yes', add: { label: 'Pet- and kid-safe products', amountCents: 2500 } },
        { label: 'No' },
      ],
    },
    start: 'This week',
    duration: '1 hour',
    included: ['Inside and outside treatment', 'Free re-treat within 30 days'],
    excluded: ['Structural repairs'],
  },
  {
    tradeId: 'detailing',
    business: 'Mirror Finish Detailing',
    owner: 'Chris',
    area: 'San Diego, CA',
    prices: {
      'Interior detail': 16000,
      'Exterior detail': 14000,
      'Full detail': 26000,
      'Ceramic coating': 90000,
    },
    size: {
      ask: 'What are we detailing?',
      options: [
        { label: 'A car', factor: 1, line: 'car' },
        { label: 'SUV or truck', factor: 1.25, line: 'SUV or truck' },
        { label: 'Van or 3-row', factor: 1.4, line: 'van or 3-row' },
      ],
    },
    extra: {
      ask: 'Any pet hair or heavy stains inside?',
      options: [
        { label: 'Yes', add: { label: 'Pet hair and stain removal', amountCents: 5000 } },
        { label: 'No' },
      ],
    },
    start: 'This week',
    duration: '4 hours',
    included: ['Hand wash and dry', 'Wheels and tires'],
    excluded: ['Paint correction'],
  },
  {
    tradeId: 'photography',
    business: 'Golden Hour Studio',
    owner: 'Ava',
    area: 'Nashville, TN',
    prices: { Portraits: 35000, Events: 120000, 'Real estate': 25000, Headshots: 22500 },
    size: {
      ask: 'How long do you need us?',
      options: [
        { label: 'About an hour', factor: 0.6, line: '1 hour' },
        { label: '2–3 hours', factor: 1, line: '2–3 hours' },
        { label: 'Half a day or more', factor: 1.8, line: 'half day' },
      ],
    },
    extra: {
      ask: 'Would you like prints?',
      options: [
        { label: 'Yes', add: { label: 'Print set, eight 8×10s', amountCents: 12000 } },
        { label: 'Digital is fine' },
      ],
    },
    start: 'Next month',
    duration: '2 hours',
    included: ['Edited photos in an online gallery', 'Personal print rights'],
    excluded: ['Travel over 30 miles'],
  },
  {
    tradeId: 'events',
    business: 'Lantern Events',
    owner: 'Mia',
    area: 'Savannah, GA',
    prices: { Catering: 240000, Rentals: 120000, DJ: 90000, Planning: 180000 },
    size: {
      ask: 'How many guests?',
      options: [
        { label: 'Under 50', factor: 0.5, line: 'under 50 guests' },
        { label: '50 to 120', factor: 1, line: 'about 100 guests' },
        { label: 'Over 120', factor: 1.6, line: 'about 150 guests' },
      ],
    },
    extra: {
      ask: 'Is it outdoors?',
      options: [
        { label: 'Yes', add: { label: 'Outdoor setup', amountCents: 25000 } },
        { label: 'No, indoors' },
      ],
    },
    start: 'Next month',
    duration: '5 hours',
    included: ['Setup and teardown', 'Day-of coordinator'],
    excluded: ['Venue fees'],
  },
];

export const DEMOS_BY_TRADE: Record<string, Demo> = Object.fromEntries(
  DEMOS.map((demo) => [demo.tradeId, demo]),
);

/** The accepted quotes the home page rotates through. */
export const HERO_EXAMPLES = DEMOS.filter((demo): demo is Demo & { hero: HeroExample } =>
  Boolean(demo.hero),
);

/** The hero example as a full quote card. */
export function heroQuote(demo: Demo & { hero: HeroExample }): Quote {
  return {
    number: demo.hero.number,
    customer: demo.hero.customer.name,
    place: demo.hero.customer.place,
    lines: demo.hero.lines.map((line, index) => ({ id: `${demo.tradeId}-${index}`, ...line })),
    discount: null,
    start: demo.start,
    duration: demo.duration,
    included: demo.included,
    excluded: demo.excluded,
    validDays: 14,
    note: '',
    issuedAt: new Date().toISOString(),
  };
}

/** The quote the demo chat ends with, priced from the visitor's answers. */
export function demoQuote(
  demo: Demo,
  answers: { service: string; size: DemoOption; extra?: DemoExtra },
): Quote {
  const base = demo.prices[answers.service] ?? Object.values(demo.prices)[0];
  const lines: QuoteLine[] = [
    {
      id: 'demo-main',
      label: `${answers.service}, ${answers.size.line}`,
      amountCents: Math.max(round5(base * answers.size.factor), 2500),
    },
  ];
  if (answers.extra?.add) lines.push({ id: 'demo-extra', ...answers.extra.add });
  return {
    number: 1001,
    customer: 'You',
    place: demo.area,
    lines,
    discount: null,
    start: demo.start,
    duration: demo.duration,
    included: demo.included,
    excluded: demo.excluded,
    validDays: 14,
    note: '',
    issuedAt: new Date().toISOString(),
  };
}
