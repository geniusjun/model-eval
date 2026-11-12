import { describe, expect, it } from 'vitest';

import { buildGrid, type SurfaceGrid } from '../../../viewer/src/domains/grid/buildGrid.js';
import { loadComparison } from '../fixtures.js';

/** Each row as `ruleId` and the `lang:verdict` of each position, `-` for an empty one. */
function layout(grid: SurfaceGrid): string[][] {
  return grid.rows.map((row) => [
    row.ruleId,
    ...row.positions.map((cell) => (cell === null ? '-' : `${cell.lang}:${cell.verdict}`)),
  ]);
}

describe('002 buildGrid', () => {
  it('002 FR-003 builds one grid per surface present in cells[]', () => {
    const { cells, rules } = loadComparison('block');
    expect(buildGrid(cells, rules).map((grid) => grid.surface)).toEqual(['raw', 'final', 'trial']);
  });

  it('002 FR-003 orders rows by rules[] and columns by first appearance in cells[]', () => {
    const { cells, rules } = loadComparison('block');
    const [raw, final, trial] = buildGrid(cells, rules);
    expect(raw?.languages).toEqual(['ja', 'ko']);
    expect(raw === undefined ? [] : layout(raw)).toEqual([
      ['script-ja', 'ja:regressed', '-'],
      ['no-emoji', 'ja:not-applicable', 'ko:non-inferior'],
    ]);
    expect(final?.languages).toEqual(['ja']);
    expect(final === undefined ? [] : layout(final)).toEqual([['script-ja', 'ja:non-inferior']]);
    expect(trial?.languages).toEqual(['ko', 'en', 'ja']);
    expect(trial === undefined ? [] : layout(trial)).toEqual([
      ['completed', 'ko:inconclusive', 'en:insufficient', 'ja:inconclusive'],
    ]);
  });

  it('002 FR-003 gives rules with an empty languages list the columns of their cells', () => {
    const { cells, rules } = loadComparison('block');
    expect(rules.find((rule) => rule.id === 'completed')?.languages).toEqual([]);
    expect(rules.find((rule) => rule.id === 'no-emoji')?.languages).toEqual([]);
    const grids = buildGrid(cells, rules);
    const languagesOf = (ruleId: string): string[] =>
      grids.flatMap((grid) =>
        grid.rows
          .filter((row) => row.ruleId === ruleId)
          .flatMap((row) => row.positions.flatMap((cell) => (cell === null ? [] : [cell.lang]))),
      );
    expect(languagesOf('completed')).toEqual(['ko', 'en', 'ja']);
    expect(languagesOf('no-emoji')).toEqual(['ja', 'ko']);
  });

  it('002 FR-003 leaves a rule and language without a cell as an empty position', () => {
    const { cells, rules } = loadComparison('block');
    const raw = buildGrid(cells, rules)[0];
    const scriptJa = raw?.rows.find((row) => row.ruleId === 'script-ja');
    expect(scriptJa?.positions[raw?.languages.indexOf('ko') ?? -1]).toBeNull();
  });

  it('002 FR-003 keeps a cell whose rule is missing from rules[] in a row after the listed rules', () => {
    const { cells, rules } = loadComparison('block');
    const raw = buildGrid(
      cells,
      rules.filter((rule) => rule.id !== 'script-ja'),
    )[0];
    expect(raw?.rows.map((row) => row.ruleId)).toEqual(['no-emoji', 'script-ja']);
  });

  it('002 FR-003 builds no grid for a comparison without cells', () => {
    const { rules } = loadComparison('block');
    expect(buildGrid([], rules)).toEqual([]);
  });
});
