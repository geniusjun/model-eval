// Page-only helpers. Numbers shown as text go through src/report/format.ts, so the page and
// report.md print the same values.

/** The x position of a share between 0 and 1 on a chart `width` wide, clamped to the chart. */
export function shareX(share: number, width: number): number {
  return Math.min(Math.max(share, 0), 1) * width;
}
