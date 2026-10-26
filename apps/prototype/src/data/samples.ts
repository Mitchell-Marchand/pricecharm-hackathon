import type { Business, Job, Quote } from '../lib/types';

export const SAMPLE_BUSINESS: Business = {
  tradeId: 'pressure-washing',
  customTrade: '',
  services: ['Driveways', 'House wash', 'Patios & pavers', 'Decks & fences'],
  customServices: [],
  name: 'Moss & Stone Exterior Care',
  area: 'Portland, OR',
  radius: '25',
};

export function sampleJob(id: string): Job {
  return {
    id,
    serviceName: 'Patios & pavers',
    description:
      'Back patio and walkway, about 600 sq ft of concrete and pavers. Lots of moss in the joints, so it needed a second pass.',
    priceCents: 27500,
    photos: [],
    size: '600 sq ft',
    duration: '3 hours',
    when: 'June 2026',
    materialsCents: 1800,
    discount: null,
    notes: 'The moss in the joints took an extra 45 minutes.',
    source: 'sample',
  };
}

/** What the mock invoice reader "finds". The prototype doesn't read the uploaded file. */
export function invoiceJob(id: string): Job {
  return {
    id,
    serviceName: 'Driveways',
    description: 'Two-car driveway and front walk, about 900 sq ft. Oil stains by the garage.',
    priceCents: 32000,
    photos: [],
    size: '900 sq ft',
    duration: '4 hours',
    when: 'August 2026',
    materialsCents: 2500,
    discount: { kind: 'amount', value: 2000, reason: 'Repeat customer' },
    notes: '',
    source: 'invoice',
  };
}

type QuoteDraft = Omit<Quote, 'number' | 'issuedAt'>;

/** Practice answers used when someone skips ahead with sample data. */
export function sampleQuotes(): { dana: QuoteDraft; marcus: QuoteDraft } {
  return {
    dana: {
      customer: 'Dana R.',
      place: 'Eastgate',
      lines: [
        { id: 'd1', label: 'Patio wash, about 550 sq ft', amountCents: 28000 },
        { id: 'd2', label: 'Stain pre-treatment', amountCents: 4500 },
      ],
      discount: null,
      start: 'Next week',
      duration: '3 hours',
      included: ['Hot-water surface clean', 'Pre-treat dark stains', 'Rinse nearby walls and windows'],
      excluded: ['Sealing'],
      validDays: 14,
      note: 'Heavy staining by the door needs a second pass.',
    },
    marcus: {
      customer: 'Marcus T.',
      place: 'North Hills',
      lines: [
        { id: 'm1', label: 'Patio wash, about 700 sq ft', amountCents: 38000 },
        { id: 'm2', label: 'Planter area detail', amountCents: 4000 },
      ],
      discount: { kind: 'percent', value: 10, reason: 'Neighbor discount' },
      start: 'This week',
      duration: '4 hours',
      included: ['Hot-water surface clean', 'Algae treatment by the planters'],
      excluded: ['Moving furniture', 'Sealing'],
      validDays: 14,
      note: 'Two houses on the same street, same day.',
    },
  };
}
