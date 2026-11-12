import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { verdictText } from '../../../src/report/code-text.js';
import type { ComparisonPage } from '../../../src/report/schema.js';
import { WithheldBanner } from '../../../viewer/src/domains/summary/WithheldBanner.js';
import { pageMessages } from '../../../viewer/src/i18n/useMessages.js';
import { ReportPage } from '../../../viewer/src/pages/ReportPage.js';
import { loadComparison, loadComparisonPage } from '../fixtures.js';

const en = pageMessages('en');

const PARTIAL_RUN_TEXT =
  'Withheld because a compared run is not finished: next (status partial, stopReason budget).';

const COMPLETE_PAGES = ['page-comparison-block.json', 'page-comparison-no-gate.json'] as const;

function precedes(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function renderPage(page: ComparisonPage) {
  return render(<ReportPage page={page} />);
}

function headingTexts(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent);
}

describe('002 WithheldBanner', () => {
  it('002 FR-007 names the unfinished variant and its stop reason through the text of partial-run', () => {
    render(<WithheldBanner comparison={loadComparison('undecided-partial')} lang="en" />);
    const banner = screen.getByRole('region', { name: en.text('summary.withheld') });
    expect(banner.textContent).toContain(PARTIAL_RUN_TEXT);
  });

  it('002 FR-007 shows nothing for a comparison of complete runs', () => {
    for (const kind of ['block', 'no-gate'] as const) {
      const { container, unmount } = render(
        <WithheldBanner comparison={loadComparison(kind)} lang="en" />,
      );
      expect(container.childElementCount, kind).toBe(0);
      unmount();
    }
  });
});

describe('002 ReportPage of a partial comparison', () => {
  const page = loadComparisonPage('page-comparison-undecided-partial.json');

  it('002 FR-007 puts the withheld banner first, above the header and the decision summary', () => {
    const { container } = renderPage(page);
    const banner = screen.getByRole('region', { name: en.text('summary.withheld') });
    const header = screen.getByRole('heading', { level: 1 });
    const summary = screen.getByRole('region', { name: en.text('summary.heading') });
    expect(precedes(banner, header)).toBe(true);
    expect(precedes(banner, summary)).toBe(true);
    expect(container.textContent.startsWith(banner.textContent)).toBe(true);
    expect(banner.textContent).toContain(PARTIAL_RUN_TEXT);
  });

  it('002 FR-007 shows the gate as undecided', () => {
    renderPage(page);
    const summary = screen.getByRole('region', { name: en.text('summary.heading') });
    const gate = within(summary).getByText(en.text('summary.gate'), { selector: 'dt' });
    expect(gate.nextElementSibling?.textContent).toBe('UNDECIDED');
  });

  it('002 FR-007 still renders the cells and the metrics', () => {
    const partial = renderPage(page);
    for (const cell of page.comparison.cells) {
      const parts = [cell.ruleId, cell.lang, verdictText('en', cell.verdict)];
      const named = (name: string) => parts.every((part) => name.includes(part));
      expect(screen.getAllByRole('button', { name: named }).length).toBeGreaterThan(0);
    }
    const partialHeadings = headingTexts();
    partial.unmount();
    // Every region of a finished comparison, the metrics among them, is on the partial page too.
    renderPage(loadComparisonPage('page-comparison-block.json'));
    expect(headingTexts().filter((text) => !partialHeadings.includes(text))).toEqual([]);
  });

  it('002 FR-007 shows no banner on the pages of complete comparisons', () => {
    for (const name of COMPLETE_PAGES) {
      const complete = loadComparisonPage(name);
      const { unmount } = renderPage(complete);
      const withheld = pageMessages(complete.lang).text('summary.withheld');
      expect(screen.queryByRole('region', { name: withheld }), name).toBeNull();
      unmount();
    }
  });
});
