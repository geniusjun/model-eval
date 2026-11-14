import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { Cell, Comparison } from '../../../src/report/schema.js';
import { DecisionSummary } from '../../../viewer/src/domains/summary/DecisionSummary.js';
import { pageMessages } from '../../../viewer/src/i18n/useMessages.js';
import { loadComparison } from '../fixtures.js';

const en = pageMessages('en');

afterEach(() => {
  window.location.hash = '';
});

function renderSummary(comparison: Comparison = loadComparison('block'), lang: 'en' | 'ko' = 'en') {
  const { unmount } = render(<DecisionSummary comparison={comparison} lang={lang} />);
  const region = screen.getByRole('region', {
    name: pageMessages(lang).text('summary.heading'),
  });
  return { region, unmount };
}

/** The `<dd>` that follows the `<dt>` holding `term`. */
function definition(region: HTMLElement, term: string): HTMLElement {
  const dd = within(region).getByText(term, { selector: 'dt' }).nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') {
    throw new Error(`no definition follows ${term}`);
  }
  return dd;
}

function itemTexts(element: HTMLElement): string[] {
  return within(element)
    .queryAllByRole('listitem')
    .map((item) => item.textContent);
}

/** The section a level-3 heading of that name opens. */
function sectionOf(region: HTMLElement, name: string): HTMLElement {
  const section = within(region).getByRole('heading', { name, level: 3 }).closest('section');
  if (section === null) {
    throw new Error(`no section holds ${name}`);
  }
  return section;
}

function precedes(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** The change chart: its row groups, each as its header and the row headers of its cells. */
function changeChart(region: HTMLElement): { group: string; cells: string[] }[] {
  const table = within(sectionOf(region, en.text('summary.changes'))).getByRole('table');
  return [...table.querySelectorAll('tbody')].map((body) => ({
    group: body.querySelector('tr')?.textContent ?? '',
    cells: [...body.querySelectorAll('tr + tr th[scope="row"] a')].map((link) => link.textContent),
  }));
}

/** The row of the change chart whose cell link reads `label`. */
function changeRow(region: HTMLElement, label: string): HTMLElement {
  const link = within(sectionOf(region, en.text('summary.changes'))).getByRole('link', {
    name: label,
  });
  const row = link.closest('tr');
  if (row === null) {
    throw new Error(`no row for ${label}`);
  }
  return row;
}

/** The rows of the cost, speed and errors table as `[measure, values, change]`. */
function tradeRows(region: HTMLElement): string[][] {
  const table = within(sectionOf(region, en.text('summary.ops'))).getByRole('table');
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => {
      const cells = [...row.querySelectorAll('th, td')];
      return [cells[0], cells[2], cells[3]].map((cell) => cell?.textContent ?? '');
    });
}

const DROP_UNDECIDED = 'drop confirmed, margin not decided';

