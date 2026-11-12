import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
