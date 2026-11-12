import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Lang } from '../../../src/config/schema.js';
import type { Comparison } from '../../../src/report/schema.js';
import { ReproductionPanel } from '../../../viewer/src/domains/scope/ReproductionPanel.js';
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
      variantIds={{
        baseline: comparison.baseline.variant.id,
        candidate: comparison.candidate.variant.id,
      }}
    />,
  );
}

function renderReproduction(comparison: Comparison, lang: Lang = 'en') {
  return render(
    <ReproductionPanel
      lang={lang}
      comparisonId={comparison.comparisonId}
      createdAt={comparison.createdAt}
      baseline={comparison.baseline}
      candidate={comparison.candidate}
      stats={comparison.stats}
      config={comparison.config}
    />,
  );
}

/** The `<section>` a heading of that name opens. */
function sectionOf(name: string): HTMLElement {
  const section = screen.getByRole('heading', { name }).closest('section');
  if (section === null) {
    throw new Error(`no section under the heading ${name}`);
  }
  return section;
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

function termTexts(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole('term')
    .map((element) => element.textContent);
}

describe('002 ScopePanel', () => {
  it('002 FR-007 shows the judged targets and the judged, not judged and review rules', () => {
    const comparison = loadComparison('block');
    renderScope(comparison);
    const panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.targets'])).toBe('chat');
    expect(valueOf(panel, 'Rules judged (3 of 4)')).toBe('completed, script-ja, no-emoji');
    expect(valueOf(panel, en['scope.notJudged'])).toBe('none');
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
    expect(
      valueOf(screen.getByRole('region', { name: en['scope.heading'] }), en['scope.excluded']),
    ).toBe('none');
  });

  it('002 FR-007 shows common cases, cases in one run only and cases with a changed hash', () => {
    const comparison = loadComparison('block');
    const { unmount } = renderScope(comparison);
    let panel = screen.getByRole('region', { name: en['scope.heading'] });
    expect(valueOf(panel, en['scope.commonCases'])).toBe('60');
    expect(valueOf(panel, 'Cases only in current')).toBe('none');
    expect(valueOf(panel, 'Cases only in next')).toBe('greet-en');
    expect(valueOf(panel, en['scope.changedHash'])).toBe('none');
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
    expect(valueOf(panel, 'Cases only in current')).toBe('greet-ko');
    expect(valueOf(panel, 'Cases only in next')).toBe('none');
    expect(valueOf(panel, en['scope.changedHash'])).toBe('smalltalk-ja, smalltalk-ko');
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

  it('002 FR-007 labels the scope in the page language', () => {
    renderScope(loadComparison('block'), 'ko');
    const panel = screen.getByRole('region', { name: ko['scope.heading'] });
    expect(valueOf(panel, ko['scope.targets'])).toBe('chat');
    expect(valueOf(panel, ko['scope.notJudged'])).toBe(ko['scope.none']);
    expect(valueOf(panel, 'next에만 있는 케이스')).toBe('greet-en');
  });
});

describe('002 ReproductionPanel', () => {
  it('002 FR-007 shows the comparison ID and when it was written', () => {
    renderReproduction(loadComparison('block'));
    const panel = screen.getByRole('region', { name: en['scope.reproduction.heading'] });
    expect(valueOf(panel, en['scope.reproduction.comparison'])).toBe('cmp-c3185cc21556');
    expect(valueOf(panel, en['scope.reproduction.createdAt'])).toBe('2026-11-05T10:20:00.000Z');
  });

  it('002 FR-007 shows the run, grade set, variant, versions and post-processing of each variant', () => {
    renderReproduction(loadComparison('block'));

    const baseline = sectionOf('Baseline: current');
    expect(termTexts(baseline)).not.toContain(en['scope.run.params']);
    expect(valueOf(baseline, en['scope.run.run'])).toBe('20261105-101500-current-1a2b');
    expect(valueOf(baseline, en['scope.run.gradeSet'])).toBe('gs-0a1b2c3d4e5f');
    expect(valueOf(baseline, en['scope.run.model'])).toBe('model-a');
    expect(valueOf(baseline, en['scope.run.fingerprint'])).toBe(
      'sha256:d813d10cf979dfaaeb90e05756ae795ef4dae5c7196b8be39a195baaf64e8f31',
    );
    expect(valueOf(baseline, en['scope.run.status'])).toBe('complete');
    expect(valueOf(baseline, en['scope.run.tool'])).toBe('model-eval 0.1.0');
    expect(valueOf(baseline, en['scope.run.adapter'])).toBe('pogo-chat 0.3.0');
    expect(valueOf(baseline, en['scope.run.launchHash'])).toBe(
      'sha256:6164c16405ffad14780cca15e85cf8688c355069ccb5b8dfa55b25603379a449',
    );
    expect(valueOf(baseline, en['scope.run.helper'])).toBe('python 0.1.0');
    expect(valueOf(baseline, en['scope.run.serviceVersion'])).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(valueOf(baseline, en['scope.run.serviceDirty'])).toBe('no');
    expect(valueOf(baseline, en['scope.run.treeHash'])).toBe(
      'sha256:ec545c4839b455042abf79ea8201df2aaf6c3eca68a4f4f63b45a0fd82501746',
    );
    expect(valueOf(baseline, en['scope.run.postprocess'])).toBe('yes');

    const candidate = sectionOf('Candidate: next');
    expect(valueOf(candidate, en['scope.run.run'])).toBe('20261105-101500-next-a1b2');
    expect(valueOf(candidate, en['scope.run.gradeSet'])).toBe('gs-5f4e3d2c1b0a');
    expect(valueOf(candidate, en['scope.run.model'])).toBe('model-b');
    expect(valueOf(candidate, en['scope.run.params'])).toBe('{"reasoning":"none"}');
    expect(valueOf(candidate, en['scope.run.fingerprint'])).toBe(
      'sha256:6360a111005127eda7ba6bc55b9f679527abb04dee42259c5ec90dd873055ec8',
    );
    expect(valueOf(candidate, en['scope.run.tool'])).toBe('model-eval 0.1.0');
  });

  it('002 FR-007 shows the status of an unfinished run', () => {
    renderReproduction(loadComparison('undecided-partial'));
    expect(valueOf(sectionOf('Candidate: next'), en['scope.run.status'])).toBe('partial');
  });

  it('002 FR-007 shows uncommitted service changes and leaves out versions a run did not record', () => {
    const comparison = loadComparison('block');
    comparison.candidate.service = { dirty: true };
    comparison.candidate.postprocess = false;
    delete comparison.candidate.adapter.helper;
    renderReproduction(comparison);
    const candidate = sectionOf('Candidate: next');
    expect(valueOf(candidate, en['scope.run.serviceDirty'])).toBe('yes');
    expect(valueOf(candidate, en['scope.run.postprocess'])).toBe('no');
    const terms = termTexts(candidate);
    expect(terms).not.toContain(en['scope.run.helper']);
    expect(terms).not.toContain(en['scope.run.serviceVersion']);
    expect(terms).not.toContain(en['scope.run.treeHash']);
  });

  it('002 FR-007 shows the statistics settings', () => {
    renderReproduction(loadComparison('block'));
    const statistics = sectionOf(en['scope.stats.heading']);
    expect(valueOf(statistics, en['scope.stats.confidence'])).toBe('95.0%');
    expect(valueOf(statistics, en['scope.stats.method'])).toBe(
      'newcombe-hybrid-score with case-cluster design effect',
    );
    expect(valueOf(statistics, en['scope.stats.gatedCells'])).toBe('4');
    expect(valueOf(statistics, en['scope.stats.zLower'])).toBe('1.959964');
    expect(valueOf(statistics, en['scope.stats.zUpper'])).toBe('2.497705');
    expect(valueOf(statistics, en['scope.stats.minCases'])).toBe('3');
  });

  it('002 FR-007 shows the settings used as indented JSON in a <pre>', () => {
    const comparison = loadComparison('block');
    renderReproduction(comparison);
    const settings = sectionOf(en['scope.settings']).querySelector('pre');
    expect(settings?.textContent).toBe(JSON.stringify(comparison.config, null, 2));
  });

  it('002 FR-007 shows the commands that reproduce the comparison, one per line', () => {
    renderReproduction(loadComparison('block'));
    const commands = sectionOf(en['scope.commands']).querySelector('pre');
    expect(commands?.textContent).toBe(
      [
        'model-eval compare 20261105-101500-current-1a2b 20261105-101500-next-a1b2',
        'model-eval report cmp-c3185cc21556',
      ].join('\n'),
    );
  });

  it('002 FR-007 labels the reproduction details in the page language', () => {
    renderReproduction(loadComparison('block'), 'ko');
    expect(screen.getByRole('region', { name: ko['scope.reproduction.heading'] })).toBeDefined();
    const baseline = sectionOf('기준: current');
    expect(valueOf(baseline, ko['scope.run.serviceDirty'])).toBe(ko['scope.no']);
    expect(valueOf(baseline, ko['scope.run.postprocess'])).toBe(ko['scope.yes']);
  });
});