describe('002 DecisionSummary', () => {
  it('002 FR-016 shows the gate outcome with the gated cell count and the prior comparisons', () => {
    const { region } = renderSummary();
    expect(definition(region, en.text('summary.gate')).textContent).toBe('BLOCK');
    expect(definition(region, en.text('summary.gatedCells')).textContent).toBe('4');
    expect(definition(region, en.text('summary.priorComparisons')).textContent).toBe('1');
  });

  it('002 FR-002 explains the gate outcome in one sentence right after it', () => {
    const { region } = renderSummary();
    expect(definition(region, en.text('summary.gate')).nextElementSibling?.textContent).toBe(
      'script-ja (ja, raw) dropped from 99.3% to 70.0%, beyond its 10pp margin, so the gate blocks.',
    );
  });

  it('002 FR-002 says why there is no block for the other outcomes', () => {
    const sentence = (comparison: Comparison) => {
      const { region, unmount } = renderSummary(comparison);
      const text = definition(region, en.text('summary.gate')).nextElementSibling?.textContent;
      unmount();
      return text;
    };
    const block = loadComparison('block');
    expect(sentence({ ...block, gate: { ...block.gate, outcome: 'pass' } })).toBe(
      en.text('summary.conclusion.pass'),
    );
    expect(sentence(loadComparison('undecided-partial'))).toBe(
      en.text('summary.conclusion.withheld'),
    );
    expect(sentence(loadComparison('no-gate'))).toBe(en.text('summary.conclusion.noGate'));
  });

  it('002 FR-002 states each gate reason in the order of gate.reasons', () => {
    const { region } = renderSummary();
    expect(itemTexts(definition(region, en.text('summary.reasons')))).toEqual([
      'script-ja (ja, raw): This gated cell regressed.',
      'completed (ja, trial): This gated cell is undecided.',
      'completed (ko, trial): This gated cell is undecided.',
      'completed (en, trial): This gated cell is undecided.',
      'completed (ja, trial): Abandoned trials inside the systematic failures: current (timeout 0, restart 0), next (timeout 1, restart 0) (tool time limit current 120000, next 120000 ms).',
    ]);
  });

  it('002 FR-002 marks the cells of gate.blocking as blocking', () => {
    const { region } = renderSummary();
    expect(itemTexts(definition(region, en.text('summary.blocking')))).toEqual([
      'script-ja (ja, raw)',
    ]);
  });

  it('002 FR-002 puts the gate above the sections, and the sections in the order of 001 FR-028', () => {
    const { region } = renderSummary();
    const headings = within(region).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      en.text('summary.changes'),
      en.text('summary.examples'),
      en.text('summary.ops'),
      en.text('summary.scope'),
    ]);
    const gate = within(region).getByText(en.text('summary.gate'), { selector: 'dt' });
    const reasons = definition(region, en.text('summary.reasons'));
    const prior = definition(region, en.text('summary.priorComparisons'));
    for (const element of [gate, reasons, prior]) {
      expect(precedes(element, headings[0] ?? region)).toBe(true);
    }
  });

  it('002 FR-002 charts worse, better and undecided cells in that order, the largest drop first', () => {
    const { region } = renderSummary();
    expect(changeChart(region)).toEqual([
      {
        group: `${en.text('summary.worse')} 3`,
        cells: ['script-ja (ja, raw)', 'completed (ko, trial)', 'completed (ja, trial)'],
      },
      { group: `${en.text('summary.improved')} 0`, cells: [] },
      { group: `${en.text('summary.unknown')} 1`, cells: ['completed (en, trial)'] },
    ]);
  });

  it('002 FR-002 gives each charted cell its verdict, rates, failure-rate ratio, note, difference and interval', () => {
    const { region } = renderSummary();
    const regressed = changeRow(region, 'script-ja (ja, raw)');
    expect(regressed.textContent).toContain('Regressed');
    expect(regressed.textContent).toContain('99.3% (149/150) → 70.0% (105/150)');
    expect(regressed.textContent).toContain('failures ×45');
    expect(regressed.textContent).toContain('-29.3pp');
    expect(regressed.textContent).toContain('[-37.1, -19.2]');
    const chart = within(regressed).getByRole('img');
    expect(chart.querySelector('title')?.textContent).toBe(
      'script-ja (ja, raw): difference -29.3pp [-37.1, -19.2], margin -10pp',
    );
    const undecided = changeRow(region, 'completed (ko, trial)');
    expect(undecided.textContent).toContain('Inconclusive');
    expect(undecided.textContent).toContain('100.0% (150/150) → 90.0% (135/150)');
    expect(undecided.textContent).toContain('0 baseline failures');
    expect(undecided.textContent).toContain(DROP_UNDECIDED);
  });

  it('002 FR-002 shows a cell with a confirmed drop that is also undecided once, under worse, with what a new run needs', () => {
    const { region } = renderSummary();
    const chart = changeChart(region);
    const label = 'completed (ja, trial)';
    expect(chart.flatMap((group) => group.cells).filter((cell) => cell === label)).toHaveLength(1);
    expect(chart[0]?.cells).toContain(label);
    expect(changeRow(region, label).textContent).toContain(
      'a new run with 15 repeats gives this cell 450 trials per variant (now 150) and the whole run 900 trials per variant; about 80% chance of a verdict (estimate)',
    );
    expect(changeRow(region, 'completed (en, trial)').textContent).toContain(
      'repeats cannot settle it; about 3 cases are needed',
    );
  });

  it('002 FR-002 marks the cells that block the gate and draws a cell outside the gate as an outline', () => {
    const comparison = loadComparison('block');
    const outside = comparison.cells.find(
      (cell) => cell.ruleId === 'completed' && cell.lang === 'ja' && cell.surface === 'trial',
    );
    if (outside === undefined) {
      throw new Error('the block fixture has completed (ja, trial)');
    }
    outside.gated = false;
    const { region } = renderSummary(comparison);
    const blocking = changeRow(region, 'script-ja (ja, raw)');
    expect(blocking.textContent).toContain(en.text('summary.changes.blocking'));
    expect(blocking.textContent).toContain('(149/150) → 70.0% (105/150)');
    expect(changeRow(region, 'completed (ko, trial)').textContent).not.toContain(
      en.text('summary.changes.blocking'),
    );
    const outsideRow = changeRow(region, 'completed (ja, trial)');
    expect(outsideRow.textContent).toContain(en.text('summary.changes.notGated'));
    expect(outsideRow.querySelector('rect')?.getAttribute('class')).toContain('outside');
  });

  it('002 FR-002 links each charted cell to its detail', () => {
    const { region } = renderSummary();
    const link = within(changeRow(region, 'script-ja (ja, raw)')).getByRole('link');
    expect(link.getAttribute('href')).toBe('#/cell/script-ja/ja/raw');
  });

  it('002 FR-002 folds three or more held gated cells into one row that a button opens', async () => {
    const user = userEvent.setup();
    const comparison = loadComparison('block');
    const held = (cell: Cell, lang: string): Cell => ({
      ...cell,
      lang,
      gated: true,
      verdict: 'non-inferior',
    });
    const base = comparison.cells.find((cell) => cell.verdict === 'non-inferior');
    if (base === undefined) {
      throw new Error('the block fixture has a held cell');
    }
    comparison.cells.push(held(base, 'de'), held(base, 'fr'), held(base, 'it'));
    const { region } = renderSummary(comparison);
    const toggle = within(region).getByRole('button', {
      name: en.text('summary.changes.showHeld', { count: 3 }),
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(changeChart(region).at(-1)?.cells).toEqual([]);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(changeChart(region).at(-1)?.cells).toHaveLength(3);
  });

  it('002 FR-002 quotes failing answers of the largest drop with their evidence marked and a side-by-side link', () => {
    const comparison = loadComparison('block');
    const { region } = renderSummary(comparison);
    const section = sectionOf(region, en.text('summary.examples'));
    const raw = comparison.samples.texts.find(
      (text) => text.variant === 'candidate' && text.caseId === 'greet-ja' && text.repeat === 0,
    );
    if (raw === undefined || 'error' in raw) {
      throw new Error('the block fixture has the candidate answer to greet-ja');
    }
    const quote = section.querySelector('blockquote');
    // The evidence 안 and 녕 is marked where it occurs, as one mark since the letters touch, with
    // words for assistive technology.
    expect(
      [...(quote?.querySelectorAll('mark') ?? [])].map((mark) => mark.firstChild?.textContent),
    ).toEqual(['안녕']);
    expect(quote?.querySelector('.text')?.textContent).toBe(raw.raw);
    expect(quote?.textContent).toBe(`${en.text('summary.examples.marked')}: 안녕. ${raw.raw}`);
    expect(section.textContent).toContain('Candidate · case greet-ja · repeat 0');
    // Evidence the answer shows is not listed again.
    expect(section.textContent).not.toContain(en.text('grid.sample.evidence'));
    expect(
      within(section)
        .getByRole('link', { name: en.text('side.link') })
        .getAttribute('href'),
    ).toBe('#/side/script-ja/greet-ja/0');
  });

  it('002 FR-002 leaves out the quoted answers when no regressed cell has a failing example', () => {
    const comparison = loadComparison('block');
    const { region } = renderSummary({
      ...comparison,
      samples: { ...comparison.samples, failing: [] },
    });
    expect(
      within(region).queryByRole('heading', { name: en.text('summary.examples'), level: 3 }),
    ).toBeNull();
  });

  it('002 FR-002 shows operational changes as cost, latency and error rates with ratios, differences and warnings', () => {
    const { region } = renderSummary();
    expect(tradeRows(region)).toEqual([
      [
        en.text('summary.cost.per1000'),
        `$0.17 → $0.38${en.text('summary.opsWarning', { threshold: '×2.00' })}`,
        '×2.20 up',
      ],
      ['Latency p50', '1.2s → 2.1s', '×1.75 up'],
      ['Latency p95', '1.9s → 2.6s', '×1.37 up'],
      ['Time-out rate', '0.3% → 0.3%', '0.0pp'],
      ['Transient error rate', '0.0% → 3.3%', '+3.3pp up'],
      [
        'Discard rate',
        `0.3% → 3.0%${en.text('summary.opsWarning', { threshold: '+1.0pp' })}`,
        '+2.7pp up',
      ],
      ['Fallback rate', '0.3% → 0.3%', '0.0pp'],
      ['Regeneration rate', '0.7% → 0.7%', '0.0pp'],
    ]);
    const ops = sectionOf(region, en.text('summary.ops'));
    expect(ops.textContent).toContain(en.text('summary.cost.otherRatesZero'));
    // The costs sit beside the verdict, not in it.
    expect(ops.textContent).toContain(en.text('summary.cost.notInVerdict'));
  });

  it('002 FR-002 draws each operational change that moved as baseline and candidate on one scale, and says when one did not', () => {
    const { region } = renderSummary();
    const section = sectionOf(region, en.text('summary.ops'));
    const charts = within(section).getAllByRole('img');
    expect(charts[0]?.querySelector('title')?.textContent).toBe(
      `${en.text('summary.cost.per1000')}: $0.17 → $0.38`,
    );
    // Cost, p50, p95, transient and discard moved; time-out, fallback and regeneration did not.
    expect(charts).toHaveLength(5);
    expect(within(section).getAllByText(en.text('summary.cost.same'))).toHaveLength(3);
  });

  it('002 FR-002 shows the judged scope on one line', () => {
    const { region } = renderSummary();
    // Judged and review rules together are every rule, so nothing reads as left out.
    expect(definition(region, en.text('summary.rules')).textContent).toBe('3 judged + 1 review');
    expect(definition(region, en.text('summary.cases')).textContent).toBe('60');
    expect(definition(region, en.text('summary.languages')).textContent).toBe('3');
    expect(definition(region, en.text('summary.targets')).textContent).toBe('chat');
  });

  it('002 FR-002 writes the summary in the page language', () => {
    const ko = pageMessages('ko');
    const { region } = renderSummary(loadComparison('block'), 'ko');
    expect(itemTexts(definition(region, ko.text('summary.reasons')))[0]).toBe(
      'script-ja (ja, raw): 이 게이트 셀이 나빠졌습니다.',
    );
    expect(definition(region, ko.text('summary.gate')).textContent).toBe('차단');
    expect(
      within(region).getByRole('heading', { name: ko.text('summary.changes'), level: 3 }),
    ).toBeDefined();
    const row = within(region).getByRole('link', { name: 'completed (ko, trial)' }).closest('tr');
    expect(row?.textContent).toContain('기준 실패 0');
  });
});
