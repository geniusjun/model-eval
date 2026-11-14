import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { neededText, noteText } from '../../../src/report/code-text.js';
import type { Cell, Comparison } from '../../../src/report/schema.js';
import en from '../../../viewer/src/i18n/en.json';
import { CellDetail } from '../../../viewer/src/domains/grid/CellDetail.js';
import { formatHash } from '../../../viewer/src/utils/hash.js';
import { loadComparison } from '../fixtures.js';

interface Place {
  readonly ruleId: string;
  readonly lang: string;
  readonly surface: string;
}

function findCell(comparison: Comparison, place: Place): Cell {
  const cell = comparison.cells.find(
    (candidate) =>
      candidate.ruleId === place.ruleId &&
      candidate.lang === place.lang &&
      candidate.surface === place.surface,
  );
  if (cell === undefined) {
    throw new Error(`no cell ${place.ruleId} ${place.lang} ${place.surface}`);
  }
  return cell;
}

function renderDetail(
  place: Place,
  comparison: Comparison = loadComparison('block'),
  onClose: () => void = () => undefined,
) {
  return render(
    <CellDetail
      cell={findCell(comparison, place)}
      rules={comparison.rules}
      samples={comparison.samples}
      lang="en"
      onClose={onClose}
      sideHref={(view) => formatHash({ view, lang: null })}
    />,
  );
}

/** The value of a labelled fact of the detail (`<dt>` label, `<dd>` value). */
function factValue(label: string): Element | null {
  const term = screen.queryAllByRole('term').find((element) => element.textContent === label);
  return term?.nextElementSibling ?? null;
}

function fact(label: string): string | null {
  return factValue(label)?.textContent ?? null;
}

/** The cells of the per-variant row whose header is `label`. */
function variantRow(label: string): HTMLElement[] {
  const header = screen.getByRole('rowheader', { name: label });
  const row = header.closest('tr');
  return row === null ? [] : within(row).getAllByRole('cell');
}

const SCRIPT_JA_RAW: Place = { ruleId: 'script-ja', lang: 'ja', surface: 'raw' };
const SCRIPT_JA_FINAL: Place = { ruleId: 'script-ja', lang: 'ja', surface: 'final' };
const NO_EMOJI_JA: Place = { ruleId: 'no-emoji', lang: 'ja', surface: 'raw' };
const COMPLETED_JA: Place = { ruleId: 'completed', lang: 'ja', surface: 'trial' };
const COMPLETED_KO: Place = { ruleId: 'completed', lang: 'ko', surface: 'trial' };

