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

  it('002 FR-003 orders rows by rules[] and gives every grid a column per language of cells[], in order of first appearance', () => {
    const { cells, rules } = loadComparison('block');
    const [raw, final, trial] = buildGrid(cells, rules);
    // cells[] holds ja first (raw), then ko and en (trial).
    expect([...new Set(cells.map((cell) => cell.lang))]).toEqual(['ja', 'ko', 'en']);
    expect(raw?.languages).toEqual(['ja', 'ko', 'en']);
    expect(raw === undefined ? [] : layout(raw)).toEqual([
      ['script-ja', 'ja:regressed', '-', '-'],
      ['no-emoji', 'ja:not-applicable', 'ko:non-inferior', '-'],
    ]);
    expect(final?.languages).toEqual(['ja', 'ko', 'en']);
    expect(final === undefined ? [] : layout(final)).toEqual([
      ['script-ja', 'ja:non-inferior', '-', '-'],
    ]);
    expect(trial?.languages).toEqual(['ja', 'ko', 'en']);
    expect(trial === undefined ? [] : layout(trial)).toEqual([
      ['completed', 'ja:inconclusive', 'ko:inconclusive', 'en:insufficient'],
    ]);
  });

  it('002 FR-003 puts each language in the same column of every grid, also where a surface lacks a language', () => {
    const { cells, rules } = loadComparison('block');
    // `final` gets ja and en, `trial` keeps ja, ko and en: in cells[] order ja, ko, en.
    const trialEn = cells.find((cell) => cell.surface === 'trial' && cell.lang === 'en');
    if (trialEn === undefined) {
      throw new Error('the block fixture has a trial cell in en');
    }
    const finalEn = { ...trialEn, surface: 'final' as const };
    const grids = buildGrid([...cells, finalEn], rules);
    const final = grids.find((grid) => grid.surface === 'final');
    const trial = grids.find((grid) => grid.surface === 'trial');
    const finalLanguages = new Set(
      final?.rows.flatMap((row) =>
        row.positions.flatMap((cell) => (cell === null ? [] : [cell.lang])),
      ),
    );
    expect([...finalLanguages].sort()).toEqual(['en', 'ja']);
    for (const grid of grids) {
      expect(grid.languages, grid.surface).toEqual(['ja', 'ko', 'en']);
    }
    for (const lang of ['ja', 'ko', 'en']) {
      expect(final?.languages.indexOf(lang), lang).toBe(trial?.languages.indexOf(lang));
    }
    // The position of each cell is the column of its language.
    for (const grid of grids) {
      for (const row of grid.rows) {
        row.positions.forEach((cell, index) => {
          if (cell !== null) {
            expect(cell.lang, `${grid.surface} ${row.ruleId}`).toBe(grid.languages[index]);
          }
        });
      }
    }
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
    expect(languagesOf('completed')).toEqual(['ja', 'ko', 'en']);
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
