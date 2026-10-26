import patioOverview from './photos/patio-overview.jpg';
import patioStains from './photos/patio-stains.jpg';
import patioDoor from './photos/patio-door.jpg';
import flagstoneWide from './photos/flagstone-wide.jpg';
import flagstoneClose from './photos/flagstone-close.jpg';
import flagstoneEdge from './photos/flagstone-edge.jpg';
import tablePatio from './photos/table-patio.jpg';
import tableStains from './photos/table-stains.jpg';
import planters from './photos/planters.jpg';

// Generated practice photos from the local Quotefolk dev environment, cropped for the mock scenarios.
export const PHOTOS = {
  'patio-overview': patioOverview,
  'patio-stains': patioStains,
  'patio-door': patioDoor,
  'flagstone-wide': flagstoneWide,
  'flagstone-close': flagstoneClose,
  'flagstone-edge': flagstoneEdge,
  'table-patio': tablePatio,
  'table-stains': tableStains,
  planters,
} as const;

export type PhotoKey = keyof typeof PHOTOS;

/** A photo reference is either a bundled photo key or a data URL from the viewer's own upload. */
export function photoSrc(ref: string): string {
  if (ref.startsWith('data:') || ref.startsWith('blob:')) return ref;
  return (PHOTOS as Record<string, string>)[ref] ?? '';
}
