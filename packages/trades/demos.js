/**
 * Sample businesses for the public demo, one for every trade: the home page and /demo show them,
 * and the API prices demo chats from them, so a visitor can't change the business or its prices.
 * Prices are integer cents.
 */
export const DEMOS = [
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
    photos: {
      services: ['Driveways'],
      items: [
        {
          key: 'pressure-washing-wide',
          caption:
            'A two-car concrete driveway in front of the garage, grey with grime, with tire tracks and green algae along the edges.',
        },
        {
          key: 'pressure-washing-detail',
          caption:
            'A large dark oil stain and a few smaller drip stains on the concrete by the garage door.',
        },
      ],
      shows: {
        answer: 'Yes, treat them',
        reply: 'I can see the oil stain by the garage, so I’ll include a pre-treatment for it.',
      },
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
    photos: {
      services: ['Exterior windows'],
      items: [
        {
          key: 'window-cleaning-wide',
          caption:
            'The front of a two-story house with about 20 windows, the glass dull and dusty.',
        },
        {
          key: 'window-cleaning-detail',
          caption: 'An upstairs window up close, with hard-water spots and grime on the glass.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply:
          'I can see a lot of them are upstairs, so I’ll include the ladder work for the second story.',
      },
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
    photos: {
      services: ['Gutter clean-out', 'Downspout flush'],
      items: [
        {
          key: 'gutters-wide',
          caption:
            'The gutter along the roof of a two-story house, packed with wet leaves, with small weeds growing out of it.',
        },
        {
          key: 'gutters-detail',
          caption:
            'A downspout at the corner of the house with a muddy puddle and washed-out soil at its base.',
        },
      ],
      shows: {
        answer: 'Yes, a couple',
        reply:
          'I can see water pooling at that downspout, so I’ll include flushing the downspouts.',
      },
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
    photos: {
      services: ['Deep clean', 'Standard clean', 'Move-out clean'],
      items: [
        {
          key: 'house-cleaning-wide',
          caption:
            'A kitchen with dark counters, a gas range, a stainless fridge and small appliances out on the counters.',
        },
        {
          key: 'house-cleaning-detail',
          caption:
            'The inside of the oven, with heavy baked-on grease and burnt spots on the bottom and the door.',
        },
      ],
      shows: {
        answer: 'Yes, both',
        reply:
          'I can see the oven needs a proper clean, so I’ll include the inside of the oven and fridge.',
      },
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
    photos: {
      services: ['Carpet', 'Stain removal'],
      items: [
        {
          key: 'carpet-wide',
          caption:
            'A living room with light beige carpet and a dark worn path from the doorway to the couch.',
        },
        {
          key: 'carpet-detail',
          caption: 'A yellowish pet stain on the carpet right next to a dog bed.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see you have a dog, so I’ll include a pet odor treatment.',
      },
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
    photos: {
      services: ['Mowing'],
      items: [
        {
          key: 'lawn-wide',
          caption:
            'A fenced backyard with overgrown grass, ankle to shin high, with weeds mixed in.',
        },
        {
          key: 'lawn-detail',
          caption: 'Tall grass growing over the edge of the patio and along the fence line.',
        },
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
    photos: {
      services: ['Mulch & beds', 'Seasonal cleanup', 'Planting'],
      items: [
        {
          key: 'landscaping-wide',
          caption:
            'A front-yard garden bed along the house, overgrown with weeds, with thin faded mulch and bare patches.',
        },
        {
          key: 'landscaping-detail',
          caption:
            'A dead brown shrub in the bed, and a pile of old branches and pulled weeds on the lawn.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply:
          'I can see the dead shrub and that pile of branches, so I’ll include hauling them away.',
      },
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
    photos: {
      services: ['Trimming', 'Removal'],
      items: [
        {
          key: 'trees-wide',
          caption:
            'A large oak, about 45 feet tall, with long branches spreading over the roof of a one-story house.',
        },
        {
          key: 'trees-detail',
          caption: 'A thick dead branch with no leaves hanging over the roof.',
        },
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
    photos: {
      services: ['Interior'],
      items: [
        {
          key: 'painting-wide',
          caption:
            'A living room with beige walls, showing scuffs and faded patches where pictures used to hang.',
        },
        {
          key: 'painting-detail',
          caption: 'A wall up close, with several small nail holes and a few dings.',
        },
      ],
      shows: {
        answer: 'A few nail holes',
        reply:
          'I can see a few nail holes, so I’ll include patching and sanding them before we paint.',
      },
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
    photos: {
      services: ['Repairs', 'Drywall'],
      items: [
        {
          key: 'handyman-wide',
          caption:
            'A hallway where the door handle has punched a hole in the drywall behind the door.',
        },
        {
          key: 'handyman-detail',
          caption: 'A doorknob-sized hole in the drywall, with crumbling edges and torn paper.',
        },
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
    photos: {
      services: ['Garage cleanouts'],
      items: [
        {
          key: 'junk-wide',
          caption:
            'A two-car garage packed with boxes, old furniture, a bike and bags, with barely a path through it.',
        },
        {
          key: 'junk-detail',
          caption: 'An old stained mattress leaning on the wall next to a broken washing machine.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see the mattress and the washer, so I’ll include disposing of those.',
      },
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
    photos: {
      services: ['Local moves', 'Packing', 'Loading only'],
      items: [
        {
          key: 'moving-wide',
          caption:
            'An apartment living room partway through packing, with stacked moving boxes, a rolled-up rug and a couch.',
        },
        { key: 'moving-detail', caption: 'A long, narrow carpeted staircase up to the apartment.' },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see the stairs up to your place, so I’ll include those in the quote.',
      },
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
    photos: {
      services: ['New fence'],
      items: [
        {
          key: 'fencing-wide',
          caption:
            'An old grey wooden privacy fence along the backyard, leaning, with cracked and loose boards.',
        },
        { key: 'fencing-detail', caption: 'A fence post rotted through at the ground.' },
      ],
      shows: {
        answer: 'Yes',
        reply:
          'I can see the old fence is on its way out, so I’ll include tearing it out and hauling it away.',
      },
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
    photos: {
      services: ['Deck repair', 'Staining & sealing'],
      items: [
        {
          key: 'decks-wide',
          caption:
            'A weathered grey wooden deck off the back of the house, with the old stain worn off and peeling.',
        },
        {
          key: 'decks-detail',
          caption:
            'A deck board cracked and soft with rot near a screw, next to boards with peeling stain.',
        },
      ],
      shows: {
        answer: 'A few',
        reply: 'I can see rot in at least one board, so I’ll include replacing the damaged boards.',
      },
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
    photos: {
      services: ['Repairs', 'Inspections'],
      items: [
        {
          key: 'roofing-wide',
          caption: 'An asphalt shingle roof with several shingles missing near the ridge.',
        },
        {
          key: 'roofing-detail',
          caption: 'A brown water stain on a bedroom ceiling, near the corner.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply:
          'That ceiling stain looks like an active leak, so I’ll include a temporary patch to stop it.',
      },
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
    photos: {
      services: ['Vinyl plank', 'Tile', 'Hardwood'],
      items: [
        {
          key: 'flooring-wide',
          caption: 'A kitchen with old, worn beige vinyl flooring and oak cabinets.',
        },
        {
          key: 'flooring-detail',
          caption: 'The old floor peeling up and cracked along a seam by the cabinets.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply:
          'I can see the old floor that has to come up, so I’ll include removing and disposing of it.',
      },
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
    photos: {
      services: ['Service calls', 'Tune-ups'],
      items: [
        {
          key: 'hvac-wide',
          caption:
            'A central air conditioner outside a brick house, with grass clippings and leaves stuck to its fins.',
        },
        {
          key: 'hvac-detail',
          caption: 'A gas furnace in a utility closet, with a dirty air filter leaning next to it.',
        },
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
    photos: {
      services: ['Service calls', 'Drains'],
      items: [
        {
          key: 'plumbing-wide',
          caption: 'The cabinet under a kitchen sink, with a bucket under the drain pipe.',
        },
        {
          key: 'plumbing-detail',
          caption:
            'Water dripping from a joint in the drain pipe under the sink, and a water stain on the cabinet floor.',
        },
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
    photos: {
      services: ['Panels', 'Service calls'],
      items: [
        {
          key: 'electrical-wide',
          caption: 'An old grey electrical panel on an unfinished garage wall.',
        },
        {
          key: 'electrical-detail',
          caption: 'Inside the panel: rows of older breakers, worn and dusty.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'That panel looks like it’s been there a while, so I’ll include a safety check.',
      },
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
    photos: {
      services: ['Green-to-clean', 'Weekly service'],
      items: [
        {
          key: 'pools-wide',
          caption: 'A backyard pool with cloudy green water and leaves floating in it.',
        },
        {
          key: 'pools-detail',
          caption: 'A raised spa attached to the pool, also green, with leaves in it.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see the spa attached to the pool, so I’ll include it.',
      },
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
    photos: {
      services: ['General pests'],
      items: [
        {
          key: 'pest-wide',
          caption: 'A kitchen with tile floors, and a dog’s food and water bowls by the counter.',
        },
        {
          key: 'pest-detail',
          caption: 'A trail of small ants along the kitchen windowsill and onto the counter.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see you have a dog, so I’ll use pet- and kid-safe products.',
      },
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
    photos: {
      services: ['Interior detail', 'Full detail'],
      items: [
        {
          key: 'detailing-wide',
          caption:
            'The back seat of a car with grey cloth seats, covered in dog hair, with a blanket and crumbs.',
        },
        { key: 'detailing-detail', caption: 'A large coffee stain soaked into a grey cloth seat.' },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see the dog hair and that stain, so I’ll include pet hair and stain removal.',
      },
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
    photos: {
      services: ['Portraits'],
      items: [
        {
          key: 'photography-wide',
          caption:
            'A backyard in late afternoon light, with a big shade tree, a lawn and flower beds.',
        },
        {
          key: 'photography-detail',
          caption: 'A wooden bench under string lights, beside a flowering bush.',
        },
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
    photos: {
      services: ['Rentals', 'Planning', 'Catering', 'DJ'],
      items: [
        {
          key: 'events-wide',
          caption: 'A big backyard lawn with string lights hung between the trees.',
        },
        {
          key: 'events-detail',
          caption: 'A brick patio by the house, with folding tables stacked against the wall.',
        },
      ],
      shows: {
        answer: 'Yes',
        reply: 'I can see it’s out on the lawn, so I’ll include the outdoor setup.',
      },
    },
    start: 'Next month',
    duration: '5 hours',
    included: ['Setup and teardown', 'Day-of coordinator'],
    excluded: ['Venue fees'],
  },
];

export const DEMOS_BY_TRADE = Object.fromEntries(DEMOS.map((demo) => [demo.tradeId, demo]));
