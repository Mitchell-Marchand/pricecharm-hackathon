/**
 * The numbers setup shows between questions. They're estimates for a typical shop of one to five
 * people, from industry surveys: 30 to 62% of home-service requests come in outside business
 * hours (we use 4 in 10), most customers hire whoever answers first, and about 7 in 10 want a
 * price before they contact anyone. Change them here.
 */

/** Quote requests a typical shop in each trade gets in a week. */
const WEEKLY_REQUESTS: Record<string, number> = {
  'pressure-washing': 15,
  'window-cleaning': 14,
  gutters: 12,
  'house-cleaning': 20,
  carpet: 15,
  lawn: 18,
  landscaping: 12,
  trees: 12,
  painting: 10,
  handyman: 18,
  junk: 22,
  moving: 25,
  fencing: 9,
  decks: 7,
  roofing: 10,
  flooring: 9,
  hvac: 30,
  plumbing: 35,
  electrical: 22,
  pools: 12,
  pest: 20,
  detailing: 18,
  photography: 10,
  events: 12,
};

/** The share of requests that come in after hours. */
export const AFTER_HOURS_SHARE = 0.4;
/** For a trade we have no number for, someone who typed their own. */
const TYPICAL_WEEKLY = 14;

export function tradeFact(tradeId: string | null) {
  const weekly = (tradeId && WEEKLY_REQUESTS[tradeId]) || TYPICAL_WEEKLY;
  return { weekly, afterHours: Math.round(weekly * AFTER_HOURS_SHARE) };
}
