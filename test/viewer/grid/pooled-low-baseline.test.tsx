import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import en from '../../../viewer/src/i18n/en.json';
import { LowBaselineCells } from '../../../viewer/src/domains/grid/LowBaselineCells.js';
import { PooledRates } from '../../../viewer/src/domains/grid/PooledRates.js';
import { loadComparison } from '../fixtures.js';

function rowTexts(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
}

describe('002 PooledRates', () => {
  it('002 FR-016 shows each aggregate with both pooled rates, passes and trials, and the difference', () => {
    const comparison = loadComparison('block');
    render(<PooledRates aggregates={comparison.aggregates} lang="en" />);
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Rule', 'Surface', 'Baseline', 'Candidate', 'Difference']);
    expect(rowTexts(table)).toEqual([
      ['script-ja', 'raw', '99.3% (149 of 150)', '70.0% (105 of 150)', '-29.3pp'],
      ['completed', 'trial', '99.7% (299 of 300)', '95.7% (287 of 300)', '-4.0pp'],
    ]);
  });

  it('002 FR-016 shows no verdict for pooled rates', () => {
    const comparison = loadComparison('block');
    render(<PooledRates aggregates={comparison.aggregates} lang="en" />);
    const text = screen.getByRole('table').textContent;
    for (const verdict of ['Better', 'Held', 'Regressed', 'Inconclusive', 'Too few samples']) {
      expect(text).not.toContain(verdict);
    }
    expect(screen.getByText(en['grid.pooled.intro'])).toBeDefined();
  });

  it('002 FR-016 shows — for a difference that does not exist', () => {
    const comparison = loadComparison('block');
    const [first] = comparison.aggregates;
    if (first === undefined) {
      throw new Error('the block fixture has aggregates');
    }
    render(
      <PooledRates
        aggregates={[{ ...first, baseline: { trials: 0, passes: 0, rate: null }, diff: null }]}
        lang="en"
      />,
    );
    expect(rowTexts(screen.getByRole('table'))).toEqual([
      ['script-ja', 'raw', '— (0 of 0)', '70.0% (105 of 150)', '—'],
    ]);
  });
});

describe('002 LowBaselineCells', () => {
  it('002 FR-016 lists a cell whose baseline rate is below the level with both rates and its verdict', () => {
    const comparison = loadComparison('block');
    expect(comparison.config.report.lowBaseline).toBe(0.9);
    comparison.cells = comparison.cells.map((cell) =>
      cell.ruleId === 'no-emoji' && cell.lang === 'ko'
        ? { ...cell, baseline: { ...cell.baseline, rate: 0.85, low: 0.8, high: 0.9 } }
        : cell,
    );
    comparison.cells = comparison.cells.map((cell) =>
      cell.ruleId === 'completed' && cell.lang === 'ko'
        ? { ...cell, baseline: { ...cell.baseline, rate: 0.5 } }
        : cell,
    );
    render(
      <LowBaselineCells
        cells={comparison.cells}
        lowBaseline={comparison.config.report.lowBaseline}
        lang="en"
      />,
    );
    expect(screen.getByText('Cells whose baseline compliance is below 90.0%.')).toBeDefined();
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Rule', 'Language', 'Surface', 'Baseline', 'Candidate', 'Verdict']);
    expect(rowTexts(table)).toEqual([
      ['no-emoji', 'ko', 'raw', '85.0% [80.0, 90.0]', '98.0% [92.0, 100.0]', 'Held'],
    ]);
  });

  it('002 FR-016 says that no cell is below the level on the block fixture', () => {
    const comparison = loadComparison('block');
    render(
      <LowBaselineCells
        cells={comparison.cells}
        lowBaseline={comparison.config.report.lowBaseline}
        lang="en"
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No cell has a baseline compliance below 90.0%.')).toBeDefined();
  });
});
