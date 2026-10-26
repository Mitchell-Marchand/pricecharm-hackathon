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
import { TRADES as TRADE_DATA, type Trade as TradeData } from '@quotefolk/trades';

export { TRADES_BY_ID as TRADE_DATA_BY_ID, tradeName } from '@quotefolk/trades';

export type Trade = TradeData & { icon: LucideIcon };

const ICONS: Record<string, LucideIcon> = {
  'pressure-washing': Droplets,
  'window-cleaning': Grid2x2,
  gutters: House,
  'house-cleaning': SprayCan,
  carpet: Sofa,
  lawn: Sprout,
  landscaping: Trees,
  trees: TreePine,
  painting: PaintRoller,
  handyman: Hammer,
  junk: Trash2,
  moving: Truck,
  fencing: Fence,
  decks: BrickWall,
  roofing: HardHat,
  flooring: Layers,
  hvac: Fan,
  plumbing: ShowerHead,
  electrical: Zap,
  pools: Waves,
  pest: Bug,
  detailing: Car,
  photography: Camera,
  events: PartyPopper,
};

export const TRADES: Trade[] = TRADE_DATA.map((trade) => ({ ...trade, icon: ICONS[trade.id] }));

export const TRADES_BY_ID = Object.fromEntries(TRADES.map((trade) => [trade.id, trade])) as Record<
  string,
  Trade
>;
