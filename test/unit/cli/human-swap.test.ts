import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ShownComparison } from '../../../src/cli/human/compare.js';
import { swapLines } from '../../../src/cli/human/swap.js';
import type { GradeSet } from '../../../src/grade/grade-set.js';
import { comparisonSchema, type Cell, type Comparison } from '../../../src/report/schema.js';
import type { RunEnd } from '../../../src/run/active-run.js';
import { manifestSchema, type Manifest } from '../../../src/run/manifest.js';
import type { SwapEnd } from '../../../src/run/swap.js';

// Human output of `swap` (contracts/cli.md §Human Output) on the block comparison fixture, which
// has the figures of that example.

const FIXTURES = new URL('../../fixtures/contracts/', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

function runEnd(comparison: Comparison, role: 'baseline' | 'candidate'): RunEnd {
  const run = comparison[role];
  const manifest: Manifest = manifestSchema.parse({
    ...manifestSchema.parse(fixture('manifest.json')),
    runId: run.runId,
    variant: run.variant,
    status: 'complete',
  });
  const { stopReason: _stopReason, ...complete } = manifest;
  const gradeSet: GradeSet = {
    header: {
      gradeSetId: run.gradeSetId,
      runId: run.runId,
      rulesHash: manifest.rulesHash,
      checkerVersion: '0.0.0',
      trialsFingerprint: manifest.rulesHash,
      casesHash: manifest.rulesHash,
    },
    grades: [],
  };
  return {
    runId: run.runId,
    runDir: `/runs/${run.runId}`,
    status: 'complete',
    manifest: complete,
    gradeSetId: run.gradeSetId,
    lines: [],
    gradeSet,
    adapterLogs: [],
  };
}

function swapEnd(comparison: Comparison): SwapEnd {
  const runs = {
    baseline: runEnd(comparison, 'baseline'),
    candidate: runEnd(comparison, 'candidate'),
  };
  return {
    record: {
      swapId: '20261105-101500-swap-a1b2',
      baselineRunId: runs.baseline.runId,
      candidateRunId: runs.candidate.runId,
      budget: { maxCostUsd: 1, scope: 'swap' },
      spentUsd: 0.25,
      segments: [{ segment: 1, startedAt: '2026-11-05T10:15:00Z', spentUsd: 0.25 }],
      status: 'complete',
      comparisonId: comparison.comparisonId,
    },
    runs,
    comparison,
  };
}

function block(change: (cells: Cell[]) => void = () => undefined): Comparison {
  const comparison = comparisonSchema.parse(fixture('comparison-block.json'));
  change(comparison.cells);
  return comparison;
}

function cellOf(cells: readonly Cell[], ruleId: string, lang: string): Cell {
  const cell = cells.find((each) => each.ruleId === ruleId && each.lang === lang);
  if (cell === undefined) {
    throw new Error(`no cell ${ruleId} ${lang}`);
  }
  return cell;
}

function output(
  comparison: Comparison,
  lang: 'en' | 'ko' = 'en',
  written?: ShownComparison,
): string {
  const view = { end: swapEnd(comparison), expectedUsd: 0.26, conservativeUsd: 0.85 };
  return swapLines(lang, {
    ...view,
    warnings: comparison.warnings,
    ...(written === undefined ? {} : { written }),
  })
    .map((line) => line.text)
    .join('\n');
}

const lineWith = (text: string, part: string): string =>
  text.split('\n').find((line) => line.includes(part)) ?? '';

describe('swap human output', () => {
  it('001 FR-028 starts the decision summary with the worse cell, its rates and its failure ratio', () => {
    const text = output(block());
    expect(text).toContain('  Worse        script-ja (ja, raw) 99.3% → 70.0%, failures ×45');
    expect(text.indexOf('Decision summary')).toBeLessThan(text.indexOf('Gate, '));
  });

  it('001 FR-028 writes margins without decimals, latency in seconds and cost per trial in dollars', () => {
    const text = output(block());
    expect(lineWith(text, '✗ ')).toMatch(/margin\s+10pp\s+Regressed/);
    expect(text).toMatch(/\n {2}latency p95 +1\.9s +2\.6s \(×1\.37\)\n/);
    expect(text).toMatch(/\n {2}cost per trial +\$0\.00017 +\$0\.00038 \(×2\.20\)/);
  });

  it('001 FR-028 labels operational rows and changes as contracts/cli.md does', () => {
    const text = output(block());
    for (const label of ['rejections', 'time-outs', 'transient', 'discards', 'fallbacks']) {
      expect(text).toMatch(new RegExp(`\\n {2}${label} +\\d`));
    }
    expect(lineWith(text, 'Operations   ')).toMatch(
      /discard rate [\d.]+% → [\d.]+%.* · cost per trial ×2\.20 · latency p95 ×1\.37/,
    );
  });

  it('001 FR-009 names the transient and adapter errors a completed cell left out', () => {
    const text = output(
      block((cells) => {
        Object.assign(cellOf(cells, 'completed', 'ko'), {
          excluded: {
            baseline: { transient: 0, adapter: 0 },
            candidate: { transient: 15, adapter: 1 },
          },
        });
      }),
    );
    const row = lineWith(text, '15 candidate transient errors excluded');
    expect(row).toContain('completed');
    expect(row).toContain('15 candidate transient errors excluded (no systematic failure)');
    expect(row).toContain('1 candidate adapter error excluded (no systematic failure)');
  });

  it('001 FR-022 shows n_min for a cell that has too few trials per variant (verdict row 7)', () => {
    const text = output(
      block((cells) => {
        const cell = cellOf(cells, 'no-emoji', 'ko');
        Object.assign(cell, {
          verdict: 'insufficient',
          baseline: { ...cell.baseline, nEff: 30 },
          candidate: { ...cell.candidate, nEff: 30 },
        });
      }),
    );
    // n_min(0.10) = ⌈1.959964² × 0.9 / 0.1⌉ = 35 (data-model §Statistics).
    expect(lineWith(text, 'no-emoji')).toContain('Too few samples (30 trials per variant < 35)');
    // completed × en has K = 2, so verdict row 2 decides it, not n_min.
    expect(lineWith(text, '? completed  en')).not.toContain('trials per variant <');
  });

  it('001 FR-028 points to samples.review in comparison.json, or to the result page when one is written', () => {
    const folder = '.model-eval/comparisons/cmp-3f9a1c0e2b7d';
    const written = { report: `${folder}/report.md`, comparison: `${folder}/comparison.json` };
    expect(block().scope.reviewRules).toHaveLength(1);
    const withoutPage = output(block(), 'en', written);
    expect(withoutPage).toContain(
      `Side by side: 1 review rule, see samples.review in ${folder}/comparison.json`,
    );
    expect(lineWith(withoutPage, 'Scope')).toContain(
      `(side by side in samples.review of ${folder}/comparison.json)`,
    );
    expect(withoutPage).not.toContain('result page');
    const withPage = output(block(), 'en', { ...written, page: `${folder}/report.html` });
    expect(withPage).toContain('Side by side: 1 review rule, see the result page');
    expect(lineWith(withPage, 'Scope')).toContain('(side by side on the result page)');
    expect(withPage).not.toContain('samples.review');
  });

  it('001 FR-034 writes the same output from the Korean messages', () => {
    const text = output(block(), 'ko');
    expect(text).toContain('판단 요약');
    expect(text).not.toContain('Decision summary');
  });
});
