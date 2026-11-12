// Page-only helpers. Numbers shown as text go through src/report/format.ts, so the page and
// report.md print the same values.

/** The x position of a share between 0 and 1 on a chart `width` wide, clamped to the chart. */
export function shareX(share: number, width: number): number {
  return Math.min(Math.max(share, 0), 1) * width;
}

/**
 * How many of `values` fall in each of `binCount` equal bins from 0 to `max`. A value equal to
 * `max` falls in the last bin, and with `max` 0 every value falls in the first.
 */
export function binCounts(values: readonly number[], max: number, binCount: number): number[] {
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of values) {
    const bin = max === 0 ? 0 : Math.min(Math.floor((value / max) * binCount), binCount - 1);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}
