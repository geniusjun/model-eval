import { describe, expect, it } from 'vitest';

import { CATALOGS } from '../../../src/messages/index.js';
import { renderReport } from '../../../src/report/markdown.js';
import type { Comparison, SampleText } from '../../../src/report/schema.js';
import { COMPARISON_FIXTURES, loadComparison } from './fixtures.js';
import { longestBacktickRun, scanMarkdown } from './markdown-scan.js';

const EN_SECTIONS = [
  'Decision summary and gate',
  'Cells',
  'Failing examples of regressed cells',
  'Post-processing',
  'Low baseline compliance',
  'Anchors and origins',
  'Operational metrics and warnings',
  'Judged scope',
  'Reproduction',
];

function section(markdown: string, index: number): string {
  const heading = [...scanMarkdown(markdown).sections.keys()][index];
  if (heading === undefined) {
    throw new Error(`no section ${String(index)}`);
  }
  return scanMarkdown(markdown).sections.get(heading) ?? '';
}

function codeContents(markdown: string): string[] {
  return scanMarkdown(markdown).code.map((segment) => segment.content);
}

function sampleStrings(text: SampleText): string[] {
  if ('error' in text) {
    return [text.error.message];
  }
  return text.final === undefined ? [text.raw] : [text.raw, text.final];
}

/**
 * Every string outside the samples that a model, the service or the adapter produced. Sample
 * texts reach the report only as failing examples; `review` samples are for the result page.
 */
function serviceStrings(comparison: Comparison): string[] {
  const evidence = comparison.samples.failing.flatMap((cell) =>
    cell.keys.flatMap((key) => key.evidence ?? []),
  );
  const ops = [comparison.ops.baseline, comparison.ops.candidate].flatMap((variant) => [
    ...variant.discardReasons.map((reason) => reason.discardReason),
    ...variant.topMessages.map((top) => top.message),
    ...variant.responseModels.map((model) => model.model),
  ]);
  const sentences = comparison.warnings.flatMap((warning) =>
    warning.code === 'adapter-warnings' ? [warning.params.sentence] : [],
  );
  const runs = [comparison.baseline, comparison.candidate].flatMap((run) => [
    run.variant.model,
    run.adapter.name,
    run.adapter.version,
  ]);
  return [...evidence, ...ops, ...sentences, ...runs];
}

/** Rule texts from the rule files: free text the report fences as well. */
function ruleStrings(comparison: Comparison): string[] {
  return comparison.rules.flatMap((rule) => [
    rule.title,
    ...rule.anchors.map((anchor) => anchor.quote),
  ]);
}

/** The sample texts of the failing examples, raw before final. */
function failingTexts(comparison: Comparison): string[] {
  return comparison.samples.failing.flatMap((cell) =>
    cell.keys.flatMap((key) => {
      const text = comparison.samples.texts.find(
        (candidate) =>
          candidate.variant === key.variant &&
          candidate.caseId === key.caseId &&
          candidate.repeat === key.repeat,
      );
      return text === undefined ? [] : sampleStrings(text);
    }),
  );
}

function hostileComparison(): Comparison {
  const comparison = loadComparison('block');
  const hostile = [
    'line one\n\n# not a heading\n| a | b |',
    '`starts and ends with a backtick`',
    '````` five backticks and <a href="http://x">@team</a> |',
    ' padded ',
  ];
  comparison.ops.candidate.discardReasons = hostile.map((discardReason, count) => ({
    discardReason,
    count,
  }));
  comparison.ops.candidate.topMessages = hostile.map((message, count) => ({
    kind: 'transient',
    message,
    count,
  }));
  comparison.rules[1] = {
    id: 'script-ja',
    title: hostile[2] ?? '',
    severity: 'blocking',
    languages: ['ja'],
    gateOn: 'raw',
    margin: 0.1,
    anchors: [{ lang: 'ja', quote: hostile[1] ?? '' }],
    origin: [],
  };
  return comparison;
}

