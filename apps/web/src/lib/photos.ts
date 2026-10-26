/** Practice photos used on the landing page. They live in public/photos. */
export const PHOTOS = {
  'patio-overview': '/photos/patio-overview.jpg',
  'patio-stains': '/photos/patio-stains.jpg',
  'patio-door': '/photos/patio-door.jpg',
  'flagstone-wide': '/photos/flagstone-wide.jpg',
  'flagstone-close': '/photos/flagstone-close.jpg',
  'flagstone-edge': '/photos/flagstone-edge.jpg',
  'table-patio': '/photos/table-patio.jpg',
  'table-stains': '/photos/table-stains.jpg',
  planters: '/photos/planters.jpg',
} as const;

export type PhotoKey = keyof typeof PHOTOS;

/** A photo is a bundled photo key, an API URL, or a data URL from the viewer's own upload. */
export function photoSrc(ref: string): string {
  return (PHOTOS as Record<string, string>)[ref] ?? ref;
}
