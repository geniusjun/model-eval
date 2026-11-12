import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { Cell, Comparison } from '../../../src/report/schema.js';
import en from '../../../viewer/src/i18n/en.json';
import { RuleLanguageGrid } from '../../../viewer/src/domains/grid/RuleLanguageGrid.js';
import { useHashParam } from '../../../viewer/src/hooks/useHashParam.js';
import { parseHash, resolveView } from '../../../viewer/src/utils/hash.js';
import { loadComparison } from '../fixtures.js';

afterEach(() => {
  window.location.hash = '';
});

const VERDICT_EN: Readonly<Record<Cell['verdict'], string>> = {
  improved: 'Better',
  'non-inferior': 'Held',
  regressed: 'Regressed',
  inconclusive: 'Inconclusive',
  insufficient: 'Too few samples',
  'not-applicable': 'Not applicable',
};

interface GridFromHashProps {
  readonly comparison: Comparison;
}

/** The grid with the cell the location hash names, resolved as the page resolves it. */
function GridFromHash({ comparison }: GridFromHashProps) {
  const [hash] = useHashParam();
  const view = resolveView(hash.view, comparison);
  return (
    <RuleLanguageGrid
      cells={comparison.cells}
      selected={view.kind === 'cell' ? view.cell : undefined}
      rules={comparison.rules}
      samples={comparison.samples}
      variants={{
        baseline: comparison.baseline.variant.id,
        candidate: comparison.candidate.variant.id,
      }}
      lang="en"
    />
  );
}

function renderGrid(comparison: Comparison = loadComparison('block')) {
  return render(<GridFromHash comparison={comparison} />);
}

/** The table of a surface, found by its caption. */
function surfaceTable(surface: string): HTMLElement {
  return screen.getByRole('table', { name: en['grid.caption'].replace('{surface}', surface) });
}

function cellButton(ruleId: string, lang: string, surface: string): HTMLElement {
  const buttons = within(surfaceTable(surface)).getAllByRole('button');
  const button = buttons.find((candidate) =>
    candidate.textContent.includes(`${ruleId} (${lang}, ${surface})`),
  );
  if (button === undefined) {
    throw new Error(`no button for ${ruleId} ${lang} ${surface}`);
  }
  return button;
}

function detailHeading(ruleId: string, lang: string, surface: string): HTMLElement {
  return screen.getByRole('heading', { name: new RegExp(`${ruleId} \\(${lang}, ${surface}\\)`) });
}

