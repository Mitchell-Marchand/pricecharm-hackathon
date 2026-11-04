/**
 * Whether setup shows how customers shop (/start/why) between services and About. Off for now: an
 * owner who clicked an ad and picked their trade shouldn't have another screen to get past. Set
 * it to true to bring the screen back, in the flow and in the progress bar.
 */
export const SHOW_SHOPPING_FACTS = false;

/**
 * How customers shop for a service, for the screens between setup's questions. These are about
 * customers in general, from homeowner and contractor surveys, never a claim about this owner's
 * business, which setup knows nothing about yet. 67–78% want
 * a price before contacting anyone, 30–62% of requests come in after hours, and about 78% hire the
 * first business that answers.
 */
export const SHOPPING = {
  /** Out of 10 customers, how many want a price before they call. */
  priceFirst: 7,
  afterHours: '4 in 10 quote requests come in after hours.',
  firstAnswer: '78% of customers hire the first business that answers.',
};
