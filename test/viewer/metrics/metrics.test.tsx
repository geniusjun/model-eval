import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  dollars,
  NONE,
  percent,
  percentInterval,
  seconds,
  tokenMean,
} from '../../../src/report/format.js';
import { opsRateNames, type Comparison } from '../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../../viewer/src/i18n/useMessages.js';
import { LatencyChart } from '../../../viewer/src/domains/metrics/LatencyChart.js';
import { MetricsTable } from '../../../viewer/src/domains/metrics/MetricsTable.js';
import { loadComparison } from '../fixtures.js';

const messages = pageMessages('en');
const text: Messages['text'] = (key, params) => messages.text(key, params);
const ROLES = ['baseline', 'candidate'] as const;
const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;
const FINISH_REASONS = ['stop', 'length', 'content_filter', 'other'] as const;

/** The block fixture with every list of `ops` filled and values that differ per variant. */
function comparisonWithAllFields(): Comparison {
  const comparison = loadComparison('block');
  const { baseline, candidate } = comparison.ops;
  baseline.systematic = { trials: 4, cases: 2 };
  baseline.sideCallFailures = [{ kind: 'timeout', count: 3 }];
  baseline.abandoned = { timeout: 2, restart: 1 };
  baseline.topMessages = [{ kind: 'permanent', message: '<b>refused</b> $&', count: 2 }];
  candidate.finishReasons = { stop: 290, length: 6, content_filter: 2, other: 2 };
  candidate.tokensPerTrial = { input: 160.25, output: 30 };
  candidate.costPerTrialUsd = null;
  candidate.responseModels = [
    { model: 'model-b-2026-10-01', trials: 290 },
    { model: 'model-b-2026-11-01', trials: 10 },
  ];
  return comparison;
}

function variantIds(comparison: Comparison) {
  return { baseline: comparison.baseline.variant.id, candidate: comparison.candidate.variant.id };
}

function latencyOf(comparison: Comparison) {
  return {
    baseline: comparison.ops.baseline.latencyMs,
    candidate: comparison.ops.candidate.latencyMs,
  };
}

function metricsTable(): HTMLElement {
  return screen.getByRole('table', { name: text('metrics.table.caption') });
}