describe('report.md', () => {
  it('001 FR-029 writes the sections in the order of FR-029', () => {
    for (const kind of COMPARISON_FIXTURES) {
      const headings = [...scanMarkdown(renderReport(loadComparison(kind), 'en')).sections.keys()];
      expect(headings, kind).toEqual(EN_SECTIONS);
    }
  });

  it('001 FR-034 writes the Korean report with the same sections from the Korean messages', () => {
    const headings = [...scanMarkdown(renderReport(loadComparison('block'), 'ko')).sections.keys()];
    expect(headings).toHaveLength(EN_SECTIONS.length);
    const korean = new Set(Object.values(CATALOGS.ko));
    for (const heading of headings) {
      expect(korean.has(heading), heading).toBe(true);
      expect(EN_SECTIONS).not.toContain(heading);
    }
  });

  it('001 FR-029 starts with the gate result and its reasons in the message text', () => {
    const report = renderReport(loadComparison('block'), 'en');
    const summary = section(report, 0);
    expect(summary).toContain('BLOCK');
    expect(summary).toContain('script-ja (ja, raw): This gated cell regressed.');
    expect(summary).toContain(
      'completed (ja, trial): Abandoned trials inside the systematic failures: current (timeout 0, restart 0), next (timeout 1, restart 0) (tool time limit current 120000, next 120000 ms).',
    );
    expect(section(renderReport(loadComparison('no-gate'), 'en'), 0)).toContain(
      'The gate is empty, so nothing can block.',
    );
    expect(section(renderReport(loadComparison('undecided-partial'), 'en'), 0)).toContain(
      'Withheld because a compared run is not finished: next (status partial, stopReason budget).',
    );
  });

  it('001 FR-028 orders the decision summary and words notes and trials needed from the messages', () => {
    const summary = section(renderReport(loadComparison('block'), 'en'), 0);
    const order = ['Worse', 'Better', 'Undecided', 'Operations', 'Scope'].map((label) =>
      summary.indexOf(`${label}:`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(summary).toContain('drop confirmed, margin not decided');
    expect(summary).toContain(
      'a new run with 15 repeats gives this cell 450 trials per variant (now 150) and the whole run 900 trials per variant; about 80% chance of a verdict (estimate)',
    );
    expect(summary).toContain('exactly on the margin, repeats are unlikely to settle it');
    expect(summary).toContain('repeats cannot settle it; about 3 cases are needed');
    expect(summary).toContain('Earlier comparisons of these two variants: 1');
  });

  it('001 FR-034 words codes in the language it is given', () => {
    const report = renderReport(loadComparison('block'), 'ko');
    expect(report).toContain(CATALOGS.ko['reason.regressed']);
    expect(report).toContain(CATALOGS.ko['note.drop-margin-undecided']);
    expect(report).toContain(CATALOGS.ko['needed.on-margin']);
    expect(report).not.toContain(CATALOGS.en['reason.regressed']);
  });

  it('001 FR-021 tables every cell with both rates, the difference and the verdict', () => {
    const comparison = loadComparison('block');
    const cells = section(renderReport(comparison, 'en'), 1);
    const rows = cells
      .split('\n')
      .filter((line) => /^\| [a-z0-9._-]+ \| [^|]+ \| (raw|final|trial) \|/.test(line));
    expect(rows).toHaveLength(comparison.cells.length);
    const regressed = rows.find((row) => row.startsWith('| script-ja | ja | raw |'));
    expect(regressed).toContain('99.3% [95.3, 100.0]');
    expect(regressed).toContain('70.0% [64.0, 73.0]');
    expect(regressed).toContain('-29.3pp [-37.1, -19.2]');
    expect(regressed).toContain('×45');
    expect(regressed).not.toContain('×45.00');
    expect(regressed).toContain('| 10pp |');
    expect(regressed).toContain('Regressed');
    const baselineZero = rows.find((row) => row.startsWith('| script-ja | ja | final |'));
    expect(baselineZero).toContain('baseline 0');
  });

  it('001 FR-029 shows the raw and final text of each failing example of a regressed cell', () => {
    const comparison = loadComparison('block');
    const failing = section(renderReport(comparison, 'en'), 2);
    const blocks = scanMarkdown(failing).code.filter((segment) => segment.block);
    expect(blocks.map((block) => block.content)).toEqual(failingTexts(comparison));
    expect(failing).toContain('script-ja (ja, raw)');
    expect(scanMarkdown(failing).code.map((segment) => segment.content)).toEqual(
      expect.arrayContaining(['안', '녕']),
    );
  });

  it('001 FR-029 lists the cells whose baseline is below config.report.lowBaseline', () => {
    const comparison = loadComparison('block');
    expect(section(renderReport(comparison, 'en'), 4)).not.toMatch(/^\| (script-ja|no-emoji)/m);
    comparison.config.report.lowBaseline = 0.995;
    const low = section(renderReport(comparison, 'en'), 4);
    const rows = low.split('\n').filter((line) => /^\| [a-z]/.test(line));
    expect(rows.map((row) => row.split(' | ').slice(0, 3).join(' | '))).toEqual([
      '| script-ja | ja | raw',
      '| no-emoji | ko | raw',
    ]);
    expect(low).toContain('99.5%');
    expect(low).not.toContain('| Gated |');
  });

  it('001 FR-029 a cell whose baseline equals config.report.lowBaseline is not low baseline', () => {
    const comparison = loadComparison('block');
    comparison.config.report.lowBaseline = 0.9866666666666667;
    const low = section(renderReport(comparison, 'en'), 4);
    expect(low.split('\n').filter((line) => /^\| [a-z]/.test(line))).toEqual([]);
  });

  it('001 FR-029 escapes | in table cells, so a language key cannot add a column', () => {
    const comparison = loadComparison('block');
    comparison.cells = comparison.cells.map((cell) => ({ ...cell, lang: `${cell.lang}|x` }));
    comparison.config.report.lowBaseline = 0.995;
    const report = renderReport(comparison, 'en');
    for (const index of [1, 4]) {
      const [table = ''] = section(report, index)
        .split(/\n\n/)
        .filter((part) => part.startsWith('|'));
      const columns = table
        .split('\n')
        .filter((row) => row !== '')
        .map((row) => row.split(/(?<!\\)\|/).length);
      expect(columns.length, String(index)).toBeGreaterThan(2);
      expect(new Set(columns).size, String(index)).toBe(1);
      expect(table).toContain('ko\\|x');
    }
  });

  it('001 FR-029 never lists completed cells as low baseline, since row 3 of the gate covers them', () => {
    const comparison = loadComparison('block');
    comparison.config.report.lowBaseline = 0.9;
    comparison.cells = comparison.cells.map((cell) =>
      cell.surface === 'trial' ? { ...cell, baseline: { ...cell.baseline, rate: 0.6 } } : cell,
    );
    const low = section(renderReport(comparison, 'en'), 4);
    expect(low).not.toMatch(/^\| completed /m);
    expect(low).toContain('No cell has a baseline compliance below 90.0%.');
  });

  it('001 FR-029 takes anchors and origins from rules[]', () => {
    const comparison = loadComparison('block');
    const anchors = section(renderReport(comparison, 'en'), 5);
    expect(codeContents(anchors)).toEqual(
      expect.arrayContaining(['日本語だけで話す', '이모지를 붙이지 않는다', '1a2b3c4']),
    );
    expect(anchors).toContain('2026-01-15');
    expect(anchors).toContain('code');
    comparison.rules = comparison.rules.map((rule) => ({
      ...rule,
      anchors: rule.anchors.map((anchor) => ({ ...anchor, quote: `${anchor.quote} (edited)` })),
    }));
    expect(codeContents(section(renderReport(comparison, 'en'), 5))).toContain(
      '日本語だけで話す (edited)',
    );
  });

  it('001 FR-029 takes versions and post-processing from baseline and candidate', () => {
    const comparison = loadComparison('block');
    comparison.candidate.adapter.version = '9.9.9';
    comparison.candidate.service.version = 'service-commit-1';
    const reproduction = section(renderReport(comparison, 'en'), 8);
    expect(codeContents(reproduction)).toEqual(
      expect.arrayContaining(['0.3.0', '9.9.9', 'service-commit-1', 'model-a', 'model-b']),
    );
    expect(reproduction).toContain(comparison.baseline.runId);
    expect(reproduction).toContain(comparison.candidate.gradeSetId);

    const declared = section(renderReport(comparison, 'en'), 3);
    expect(declared).not.toContain('declares no post-processing');
    expect(codeContents(declared)).toContain('AnswerCut: the answer ended mid-sentence');
    comparison.candidate.postprocess = false;
    const undeclared = section(renderReport(comparison, 'en'), 3);
    expect(undeclared).toContain('next: the adapter declares no post-processing');
    expect(undeclared).not.toContain('current: the adapter declares no post-processing');
  });

  it('001 FR-023 writes operational metrics and warnings with their message text', () => {
    const ops = section(renderReport(loadComparison('block'), 'en'), 6);
    expect(ops).toContain(
      'Discard rate current 0.3%, next 3.0%: the candidate is more than 1.0pp above the baseline.',
    );
    expect(ops).toContain('Removed from the gate (review).');
    expect(ops).toContain('3.0% [2.0, 5.0] (9 of 300)');
    // The formats of contracts/cli.md §Human Output, which the human output shares.
    expect(ops).toContain('| 1.9s | 2.6s |');
    expect(ops).toContain('| $0.00017 | $0.00038 |');
    expect(codeContents(ops)).toEqual(
      expect.arrayContaining(['429 rate limited `retry`', 'model-b-2026-10-01']),
    );
  });

  it('001 FR-029 puts every model or service string in a fence longer than its longest backtick run', () => {
    const cases: [string, Comparison][] = [
      ...COMPARISON_FIXTURES.map((kind): [string, Comparison] => [kind, loadComparison(kind)]),
      ['hostile', hostileComparison()],
    ];
    for (const [name, comparison] of cases) {
      for (const lang of ['en', 'ko'] as const) {
        const report = renderReport(comparison, lang);
        const scanned = scanMarkdown(report);
        const contents = new Set(scanned.code.map((segment) => segment.content));
        for (const segment of scanned.code) {
          expect(segment.fence.length, name).toBeGreaterThan(longestBacktickRun(segment.content));
        }
        const shown = [
          ...serviceStrings(comparison),
          ...ruleStrings(comparison),
          ...failingTexts(comparison),
        ];
        for (const text of shown) {
          const inline = text.replace(/\r\n|\r|\n/g, ' ');
          expect(contents.has(text) || contents.has(inline), `${name} ${lang}: ${text}`).toBe(true);
        }
        const prose = scanned.prose.join('\n');
        expect(prose, `${name} ${lang}`).not.toMatch(/[<`@]/);
      }
    }
  });

  it('001 FR-029 gives the same report for the same Comparison', () => {
    const comparison = loadComparison('undecided-partial');
    expect(renderReport(comparison, 'en')).toBe(renderReport(structuredClone(comparison), 'en'));
  });
});
