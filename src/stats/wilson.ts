export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * Wilson score interval for `passes` out of `trials` at normal quantile `z`. Counts may be
 * fractional: the design effect scales both by 1/deff (data-model §Statistics).
 */
export function wilson(passes: number, trials: number, z: number): Interval {
  if (!(trials > 0 && passes >= 0 && passes <= trials && z > 0)) {
    throw new RangeError(
      `the Wilson interval needs 0 ≤ passes ≤ trials, trials > 0 and z > 0, not ${String(passes)}, ${String(trials)}, ${String(z)}`,
    );
  }
  const z2 = z * z;
  const centre = (passes + z2 / 2) / (trials + z2);
  const half = (z / (trials + z2)) * Math.sqrt((passes * (trials - passes)) / trials + z2 / 4);
  // The bounds are exactly 0 and 1 at the ends; floating point would leave them a few ulps off.
  return {
    low: passes === 0 ? 0 : Math.max(0, centre - half),
    high: passes === trials ? 1 : Math.min(1, centre + half),
  };
}
