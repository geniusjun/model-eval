import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import en from '../../../viewer/src/i18n/en.json';
import { ReportPage } from '../../../viewer/src/pages/ReportPage.js';
import { loadComparisonPage } from '../fixtures.js';

describe('002 ReportPage', () => {
  it('002 FR-016 names the compared variants and their models in its heading, with the title of report.md', () => {
    const page = loadComparisonPage('page-comparison-block.json');
    render(<ReportPage page={{ ...page, lang: 'en' }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'model-eval report: current (model-a) → next (model-b)',
    );
  });

  it('002 FR-013 names them in Korean on a Korean page', () => {
    const page = loadComparisonPage('page-comparison-block.json');
    render(<ReportPage page={{ ...page, lang: 'ko' }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'model-eval 보고서: current (model-a) → next (model-b)',
    );
  });

  it('002 FR-007 names the comparison and when it was written in a footer, with no reproduction region', () => {
    const page = loadComparisonPage('page-comparison-block.json');
    const { container } = render(<ReportPage page={{ ...page, lang: 'en' }} />);
    const { comparisonId, createdAt } = page.comparison;
    const footer = container.querySelector('main > footer');
    const written = footer?.querySelector('time');
    // The time reads in the reader's zone and language; its datetime keeps the original.
    expect(written?.getAttribute('datetime')).toBe(createdAt);
    expect(written?.textContent).toBe('2026-11-05 10:20 UTC');
    expect(footer?.textContent).toBe(
      `Comparison ${comparisonId} · written ${written?.textContent ?? ''}`,
    );
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      en['summary.heading'],
      en['grid.heading'],
      en['side.heading'],
      en['metrics.heading'],
      en['scope.heading'],
    ]);
  });
});
