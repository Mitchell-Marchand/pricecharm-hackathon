/** The benchmark's repeatable randomness, shared by the owners of every trade. */

export type Rng = () => number;

/** A repeatable random sequence (mulberry32), so a seed always makes the same owners and jobs. */
export function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();
export const whole = (rng: Rng, low: number, high: number) => Math.round(between(rng, low, high));
export const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];
