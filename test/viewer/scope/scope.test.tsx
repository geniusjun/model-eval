import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Lang } from '../../../src/config/schema.js';
import type { Comparison } from '../../../src/report/schema.js';
import { ScopePanel } from '../../../viewer/src/domains/scope/ScopePanel.js';
import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { loadComparison } from '../fixtures.js';

function renderScope(comparison: Comparison, lang: Lang = 'en') {
  return render(
    <ScopePanel
      lang={lang}
      scope={comparison.scope}
      rules={comparison.rules}
      excluded={comparison.gate.excluded}
      coverage={comparison.coverage}
      completion={comparison.completion}
    />,
  );
}

/** The text of the `<dd>` that follows the `<dt>` with this text. */
function valueOf(container: HTMLElement, term: string): string {
  const match = within(container)
    .getAllByRole('term')
    .find((element) => element.textContent === term);
  if (match === undefined) {
    throw new Error(`no term ${term}`);
  }
  return match.nextElementSibling?.textContent ?? '';
}

/** The lists the one sentence under the scope names as empty: `None: a, b.` gives `[a, b]`. */
function noneTerms(container: HTMLElement, sentence: string = en['scope.empty']): string[] {
  const [prefix = '', suffix = ''] = sentence.split('{lists}');
  const line = within(container)
    .queryAllByText((_, element) => element?.tagName === 'P')
    .map((element) => element.textContent)
    .find((text) => text.startsWith(prefix) && text.endsWith(suffix));
  return line === undefined ? [] : line.slice(prefix.length, -suffix.length).split(', ');
}

describe('002 ScopePanel', () => {
  it('002 FR-007 shows the judged targets and the judged, not judged and review rules', () => {
    const comparison = loadComparison('block');
    renderScope(comparison);
    const panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.targets'])).toBe('chat');
    expect(valueOf(panel, 'Judged rules (3)')).toBe('completed, script-ja, no-emoji');
    expect(noneTerms(panel)).toContain(en['scope.empty.notJudged']);
    expect(
      within(panel)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).not.toContain(en['scope.notJudged']);
    expect(valueOf(panel, en['scope.review'])).toBe('no-unprompted-self-state');
  });

  it('002 FR-007 lists rules that were not judged', () => {
    const comparison = loadComparison('block');
    comparison.scope.notJudgedRules = ['no-emoji', 'script-ja'];
    renderScope(comparison);
    const panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.notJudged'])).toBe('no-emoji, script-ja');
  });

  it('002 FR-007 shows each rule removed from the gate with its cause', () => {
    const comparison = loadComparison('block');
    renderScope(comparison);
    expect(
      valueOf(screen.getByRole('region', { name: en['scope.heading'] }), en['scope.excluded']),
    ).toBe('no-unprompted-self-state (review)');
  });

  it('002 FR-007 shows the uncalibrated-judge cause and says none when no rule was removed', () => {
    const comparison = loadComparison('block');
    comparison.gate.excluded = [
      { ruleId: 'no-unprompted-self-state', cause: 'review' },
      { ruleId: 'no-emoji', cause: 'uncalibrated-judge' },
    ];
    const { unmount } = renderScope(comparison);
    expect(
      valueOf(screen.getByRole('region', { name: en['scope.heading'] }), en['scope.excluded']),
    ).toBe('no-unprompted-self-state (review), no-emoji (uncalibrated-judge)');
    unmount();
    renderScope(loadComparison('undecided-partial'));
    expect(noneTerms(screen.getByRole('region', { name: en['scope.heading'] }))).toContain(
      en['scope.empty.excluded'],
    );
  });

  it('002 FR-007 shows common cases, cases in one run only and cases with a changed hash', () => {
    const comparison = loadComparison('block');
    const { unmount } = renderScope(comparison);
    let panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.commonCases'])).toBe('60');
    expect(noneTerms(panel)).toEqual(
      expect.arrayContaining(['cases only in the baseline', en['scope.empty.changedHash']]),
    );
    expect(valueOf(panel, 'Cases only in the candidate')).toBe('greet-en');
    unmount();

    comparison.coverage = {
      commonCases: 58,
      baselineOnly: ['greet-ko'],
      candidateOnly: [],
      changedHash: ['smalltalk-ja', 'smalltalk-ko'],
    };
    renderScope(comparison);
    panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.commonCases'])).toBe('58');
    expect(valueOf(panel, 'Cases only in the baseline')).toBe('greet-ko');
    expect(noneTerms(panel)).toContain('cases only in the candidate');
    expect(valueOf(panel, en['scope.changedHash'])).toBe('smalltalk-ja, smalltalk-ko');
  });

  it('002 FR-007 names the empty lists in one sentence, cases on either side only together', () => {
    const comparison = loadComparison('block');
    comparison.coverage = { ...comparison.coverage, baselineOnly: [], candidateOnly: [] };
    renderScope(comparison);
    const panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(noneTerms(panel)).toEqual([
      en['scope.empty.notJudged'],
      en['scope.empty.oneSide'],
      en['scope.empty.changedHash'],
    ]);
    expect(
      within(panel)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).not.toContain(en['scope.onlyInBaseline']);
  });

  it('002 FR-007 shows the baseline completion rate per language with its passes and trials', () => {
    const comparison = loadComparison('block');
    comparison.completion.push({ lang: 'fr', trials: 0, passes: 0, rate: null });
    renderScope(comparison);
    const term = within(screen.getByRole('region', { name: en['scope.heading'] }))
      .getAllByRole('term')
      .find((element) => element.textContent === en['scope.completion']);
    const definition = term?.nextElementSibling;
    if (!(definition instanceof HTMLElement)) {
      throw new Error('no completion definition');
    }
    expect(
      within(definition)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'ko 100.0% (150 of 150)',
      'ja 99.3% (149 of 150)',
      'en 100.0% (10 of 10)',
      'fr — (0 of 0)',
    ]);
  });

  it('002 FR-007 states the completion rate once when every language completed fully', () => {
    const comparison = loadComparison('block');
    comparison.completion = comparison.completion.map((entry) => ({
      ...entry,
      passes: entry.trials,
      rate: 1,
    }));
    renderScope(comparison);
    const panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.completion'])).toBe(
      en['scope.completionAll']
        .replace('{rate}', '100.0%')
        .replace('{langs}', comparison.completion.map((entry) => entry.lang).join(', ')),
    );
  });

  it('002 FR-007 labels the scope in the page language', () => {
    renderScope(loadComparison('block'), 'ko');
    const panel = screen.getByRole('region', { name: ko['scope.heading'] });
    expect(valueOf(panel, ko['scope.targets'])).toBe('chat');
    expect(noneTerms(panel, ko['scope.empty'])).toContain(ko['scope.empty.notJudged']);
    expect(valueOf(panel, '후보에만 있는 케이스')).toBe('greet-en');
  });
});
