import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DecisionSummary } from '../../../viewer/src/domains/summary/DecisionSummary.js';
import { pageMessages } from '../../../viewer/src/i18n/useMessages.js';
import { loadComparison } from '../fixtures.js';

const en = pageMessages('en');

function renderSummary() {
  render(<DecisionSummary comparison={loadComparison('block')} lang="en" />);
  return screen.getByRole('region', { name: en.text('summary.heading') });
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

/** The list items of the summary section headed `name`. */
function sectionItems(region: HTMLElement, name: string): string[] {
  const section = within(region).getByRole('heading', { name, level: 3 }).closest('section');
  if (section === null) {
    throw new Error(`no section holds ${name}`);
  }
  return itemTexts(section);
}

function precedes(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const DROP_UNDECIDED = 'drop confirmed, margin not decided';

describe('002 DecisionSummary', () => {
  it('002 FR-016 shows the gate outcome with the gated cell count and the prior comparisons', () => {
    const region = renderSummary();
    expect(definition(region, en.text('summary.gate')).textContent).toBe('BLOCK');
    expect(definition(region, en.text('summary.gatedCells')).textContent).toBe('4');
    expect(definition(region, en.text('summary.priorComparisons')).textContent).toBe('1');
  });

  it('002 FR-002 states each gate reason in the order of gate.reasons', () => {
    const region = renderSummary();
    expect(itemTexts(definition(region, en.text('summary.reasons')))).toEqual([
      'script-ja (ja, raw): This gated cell regressed.',
      'completed (ja, trial): This gated cell is undecided.',
      'completed (ko, trial): This gated cell is undecided.',
      'completed (en, trial): This gated cell is undecided.',
      'completed (ja, trial): Abandoned trials inside the systematic failures: current (timeout 0, restart 0), next (timeout 1, restart 0) (tool time limit current 120000, next 120000 ms).',
    ]);
  });

  it('002 FR-002 marks the cells of gate.blocking as blocking', () => {
    const region = renderSummary();
    expect(itemTexts(definition(region, en.text('summary.blocking')))).toEqual([
      'script-ja (ja, raw)',
    ]);
  });

  it('002 FR-002 puts the gate above the sections, and the sections in the order of 001 FR-028', () => {
    const region = renderSummary();
    const headings = within(region).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      en.text('summary.worse'),
      en.text('summary.improved'),
      en.text('summary.unknown'),
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

  it('002 FR-002 lists worse cells with verdict, rates, failure-rate ratio and note', () => {
    const region = renderSummary();
    expect(sectionItems(region, en.text('summary.worse'))).toEqual([
      'script-ja (ja, raw): Regressed · 99.3% → 70.0% · ×45',
      `completed (ja, trial): Inconclusive · 99.3% → 93.3% · ×10 · ${DROP_UNDECIDED}`,
      `completed (ko, trial): Inconclusive · 100.0% → 90.0% · baseline 0 · ${DROP_UNDECIDED}`,
    ]);
  });

  it('002 FR-002 says when no cell got better', () => {
    const region = renderSummary();
    const section = within(region)
      .getByRole('heading', { name: en.text('summary.improved'), level: 3 })
      .closest('section');
    expect(section?.textContent).toContain(en.text('summary.none'));
    expect(sectionItems(region, en.text('summary.improved'))).toEqual([]);
  });

  it('002 FR-002 lists undecided cells with the text of needed', () => {
    const region = renderSummary();
    expect(sectionItems(region, en.text('summary.unknown'))).toEqual([
      `completed (ja, trial): Inconclusive · 99.3% → 93.3% · ×10 · ${DROP_UNDECIDED} · a new run with 15 repeats gives this cell 450 trials per variant (now 150) and the whole run 900 trials per variant; about 80% chance of a verdict (estimate)`,
      `completed (ko, trial): Inconclusive · 100.0% → 90.0% · baseline 0 · ${DROP_UNDECIDED} · exactly on the margin, repeats are unlikely to settle it`,
      'completed (en, trial): Too few samples · 100.0% → 90.0% · baseline 0 · repeats cannot settle it; about 3 cases are needed',
    ]);
  });

  it('002 FR-002 shows a cell with a confirmed drop that is also undecided under worse and undecided', () => {
    const region = renderSummary();
    const label = 'completed (ja, trial):';
    expect(
      sectionItems(region, en.text('summary.worse')).some((item) => item.startsWith(label)),
    ).toBe(true);
    expect(
      sectionItems(region, en.text('summary.unknown')).some((item) => item.startsWith(label)),
    ).toBe(true);
  });

  it('002 FR-002 shows operational changes with cost per trial, latency p95, ratios and warnings', () => {
    const region = renderSummary();
    expect(sectionItems(region, en.text('summary.ops'))).toEqual([
      'Discard rate: 0.3% → 3.0% · warning discard-rate-increase',
      'Cost per trial: $0.00017 → $0.00038 · ×2.20 · warning cost-ratio',
      'Latency p95: 1.9s → 2.6s · ×1.37',
    ]);
  });

  it('002 FR-002 shows the judged scope', () => {
    const region = renderSummary();
    expect(definition(region, en.text('summary.targets')).textContent).toBe('chat');
    expect(definition(region, en.text('summary.judgedRules')).textContent).toBe('3 of 4');
    expect(definition(region, en.text('summary.reviewRules')).textContent).toBe('1');
  });

  it('002 FR-002 writes the summary in the page language', () => {
    const ko = pageMessages('ko');
    render(<DecisionSummary comparison={loadComparison('block')} lang="ko" />);
    const region = screen.getByRole('region', { name: ko.text('summary.heading') });
    expect(itemTexts(definition(region, ko.text('summary.reasons')))[0]).toBe(
      'script-ja (ja, raw): 이 게이트 셀이 퇴행했습니다.',
    );
    expect(sectionItems(region, ko.text('summary.worse'))[2]).toBe(
      'completed (ko, trial): 판정 불가 · 100.0% → 90.0% · 기준 실패 0 · 하락 확인, 마진 판정 보류',
    );
    expect(definition(region, ko.text('summary.gate')).textContent).toBe('차단');
  });
});
