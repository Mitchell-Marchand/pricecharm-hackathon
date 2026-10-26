import type { LucideIcon } from 'lucide-react';
import {
  BrickWall,
  Bug,
  Camera,
  Car,
  Droplets,
  Fan,
  Fence,
  Grid2x2,
  Hammer,
  HardHat,
  House,
  Layers,
  PaintRoller,
  PartyPopper,
  ShowerHead,
  Sofa,
  SprayCan,
  Sprout,
  Trash2,
  TreePine,
  Trees,
  Truck,
  Waves,
  Zap,
} from 'lucide-react';

export interface Trade {
  id: string;
  name: string;
  icon: LucideIcon;
  services: string[];
  /** How many of the services start selected. */
  preselect: number;
  jobHint: string;
}

export const TRADES: Trade[] = [
  {
    id: 'pressure-washing',
    name: 'Pressure washing',
    icon: Droplets,
    services: ['Driveways', 'House wash', 'Patios & pavers', 'Decks & fences', 'Roof soft wash', 'Commercial flatwork'],
    preselect: 4,
    jobHint: 'Back patio and walkway, about 600 sq ft. Lots of moss in the joints.',
  },
  {
    id: 'window-cleaning',
    name: 'Window cleaning',
    icon: Grid2x2,
    services: ['Exterior windows', 'Interior windows', 'Screens & tracks', 'Skylights', 'Storefronts'],
    preselect: 3,
    jobHint: 'Two-story house, 24 windows inside and out, screens included.',
  },
  {
    id: 'gutters',
    name: 'Gutter cleaning',
    icon: House,
    services: ['Gutter clean-out', 'Downspout flush', 'Gutter guards', 'Gutter brightening'],
    preselect: 2,
    jobHint: 'Single-story ranch, about 160 feet of gutter, two clogged downspouts.',
  },
  {
    id: 'house-cleaning',
    name: 'House cleaning',
    icon: SprayCan,
    services: ['Standard clean', 'Deep clean', 'Move-out clean', 'Recurring visits'],
    preselect: 3,
    jobHint: 'Move-out clean, 3 bed 2 bath, oven and fridge included.',
  },
  {
    id: 'carpet',
    name: 'Carpet cleaning',
    icon: Sofa,
    services: ['Carpet', 'Upholstery', 'Area rugs', 'Stain removal'],
    preselect: 3,
    jobHint: 'Four bedrooms and a hallway, pet stains in two rooms.',
  },
  {
    id: 'lawn',
    name: 'Lawn care',
    icon: Sprout,
    services: ['Mowing', 'Fertilizing', 'Aeration', 'Leaf cleanup'],
    preselect: 3,
    jobHint: 'Quarter-acre lot, weekly mowing and edging for the season.',
  },
  {
    id: 'landscaping',
    name: 'Landscaping',
    icon: Trees,
    services: ['Planting', 'Mulch & beds', 'Hardscape', 'Irrigation', 'Seasonal cleanup'],
    preselect: 3,
    jobHint: 'Front beds refreshed, 6 yards of mulch, 12 shrubs planted.',
  },
  {
    id: 'trees',
    name: 'Tree service',
    icon: TreePine,
    services: ['Trimming', 'Removal', 'Stump grinding', 'Storm cleanup'],
    preselect: 3,
    jobHint: 'Removed a 40 ft maple near the house, hauled everything away.',
  },
  {
    id: 'painting',
    name: 'Painting',
    icon: PaintRoller,
    services: ['Interior', 'Exterior', 'Cabinets', 'Decks & fences'],
    preselect: 2,
    jobHint: 'Living room and hallway, walls and trim, two coats.',
  },
  {
    id: 'handyman',
    name: 'Handyman',
    icon: Hammer,
    services: ['Repairs', 'Mounting & assembly', 'Drywall', 'Doors & trim'],
    preselect: 4,
    jobHint: 'Hung three TVs and patched two drywall holes.',
  },
  {
    id: 'junk',
    name: 'Junk removal',
    icon: Trash2,
    services: ['Single items', 'Garage cleanouts', 'Estate cleanouts', 'Construction debris'],
    preselect: 3,
    jobHint: 'Half a truckload from a garage, including an old fridge.',
  },
  {
    id: 'moving',
    name: 'Moving',
    icon: Truck,
    services: ['Local moves', 'Packing', 'Loading only', 'Specialty items'],
    preselect: 2,
    jobHint: 'Two-bedroom apartment, second floor, moved 8 miles.',
  },
  {
    id: 'fencing',
    name: 'Fencing',
    icon: Fence,
    services: ['New fence', 'Repairs', 'Gates', 'Staining'],
    preselect: 3,
    jobHint: '120 ft of 6 ft cedar privacy fence with one gate.',
  },
  {
    id: 'decks',
    name: 'Decks & patios',
    icon: BrickWall,
    services: ['New decks', 'Deck repair', 'Pavers', 'Staining & sealing'],
    preselect: 3,
    jobHint: 'Rebuilt the stairs on a 12 by 16 deck and replaced 9 boards.',
  },
  {
    id: 'roofing',
    name: 'Roofing',
    icon: HardHat,
    services: ['Repairs', 'Replacement', 'Inspections', 'Gutters'],
    preselect: 2,
    jobHint: 'Replaced 20 shingles after a storm and resealed the chimney flashing.',
  },
  {
    id: 'flooring',
    name: 'Flooring',
    icon: Layers,
    services: ['Hardwood', 'Tile', 'Vinyl plank', 'Refinishing'],
    preselect: 3,
    jobHint: '450 sq ft of vinyl plank in the basement, old carpet removed.',
  },
  {
    id: 'hvac',
    name: 'HVAC',
    icon: Fan,
    services: ['Service calls', 'Tune-ups', 'Installs', 'Duct cleaning'],
    preselect: 3,
    jobHint: 'Spring tune-up on two AC units and one furnace.',
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    icon: ShowerHead,
    services: ['Service calls', 'Water heaters', 'Drains', 'Fixtures'],
    preselect: 3,
    jobHint: 'Swapped a 50-gallon gas water heater, haul-away included.',
  },
  {
    id: 'electrical',
    name: 'Electrical',
    icon: Zap,
    services: ['Service calls', 'Panels', 'Lighting', 'EV chargers'],
    preselect: 3,
    jobHint: 'Installed a Level 2 EV charger, 30 ft run from the panel.',
  },
  {
    id: 'pools',
    name: 'Pool service',
    icon: Waves,
    services: ['Weekly service', 'Openings & closings', 'Repairs', 'Green-to-clean'],
    preselect: 2,
    jobHint: 'Green-to-clean on a 15,000 gallon pool, three visits.',
  },
  {
    id: 'pest',
    name: 'Pest control',
    icon: Bug,
    services: ['General pests', 'Termites', 'Rodents', 'Mosquitoes'],
    preselect: 2,
    jobHint: 'Quarterly perimeter treatment, 2,000 sq ft house.',
  },
  {
    id: 'detailing',
    name: 'Auto detailing',
    icon: Car,
    services: ['Interior detail', 'Exterior detail', 'Full detail', 'Ceramic coating'],
    preselect: 3,
    jobHint: 'Full detail on a midsize SUV with dog hair everywhere.',
  },
  {
    id: 'photography',
    name: 'Photography',
    icon: Camera,
    services: ['Portraits', 'Events', 'Real estate', 'Headshots'],
    preselect: 2,
    jobHint: 'Two-hour birthday party, 150 edited photos delivered.',
  },
  {
    id: 'events',
    name: 'Event services',
    icon: PartyPopper,
    services: ['Catering', 'Rentals', 'DJ', 'Planning'],
    preselect: 2,
    jobHint: 'Backyard wedding for 80 guests, tables, chairs and a tent.',
  },
];

export const TRADES_BY_ID = Object.fromEntries(TRADES.map((trade) => [trade.id, trade])) as Record<string, Trade>;

export function tradeName(tradeId: string | null, customTrade: string): string {
  if (tradeId && TRADES_BY_ID[tradeId]) return TRADES_BY_ID[tradeId].name;
  return customTrade.trim() || 'Your trade';
}