/** The baseline and candidate cells of the row headed `label`. */
function rowCells(table: HTMLElement, label: string): string[] {
  const row = within(table).getByRole('rowheader', { name: label }).closest('tr');
  if (row === null) {
    throw new Error(`no row for ${label}`);
  }
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

function rowsOf(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
}

describe('002 MetricsTable', () => {
  it('002 FR-006 heads its columns with both variants', () => {
    const comparison = loadComparison('block');
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    const headers = within(metricsTable())
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual([
      text('metrics.column.metric'),
      'Baseline (current)',
      'Candidate (next)',
    ]);
  });

  it('002 FR-006 shows the eight rates per variant with their counts and intervals', () => {
    const comparison = loadComparison('block');
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    const table = metricsTable();
    for (const name of opsRateNames) {
      const cells = rowCells(table, text(`metrics.rate.${name}`));
      ROLES.forEach((role, index) => {
        const rate = comparison.ops[role].rates[name];
        const cell = cells[index];
        expect(cell, `${name} ${role}`).toContain(percent(rate.rate));
        expect(cell, `${name} ${role}`).toContain(percentInterval(rate.low, rate.high));
        expect(cell, `${name} ${role}`).toContain(
          text('metrics.countOf', { count: rate.count, total: rate.total }),
        );
      });
    }
    const interval = within(table).getAllByRole('img');
    expect(interval).toHaveLength(opsRateNames.length * ROLES.length);
  });

  it('002 FR-006 shows systematic failures, abandoned trials and finish reasons per variant', () => {
    const comparison = comparisonWithAllFields();
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    const table = metricsTable();
    const { baseline, candidate } = comparison.ops;
    expect(rowCells(table, text('metrics.systematic.trials'))).toEqual([
      String(baseline.systematic.trials),
      String(candidate.systematic.trials),
    ]);
    expect(rowCells(table, text('metrics.systematic.cases'))).toEqual([
      String(baseline.systematic.cases),
      String(candidate.systematic.cases),
    ]);
    expect(rowCells(table, text('metrics.abandoned.timeout'))).toEqual(['2', '0']);
    expect(rowCells(table, text('metrics.abandoned.restart'))).toEqual(['1', '0']);
    for (const reason of FINISH_REASONS) {
      expect(rowCells(table, text('metrics.finishReason', { reason }))).toEqual([
        String(baseline.finishReasons[reason]),
        String(candidate.finishReasons[reason]),
      ]);
    }
  });

  it('002 FR-006 shows p50, p95, the five token means and cost per trial with null as a dash', () => {
    const comparison = comparisonWithAllFields();
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    const table = metricsTable();
    const { baseline, candidate } = comparison.ops;
    expect(rowCells(table, text('metrics.latencyP50'))).toEqual([
      seconds(baseline.latencyMs.p50),
      seconds(candidate.latencyMs.p50),
    ]);
    expect(rowCells(table, text('metrics.latencyP95'))).toEqual([
      seconds(baseline.latencyMs.p95),
      seconds(candidate.latencyMs.p95),
    ]);
    for (const field of TOKEN_FIELDS) {
      const expected = ROLES.map((role) => {
        const mean = comparison.ops[role].tokensPerTrial[field];
        return mean === undefined ? NONE : tokenMean(mean);
      });
      expect(rowCells(table, text(`metrics.tokens.${field}`)), field).toEqual(expected);
    }
    expect(rowCells(table, text('metrics.tokens.input'))).toEqual(['152', '160.3']);
    expect(rowCells(table, text('metrics.tokens.cacheWrite'))).toEqual(['0', NONE]);
    expect(rowCells(table, text('metrics.costPerTrial'))).toEqual([
      dollars(baseline.costPerTrialUsd),
      NONE,
    ]);
  });

  it('002 FR-006 lists top messages with their error kind and count, as text', () => {
    const comparison = comparisonWithAllFields();
    const { container } = render(
      <MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />,
    );
    const table = screen.getByRole('table', { name: text('metrics.topMessages') });
    expect(rowsOf(table)).toEqual([
      ['current', 'permanent', '2', '<b>refused</b> $&'],
      ['next', 'transient', '10', '429 rate limited `retry`'],
    ]);
    expect(container.querySelector('b')).toBeNull();
  });

  it('002 FR-006 lists side-call failures per kind and response models with their trials', () => {
    const comparison = comparisonWithAllFields();
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    const sideCalls = screen.getByRole('table', { name: text('metrics.sideCallFailures') });
    expect(rowsOf(sideCalls)).toEqual([['current', 'timeout', '3']]);
    const models = screen.getByRole('table', { name: text('metrics.responseModels') });
    expect(rowsOf(models)).toEqual([
      ['current', 'model-a-2026-01-01', '300'],
      ['next', 'model-b-2026-10-01', '290'],
      ['next', 'model-b-2026-11-01', '10'],
    ]);
  });

  it('002 FR-006 says so when neither variant has a list entry', () => {
    const comparison = loadComparison('block');
    render(<MetricsTable lang="en" ops={comparison.ops} variantIds={variantIds(comparison)} />);
    expect(screen.queryByRole('table', { name: text('metrics.sideCallFailures') })).toBeNull();
    const heading = screen.getByRole('heading', { name: text('metrics.sideCallFailures') });
    expect(heading.nextElementSibling?.textContent).toBe(text('metrics.none'));
  });
});

function latencyComparison(baseline: number[], candidate: number[]): Comparison {
  const comparison = loadComparison('block');
  comparison.ops.baseline.latencyMs = { p50: baseline[0] ?? null, p95: null, values: baseline };
  comparison.ops.candidate.latencyMs = { p50: candidate[0] ?? null, p95: null, values: candidate };
  return comparison;
}

function chartOf(variant: string): SVGSVGElement {
  const chart = screen
    .getAllByRole('img')
    .find((image) => image.querySelector('title')?.textContent.startsWith(`${variant}:`));
  if (!(chart instanceof SVGSVGElement)) {
    throw new Error(`no latency chart for ${variant}`);
  }
  return chart;
}

function marksOf(chart: SVGSVGElement): { x: number; width: number; height: number }[] {
  return [...chart.querySelectorAll('rect')].map((mark) => ({
    x: Number(mark.getAttribute('x')),
    width: Number(mark.getAttribute('width')),
    height: Number(mark.getAttribute('height')),
  }));
}

/** plan D6: the chart has 20 equal-width bins. */
const LATENCY_BINS = 20;

function chartWidth(chart: SVGSVGElement): number {
  return Number(chart.getAttribute('viewBox')?.split(' ')[2]);
}

describe('002 LatencyChart', () => {
  it('002 FR-006 is an SVG image per variant whose title holds p50 and p95', () => {
    const comparison = loadComparison('block');
    render(
      <LatencyChart
        lang="en"
        latency={latencyOf(comparison)}
        variantIds={variantIds(comparison)}
      />,
    );
    for (const role of ROLES) {
      const chart = chartOf(comparison[role].variant.id);
      const title = chart.querySelector('title')?.textContent;
      const { p50, p95 } = comparison.ops[role].latencyMs;
      expect(chart.tagName.toLowerCase()).toBe('svg');
      expect(title).toContain(seconds(p50));
      expect(title).toContain(seconds(p95));
    }
  });

  it('002 FR-006 draws one mark per bin of the values for each variant on one shared scale', () => {
    const comparison = latencyComparison([0, 0, 1000], [1000, 2000]);
    render(
      <LatencyChart
        lang="en"
        latency={latencyOf(comparison)}
        variantIds={variantIds(comparison)}
      />,
    );
    const baseline = marksOf(chartOf('current'));
    const candidate = marksOf(chartOf('next'));
    expect(baseline).toHaveLength(2);
    expect(candidate).toHaveLength(2);
    const [zero, baselineMiddle] = baseline;
    const [candidateMiddle, top] = candidate;
    // 20 equal bins from 0 to 2000 ms: 0 ms in bin 0, 1000 ms in bin 10, 2000 ms in bin 19.
    const binWidth = chartWidth(chartOf('next')) / LATENCY_BINS;
    for (const mark of [...baseline, ...candidate]) {
      expect(mark.width).toBeCloseTo(binWidth);
    }
    expect(zero?.x).toBe(0);
    expect(baselineMiddle?.x).toBeCloseTo(10 * binWidth);
    expect(candidateMiddle?.x).toBeCloseTo(10 * binWidth);
    expect(top?.x).toBeCloseTo(19 * binWidth);
    // Heights are each variant's share of its values, on one height scale: 2/3, 1/3 and 1/2.
    expect(baselineMiddle?.height).toBeCloseTo((zero?.height ?? 0) / 2);
    expect(candidateMiddle?.height).toBeCloseTo(((zero?.height ?? 0) * 3) / 4);
    expect(top?.height).toBeCloseTo(candidateMiddle?.height ?? 0);
  });

  it('002 FR-006 draws one mark for values that share a bin', () => {
    const comparison = latencyComparison([1500, 1500, 1500], [3000]);
    render(
      <LatencyChart
        lang="en"
        latency={latencyOf(comparison)}
        variantIds={variantIds(comparison)}
      />,
    );
    expect(marksOf(chartOf('current'))).toHaveLength(1);
    expect(marksOf(chartOf('next'))).toHaveLength(1);
  });

  it('002 FR-006 draws nothing for a variant without values and says no latency was measured', () => {
    const comparison = latencyComparison([800, 1200], []);
    render(
      <LatencyChart
        lang="en"
        latency={latencyOf(comparison)}
        variantIds={variantIds(comparison)}
      />,
    );
    expect(marksOf(chartOf('current'))).toHaveLength(2);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByText(text('metrics.latency.notMeasured', { variant: 'next' }))).toBeTruthy();
  });
});
