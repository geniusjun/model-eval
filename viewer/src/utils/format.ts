// Page-only helpers. Numbers shown as text go through src/report/format.ts, so the page and
// report.md print the same values.

/** The x position of a share between 0 and 1 on a chart `width` wide, clamped to the chart. */
export function shareX(share: number, width: number): number {
  return Math.min(Math.max(share, 0), 1) * width;
}

/**
 * How many of `values` fall in each of `binCount` equal bins from `min` to `max`. A value equal
 * to `max` falls in the last bin, and when `max` is not above `min` every value falls in the
 * first.
 */
export function binCounts(
  values: readonly number[],
  min: number,
  max: number,
  binCount: number,
): number[] {
  const counts = Array.from({ length: binCount }, () => 0);
  const span = max - min;
  for (const value of values) {
    const bin =
      span <= 0
        ? 0
        : Math.min(Math.max(Math.floor(((value - min) / span) * binCount), 0), binCount - 1);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}
