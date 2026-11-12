import type { Surface } from '../config/schema.js';

// data-model §Gate: the low-baseline test, shared by the gate, `report.md`, the human output of
// `compare` and the result page, so all of them name the same cells. Free of Node built-ins,
// since the page bundles it.

/** What the low-baseline test reads of a cell. */
export interface BaselineOfCell {
  readonly surface: Surface;
  readonly baseline: { readonly rate: number | null };
}

/**
 * A cell of a rule other than `completed` whose baseline rate is below `report.lowBaseline`.
 * Only `completed` is judged on the `trial` surface, so the surface names its cells; it has its
 * own premise check (row 3).
 */
export function isLowBaseline(cell: BaselineOfCell, lowBaseline: number): boolean {
  return (
    cell.surface !== 'trial' && cell.baseline.rate !== null && cell.baseline.rate < lowBaseline
  );
}
