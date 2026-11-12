import type { Surface } from '../../../../src/config/schema.js';
import type { Cell, RuleSummary } from '../../../../src/report/schema.js';

export interface GridRow {
  readonly ruleId: string;
  /** One position per language of the grid; null where the rule has no cell in that language. */
  readonly positions: readonly (Cell | null)[];
}

/** The rule × language grid of one output surface (FR-003). */
export interface SurfaceGrid {
  readonly surface: Surface;
  readonly languages: readonly string[];
  readonly rows: readonly GridRow[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Rules in `rules[]` order. A cell whose rule is missing from `rules[]` still gets a row, after
 * the listed ones, so no cell of the comparison drops out of the grid.
 */
function rowRuleIds(cells: readonly Cell[], rules: readonly RuleSummary[]): string[] {
  const present = unique(cells.map((cell) => cell.ruleId));
  const listed = rules.map((rule) => rule.id).filter((id) => present.includes(id));
  return [...listed, ...present.filter((id) => !listed.includes(id))];
}

function surfaceGrid(
  surface: Surface,
  cells: readonly Cell[],
  rules: readonly RuleSummary[],
): SurfaceGrid {
  const surfaceCells = cells.filter((cell) => cell.surface === surface);
  // Columns come from the cells, not from `rule.languages`, which is empty for a rule that
  // applies to every language.
  const languages = unique(surfaceCells.map((cell) => cell.lang));
  const rows = rowRuleIds(surfaceCells, rules).map((ruleId) => ({
    ruleId,
    positions: languages.map(
      (lang) => surfaceCells.find((cell) => cell.ruleId === ruleId && cell.lang === lang) ?? null,
    ),
  }));
  return { surface, languages, rows };
}

/** One grid per surface present in `cells`, surfaces and languages in order of first appearance. */
export function buildGrid(
  cells: readonly Cell[],
  rules: readonly RuleSummary[],
): readonly SurfaceGrid[] {
  return unique(cells.map((cell) => cell.surface)).map((surface) =>
    surfaceGrid(surface, cells, rules),
  );
}