describe('002 CellDetail', () => {
  it('002 FR-004 shows both rates with intervals and an interval chart each', () => {
    renderDetail(SCRIPT_JA_RAW);
    expect(screen.getByRole('heading', { name: 'script-ja (ja, raw)' })).toBeDefined();
    const [baseline, candidate] = variantRow(en['grid.detail.rates']);
    expect(baseline?.textContent).toContain('99.3% [95.3, 100.0]');
    expect(candidate?.textContent).toContain('70.0% [64.0, 73.0]');
    const baselineChart = baseline === undefined ? null : within(baseline).getByRole('img');
    const candidateChart = candidate === undefined ? null : within(candidate).getByRole('img');
    expect(baselineChart?.querySelector('title')?.textContent).toContain('Baseline');
    expect(candidateChart?.querySelector('title')?.textContent).toContain('Candidate');
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toContain('Baseline');
    expect(headers).toContain('Candidate');
  });

  it('002 FR-004 shows the difference with its interval, the failure-rate ratio and the masked rate per variant', () => {
    renderDetail(SCRIPT_JA_RAW);
    const difference = factValue(en['grid.detail.difference']);
    expect(difference?.firstChild?.textContent).toBe('-29.3pp [-37.1, -19.2]');
    // plan D6: the difference has an interval bar too, titled in points.
    const differenceChart = difference?.querySelector('svg[role="img"]');
    expect(differenceChart?.querySelector('title')?.textContent).toBe(
      `${en['grid.detail.difference']}: -29.3pp [-37.1, -19.2]`,
    );
    expect(fact(en['grid.detail.failRatio'])).toBe('×45');
    const [baseline, candidate] = variantRow(en['grid.detail.masked']);
    expect(baseline?.textContent).toBe('0.7%');
    expect(candidate?.textContent).toBe('27.3%');
  });

  it('002 FR-004 shows the failing examples resolved by key, raw and final with their newlines', () => {
    const comparison = loadComparison('block');
    renderDetail(SCRIPT_JA_RAW, comparison);
    const text = comparison.samples.texts.find(
      (entry) => entry.variant === 'candidate' && entry.caseId === 'greet-ja',
    );
    if (text === undefined || 'error' in text || text.final === undefined) {
      throw new Error('the block fixture has a final text for next greet-ja');
    }
    const examples = screen.getByRole('list', { name: en['grid.detail.failing'] });
    const [example, ...rest] = within(examples).getAllByRole('listitem');
    expect(rest).toHaveLength(0);
    if (example === undefined) {
      throw new Error('no failing example');
    }
    const item = within(example);
    expect(item.getByText('Candidate · case greet-ja · repeat 0')).toBeDefined();
    expect(item.getByText('Raw answer (ended normally)')).toBeDefined();
    expect(item.getByText("Shipped text (the model's answer)")).toBeDefined();
    expect(text.raw).toContain('\n');
    const withText = (expected: string) =>
      item.queryAllByText((_, element) => element?.textContent === expected, { ignore: false });
    expect(withText(text.raw).length).toBeGreaterThan(0);
    expect(withText(text.final).length).toBeGreaterThan(0);
    expect(item.getByText(en['grid.sample.evidence'])).toBeDefined();
    expect(item.getByText('안')).toBeDefined();
    expect(item.getByText('녕')).toBeDefined();
  });

  it('002 FR-004 shows the no-final text and an error in place of the text', () => {
    const comparison = loadComparison('block');
    comparison.samples.texts = comparison.samples.texts.map((entry) =>
      entry.variant === 'candidate' && entry.caseId === 'greet-ja' && !('error' in entry)
        ? {
            variant: entry.variant,
            caseId: entry.caseId,
            repeat: entry.repeat,
            raw: entry.raw,
            finalKind: 'discarded',
            finishReason: 'length',
          }
        : entry,
    );
    comparison.samples.failing = comparison.samples.failing.map((entry) => ({
      ...entry,
      keys: [...entry.keys, { variant: 'candidate', caseId: 'mood-vague-ko', repeat: 0 }],
    }));
    renderDetail(SCRIPT_JA_RAW, comparison);
    const examples = within(screen.getByRole('list', { name: en['grid.detail.failing'] }));
    expect(examples.getAllByRole('listitem')).toHaveLength(2);
    expect(examples.getByText('Raw answer (cut off at the length limit)')).toBeDefined();
    expect(examples.getByText('No shipped text (discarded).')).toBeDefined();
    expect(examples.getByText('Error (transient)')).toBeDefined();
    expect(examples.getByText('429 rate limited <!-- $& -->')).toBeDefined();
  });

  it('002 FR-004 shows the anchored sentence for the cell language and the rule origin', () => {
    renderDetail(SCRIPT_JA_RAW);
    expect(screen.getByText('日本語だけで話す')).toBeDefined();
    expect(screen.getByText('1a2b3c4')).toBeDefined();
    expect(screen.getByText('2026-01-15')).toBeDefined();
    expect(screen.getByText('code')).toBeDefined();
  });

  it('002 FR-004 says when the cell language has no anchor and the rule no origin', () => {
    renderDetail(NO_EMOJI_JA);
    expect(screen.queryByText('이모지를 붙이지 않는다')).toBeNull();
    expect(screen.getByText('No prompt sentence is anchored for ja.')).toBeDefined();
    expect(screen.getByText(en['grid.detail.noOrigin'])).toBeDefined();
  });

  it('002 FR-004 shows "baseline 0" for a null ratio over a baseline rate of 1 and — for a null baseline rate', () => {
    const first = renderDetail(SCRIPT_JA_FINAL);
    expect(fact(en['grid.detail.failRatio'])).toBe(`baseline 0 ${en['grid.detail.noRatio']}`);
    first.unmount();
    renderDetail(NO_EMOJI_JA);
    expect(fact(en['grid.detail.failRatio'])).toBe('—');
  });

  it('002 FR-004 shows no masked rate on a surface other than raw', () => {
    renderDetail(SCRIPT_JA_FINAL);
    expect(screen.queryByRole('rowheader', { name: en['grid.detail.masked'] })).toBeNull();
  });

  it('002 FR-004 says when a cell has no failing example', () => {
    renderDetail(SCRIPT_JA_FINAL);
    expect(screen.getByText(en['grid.detail.noFailing'])).toBeDefined();
    expect(screen.queryByRole('list', { name: en['grid.detail.failing'] })).toBeNull();
  });

  it('002 FR-016 shows whether the cell is gated, its cases, its margin and its verdict', () => {
    const first = renderDetail(SCRIPT_JA_RAW);
    expect(fact(en['grid.detail.verdict'])).toBe('Regressed');
    expect(fact(en['grid.detail.gated'])).toBe('Yes');
    expect(fact(en['grid.detail.cases'])).toBe('30');
    expect(fact(en['grid.detail.margin'])).toBe('10pp');
    expect(fact(en['grid.detail.note'])).toBeNull();
    expect(fact(en['grid.detail.needed'])).toBeNull();
    first.unmount();
    renderDetail(SCRIPT_JA_FINAL);
    expect(fact(en['grid.detail.gated'])).toBe('No');
  });

  it('002 FR-016 shows dropped cases', () => {
    const comparison = loadComparison('block');
    comparison.cells = comparison.cells.map((cell) =>
      cell.ruleId === 'script-ja' && cell.surface === 'raw' ? { ...cell, droppedCases: 2 } : cell,
    );
    renderDetail(SCRIPT_JA_RAW, comparison);
    expect(fact(en['grid.detail.cases'])).toBe('30 (2 dropped)');
  });

  it('002 FR-016 shows the note, the needed text and systematic failures per variant of a completed cell', () => {
    const comparison = loadComparison('block');
    const cell = findCell(comparison, COMPLETED_JA);
    if (cell.note === undefined || cell.needed === undefined) {
      throw new Error('completed ja carries a note and needed in the block fixture');
    }
    const first = renderDetail(COMPLETED_JA, comparison);
    expect(fact(en['grid.detail.note'])).toBe(noteText('en', cell.note));
    expect(fact(en['grid.detail.needed'])).toBe(neededText('en', cell.needed, 150));
    expect(fact(en['grid.detail.failRatio'])).toBe('×10');
    const [baseline, candidate] = variantRow(en['grid.detail.systematic']);
    expect(baseline?.textContent).toBe('trials 0, cases 0');
    expect(candidate?.textContent).toBe('trials 2, cases 1');
    first.unmount();
    renderDetail(COMPLETED_KO, comparison);
    expect(fact(en['grid.detail.needed'])).toBe(
      'exactly on the margin, repeats are unlikely to settle it',
    );
  });

  it('002 FR-011 focuses its heading when it opens', () => {
    renderDetail(SCRIPT_JA_RAW);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'script-ja (ja, raw)' }),
    );
  });

  it('002 FR-011 closes with its close button and with Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDetail(SCRIPT_JA_RAW, loadComparison('block'), onClose);
    await user.click(screen.getByRole('button', { name: en['grid.detail.close'] }));
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByRole('heading', { name: 'script-ja (ja, raw)' }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
