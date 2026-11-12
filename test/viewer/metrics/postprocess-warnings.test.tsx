import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { percent, percentInterval } from '../../../src/report/format.js';
import type { Comparison } from '../../../src/report/schema.js';
import { PostprocessPanel } from '../../../viewer/src/domains/metrics/PostprocessPanel.js';
import { WarningList } from '../../../viewer/src/domains/metrics/WarningList.js';
import { pageMessages, type Messages } from '../../../viewer/src/i18n/useMessages.js';
import { loadComparison } from '../fixtures.js';

const messages = pageMessages('en');
const text: Messages['text'] = (key, params) => messages.text(key, params);
const ROLES = ['baseline', 'candidate'] as const;
const FIGURES = ['discard', 'fallback', 'regeneration'] as const;

function renderPanel(comparison: Comparison) {
  return render(
    <PostprocessPanel
      lang="en"
      cells={comparison.cells}
      ops={comparison.ops}
      postprocess={{
        baseline: comparison.baseline.postprocess,
        candidate: comparison.candidate.postprocess,
      }}
      variantIds={{
        baseline: comparison.baseline.variant.id,
        candidate: comparison.candidate.variant.id,
      }}
    />,
  );
}

function variantGroup(variant: string): HTMLElement {
  return screen.getByRole('group', { name: variant });
}

function rowsOf(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
}

describe('002 PostprocessPanel', () => {
  it('002 FR-016 shows the masked rates of every raw cell', () => {
    const comparison = loadComparison('block');
    comparison.cells.forEach((cell) => {
      if (cell.ruleId === 'no-emoji' && cell.lang === 'ko' && cell.surface === 'raw') {
        cell.masked = { baseline: null, candidate: 0.05 };
      }
    });
    renderPanel(comparison);
    const table = screen.getByRole('table', { name: text('metrics.postprocess.masked') });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual([
      text('metrics.postprocess.column.cell'),
      'Baseline (current)',
      'Candidate (next)',
    ]);
    expect(rowsOf(table)).toEqual([
      ['script-ja (ja, raw)', percent(0.007), percent(0.273)],
      ['no-emoji (ko, raw)', percent(null), percent(0.05)],
    ]);
  });

  it('002 FR-016 shows no masked table when no cell has a masked rate', () => {
    const comparison = loadComparison('block');
    comparison.cells.forEach((cell) => {
      delete cell.masked;
    });
    renderPanel(comparison);
    expect(screen.queryByRole('table', { name: text('metrics.postprocess.masked') })).toBeNull();
  });

  it('002 FR-016 shows per variant the discard, fallback and regeneration rates with counts and intervals', () => {
    const comparison = loadComparison('block');
    renderPanel(comparison);
    for (const role of ROLES) {
      const group = variantGroup(comparison[role].variant.id);
      const items = within(group)
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(items).toHaveLength(FIGURES.length);
      FIGURES.forEach((name, index) => {
        const rate = comparison.ops[role].rates[name];
        const item = items[index];
        expect(item, `${role} ${name}`).toContain(text(`metrics.rate.${name}`));
        expect(item, `${role} ${name}`).toContain(percent(rate.rate));
        expect(item, `${role} ${name}`).toContain(percentInterval(rate.low, rate.high));
        expect(item, `${role} ${name}`).toContain(
          text('metrics.countOf', { count: rate.count, total: rate.total }),
        );
      });
    }
  });

  it('002 FR-016 shows the discard reasons of each variant with their counts, as text', () => {
    const comparison = loadComparison('block');
    comparison.ops.candidate.discardReasons.push({ discardReason: '<img src=x> $1', count: 2 });
    const { container } = renderPanel(comparison);
    const reasons = (variant: string) =>
      rowsOf(
        within(variantGroup(variant)).getByRole('table', {
          name: text('metrics.postprocess.discardReasons'),
        }),
      );
    expect(reasons('current')).toEqual([['AnswerCut: the answer ended mid-sentence', '1']]);
    expect(reasons('next')).toEqual([
      ['AnswerCut: the answer ended mid-sentence', '9'],
      ['<img src=x> $1', '2'],
    ]);
    expect(container.querySelector('img')).toBeNull();
  });

  it('002 FR-016 says so when a variant discarded nothing', () => {
    const comparison = loadComparison('block');
    comparison.ops.baseline.discardReasons = [];
    renderPanel(comparison);
    const group = variantGroup('current');
    expect(within(group).queryByRole('table')).toBeNull();
    expect(within(group).getByText(text('metrics.postprocess.noDiscards'))).toBeTruthy();
  });

  it('002 FR-016 shows that a variant declares no post-processing in place of its figures', () => {
    const comparison: Comparison = loadComparison('block');
    comparison.candidate.postprocess = false;
    renderPanel(comparison);
    const group = variantGroup('next');
    expect(group.textContent).toContain(text('metrics.postprocess.none', { variant: 'next' }));
    expect(within(group).queryByRole('listitem')).toBeNull();
    expect(within(group).queryByRole('table')).toBeNull();
    expect(within(variantGroup('current')).getAllByRole('listitem')).toHaveLength(FIGURES.length);
  });
});

describe('002 WarningList', () => {
  it('002 FR-006 shows each warning text with its rule, language, variants and case IDs', () => {
    const labelled: readonly (readonly [string, Comparison['warnings'][number]])[] = [
      [
        'next · cases greet-ja',
        {
          code: 'adapter-warnings',
          variants: ['next'],
          caseIds: ['greet-ja'],
          params: { sentence: 'the service regenerated after a filter', trials: { next: 2 } },
        },
      ],
      [
        'current, next',
        {
          code: 'discard-rate-increase',
          variants: ['current', 'next'],
          params: { rates: { current: 0.003, next: 0.03 }, threshold: 0.01 },
        },
      ],
      [
        'no-unprompted-self-state',
        {
          code: 'excluded-from-gate',
          ruleId: 'no-unprompted-self-state',
          params: { cause: 'review' },
        },
      ],
      ['script-ja (ja)', { code: 'identical-repeats', ruleId: 'script-ja', lang: 'ja' }],
    ];
    render(<WarningList warnings={labelled.map(([, warning]) => warning)} lang="en" />);
    const items = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual(
      labelled.map(([label, warning]) => `${label} · ${messages.warning(warning)}`),
    );
  });

  it('002 FR-016 labels a warning with its rule and language', () => {
    const comparison = loadComparison('block');
    const warnings: Comparison['warnings'] = [
      {
        code: 'identical-repeats',
        ruleId: 'script-ja',
        lang: 'ja',
        variants: ['current', 'next'],
        caseIds: ['greet-ja', 'ask-ja'],
      },
      ...comparison.warnings,
    ];
    render(<WarningList warnings={warnings} lang="en" />);
    const first = within(screen.getByRole('list')).getAllByRole('listitem')[0];
    expect(first?.textContent).toBe(
      [
        'script-ja (ja)',
        'current, next',
        text('metrics.warnings.cases', { cases: 'greet-ja, ask-ja' }),
        messages.warning({ code: 'identical-repeats' }),
      ].join(' · '),
    );
  });

  it('002 FR-006 shows a message when there is no warning', () => {
    render(<WarningList warnings={[]} lang="en" />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(text('metrics.warnings.none'))).toBeTruthy();
  });

  it('002 FR-013 writes the warnings in the page language', () => {
    const { warnings } = loadComparison('block');
    render(<WarningList warnings={warnings} lang="ko" />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    warnings.forEach((warning, index) => {
      expect(items[index]?.textContent).toContain(pageMessages('ko').warning(warning));
    });
  });
});
