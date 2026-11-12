import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { listPageSchema, type ListPage } from '../../../src/report/schema.js';
import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { ComparisonListPage } from '../../../viewer/src/pages/ComparisonListPage.js';
import { readJsonFixture } from '../fixtures.js';

function loadListPage(): ListPage {
  return listPageSchema.parse(readJsonFixture('page-list.json'));
}

/** The text of each cell of every body row, in document order. */
function bodyRows(): string[][] {
  const [, ...rows] = screen.getAllByRole('row');
  return rows.map((row) =>
    [...within(row).getAllByRole('rowheader'), ...within(row).getAllByRole('cell')].map(
      (cell) => cell.textContent,
    ),
  );
}

afterEach(() => {
  window.location.hash = '';
});

describe('002 ComparisonListPage', () => {
  it('002 FR-008 lists the comparisons in payload order with IDs, variants, time and gate outcome', () => {
    render(<ComparisonListPage page={loadListPage()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en['list.heading']);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      en['list.column.comparison'],
      en['list.column.baseline'],
      en['list.column.candidate'],
      en['list.column.createdAt'],
      en['list.column.gate'],
    ]);
    expect(bodyRows()).toEqual([
      ['cmp-c3185cc21556', 'current', 'next', '2026-11-05T10:20:00.000Z', 'BLOCK'],
      ['cmp-ff954570aec2', 'current', 'next', '2026-11-05T09:10:00.000Z', 'UNDECIDED'],
      ['cmp-89b170c0e72a', 'current', 'next', '2026-11-04T18:00:00.000Z', 'NO GATE'],
    ]);
  });

  it('002 FR-008 links each row to its report page by the relative href of the payload', () => {
    const page = loadListPage();
    render(<ComparisonListPage page={page} />);
    for (const entry of page.comparisons) {
      const link = screen.getByRole('link', { name: entry.comparisonId });
      expect(link.getAttribute('href')).toBe(entry.href);
    }
    expect(screen.getAllByRole('link')).toHaveLength(page.comparisons.length);
  });

  it('002 FR-008 says so when there is no comparison, without an empty table', () => {
    render(<ComparisonListPage page={{ ...loadListPage(), comparisons: [] }} />);
    expect(screen.getByText(en['list.empty'])).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('002 FR-013 reads in Korean when the payload language is ko', () => {
    render(<ComparisonListPage page={{ ...loadListPage(), lang: 'ko' }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ko['list.heading']);
    expect(screen.getByRole('columnheader', { name: ko['list.column.gate'] })).toBeDefined();
    expect(bodyRows().map((cells) => cells[4])).toEqual(['차단', '판정 보류', '게이트 없음']);
    expect(screen.getByRole('combobox', { name: ko['language.label'] })).toBeDefined();
  });

  it('002 FR-013 says so in Korean when a Korean list is empty', () => {
    render(<ComparisonListPage page={{ ...loadListPage(), lang: 'ko', comparisons: [] }} />);
    expect(screen.getByText(ko['list.empty'])).toBeDefined();
  });

  it('002 FR-013 offers the language switch, and ?lang= in the hash overrides the payload', () => {
    window.location.hash = '#/?lang=ko';
    render(<ComparisonListPage page={loadListPage()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ko['list.heading']);
    const select = screen.getByRole('combobox', { name: ko['language.label'] });
    expect(select instanceof HTMLSelectElement && select.value).toBe('ko');
  });
});