describe('002 RuleLanguageGrid', () => {
  it('002 FR-003 draws one <table> per surface with a labelled button per cell', () => {
    const comparison = loadComparison('block');
    renderGrid(comparison);
    const tables = screen.getAllByRole('table');
    expect(tables.map((table) => table.tagName.toLowerCase())).toEqual(['table', 'table', 'table']);
    expect(screen.getAllByRole('button')).toHaveLength(comparison.cells.length);
    for (const cell of comparison.cells) {
      const button = within(surfaceTable(cell.surface)).getByRole('button', {
        name: new RegExp(
          `${cell.ruleId} \\(${cell.lang}, ${cell.surface}\\).*${VERDICT_EN[cell.verdict]}`,
        ),
      });
      expect(button.tagName.toLowerCase()).toBe('button');
    }
  });

  it('002 FR-003 shows the verdict as text with a colour class', () => {
    renderGrid();
    const button = cellButton('script-ja', 'ja', 'raw');
    const badge = within(button).getByText('Regressed');
    expect(badge.classList.contains('regressed')).toBe(true);
    const held = within(cellButton('no-emoji', 'ko', 'raw')).getByText('Held');
    expect(held.classList.contains('non-inferior')).toBe(true);
  });

  it('002 FR-003 leaves a rule and language without a cell as an empty position, not a button', () => {
    renderGrid();
    const table = surfaceTable('raw');
    const columns = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(columns).toEqual([en['grid.column.rule'], 'ja', 'ko']);
    const row = within(table).getByRole('rowheader', { name: 'script-ja' }).closest('tr');
    expect(row).not.toBeNull();
    const positions = row === null ? [] : within(row).getAllByRole('cell');
    expect(positions).toHaveLength(2);
    expect(
      positions[1] === undefined ? null : within(positions[1]).queryByRole('button'),
    ).toBeNull();
  });

  it('002 FR-011 opens a detail with Enter right after its table, focuses its heading and sets the hash', async () => {
    const user = userEvent.setup();
    renderGrid();
    cellButton('script-ja', 'ja', 'raw').focus();
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/cell/script-ja/ja/raw');
    const heading = await waitFor(() => detailHeading('script-ja', 'ja', 'raw'));
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    const detail = heading.closest('section');
    expect(surfaceTable('raw').nextElementSibling).toBe(detail);
    expect(cellButton('script-ja', 'ja', 'raw').getAttribute('aria-expanded')).toBe('true');
  });

  it('002 FR-011 opens a detail with Space', async () => {
    const user = userEvent.setup();
    renderGrid();
    cellButton('completed', 'en', 'trial').focus();
    await user.keyboard(' ');
    expect(window.location.hash).toBe('#/cell/completed/en/trial');
    const heading = await waitFor(() => detailHeading('completed', 'en', 'trial'));
    expect(surfaceTable('trial').nextElementSibling).toBe(heading.closest('section'));
  });

  it('002 FR-011 closes with the close button, clears the hash and returns focus to the cell', async () => {
    const user = userEvent.setup();
    renderGrid();
    const button = cellButton('script-ja', 'ja', 'raw');
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => detailHeading('script-ja', 'ja', 'raw'));
    await user.click(screen.getByRole('button', { name: en['grid.detail.close'] }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /script-ja \(ja, raw\)/ })).toBeNull();
    });
    expect(parseHash(window.location.hash).view).toEqual({ kind: 'summary' });
    expect(document.activeElement).toBe(cellButton('script-ja', 'ja', 'raw'));
  });

  it('002 FR-011 closes with Escape and returns focus to the cell', async () => {
    const user = userEvent.setup();
    renderGrid();
    cellButton('no-emoji', 'ko', 'raw').focus();
    await user.keyboard('{Enter}');
    const heading = await waitFor(() => detailHeading('no-emoji', 'ko', 'raw'));
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /no-emoji \(ko, raw\)/ })).toBeNull();
    });
    expect(parseHash(window.location.hash).view).toEqual({ kind: 'summary' });
    expect(document.activeElement).toBe(cellButton('no-emoji', 'ko', 'raw'));
  });

  it('002 FR-011 keeps ?lang= of the hash when a detail opens and closes', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/?lang=ko';
    renderGrid();
    cellButton('script-ja', 'ja', 'final').focus();
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/cell/script-ja/ja/final?lang=ko');
    await waitFor(() => detailHeading('script-ja', 'ja', 'final'));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(window.location.hash).toBe('#/?lang=ko');
    });
  });

  it('002 FR-011 opens the detail a cell hash names when the page opens', () => {
    window.location.hash = '#/cell/completed/ja/trial';
    renderGrid();
    const heading = detailHeading('completed', 'ja', 'trial');
    expect(surfaceTable('trial').nextElementSibling).toBe(heading.closest('section'));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  });

  it('002 FR-011 closes an open detail when its cell is pressed again', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.click(cellButton('script-ja', 'ja', 'raw'));
    await waitFor(() => detailHeading('script-ja', 'ja', 'raw'));
    expect(cellButton('script-ja', 'ja', 'raw').getAttribute('aria-expanded')).toBe('true');
    await user.click(cellButton('script-ja', 'ja', 'raw'));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /script-ja \(ja, raw\)/ })).toBeNull();
    });
    expect(parseHash(window.location.hash).view).toEqual({ kind: 'summary' });
    expect(cellButton('script-ja', 'ja', 'raw').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(cellButton('script-ja', 'ja', 'raw'));
  });

  it('002 FR-011 returns focus to the cell when the hash leaves its detail, as going back does', async () => {
    const user = userEvent.setup();
    renderGrid();
    cellButton('no-emoji', 'ko', 'raw').focus();
    await user.keyboard('{Enter}');
    const heading = await waitFor(() => detailHeading('no-emoji', 'ko', 'raw'));
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    window.location.hash = '#/';
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /no-emoji \(ko, raw\)/ })).toBeNull();
    });
    expect(document.activeElement).toBe(cellButton('no-emoji', 'ko', 'raw'));
  });

  it('002 FR-011 opens no detail for a hash that names no cell', () => {
    window.location.hash = '#/cell/script-ja/ko/raw';
    renderGrid();
    expect(screen.queryByRole('button', { name: en['grid.detail.close'] })).toBeNull();
  });
});
