import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Lang } from '../../../src/config/schema.js';
import type { RuleSummary } from '../../../src/report/schema.js';
import { RuleList } from '../../../viewer/src/domains/scope/RuleList.js';
import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { loadComparison } from '../fixtures.js';

function renderRules(rules: readonly RuleSummary[], lang: Lang = 'en') {
  return render(<RuleList lang={lang} rules={rules} />);
}

/** The list item a rule heading of that ID opens. */
function ruleEntry(ruleId: string): HTMLElement {
  const entry = screen.getByRole('heading', { name: ruleId }).closest('li');
  if (entry === null) {
    throw new Error(`no entry for ${ruleId}`);
  }
  return entry;
}

function detailTexts(entry: HTMLElement): string[] {
  return within(entry)
    .getAllByRole('listitem')
    .map((item) => item.textContent);
}

describe('002 RuleList', () => {
  it('002 FR-016 shows every rule of rules[] in order with its ID, severity and title', () => {
    const { rules } = loadComparison('block');
    renderRules(rules);
    const list = screen.getByRole('region', { name: en['scope.rules.heading'] });
    expect(
      within(list)
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(['completed', 'script-ja', 'no-emoji', 'no-unprompted-self-state']);
    const entry = ruleEntry('script-ja');
    expect(within(entry).getByText('blocking')).toBeDefined();
    expect(
      within(entry).getByText('Japanese answers use only kana, kanji and Latin letters'),
    ).toBeDefined();
    expect(within(ruleEntry('no-emoji')).getByText('major')).toBeDefined();
  });

  it('002 FR-016 shows each anchor with its language and quote and each origin with commit, date and layer', () => {
    renderRules(loadComparison('block').rules);
    expect(detailTexts(ruleEntry('script-ja'))).toEqual([
      'Anchor (ja): 日本語だけで話す',
      'Origin: commit 1a2b3c4 · date 2026-01-15 · layer code',
    ]);
    expect(detailTexts(ruleEntry('no-emoji'))).toEqual([
      'Anchor (ko): 이모지를 붙이지 않는다',
      en['scope.rules.noOrigin'],
    ]);
  });

  it('002 FR-016 shows the target and cases of an anchor and an origin with some fields only', () => {
    const { rules } = loadComparison('block');
    const scriptJa = rules.find((rule) => rule.id === 'script-ja');
    if (scriptJa === undefined) {
      throw new Error('no script-ja rule in the fixture');
    }
    scriptJa.anchors = [
      {
        lang: 'ja',
        quote: '日本語だけで話す',
        target: 'chat',
        cases: ['greet-ja', 'smalltalk-ja'],
      },
    ];
    scriptJa.origin = [{ layer: 'prompt' }, { commit: '9f8e7d6', date: '2026-03-02' }];
    renderRules(rules);
    expect(detailTexts(ruleEntry('script-ja'))).toEqual([
      'Anchor (ja): 日本語だけで話す · target chat · cases greet-ja, smalltalk-ja',
      'Origin: layer prompt',
      'Origin: commit 9f8e7d6 · date 2026-03-02',
    ]);
    // The target comes from the rule files, so it is shown as code text like the quote.
    const target = within(ruleEntry('script-ja')).getByText('chat', { exact: true });
    expect(target.classList.contains('text')).toBe(true);
  });

  it('002 FR-016 says so for a rule without anchor or origin', () => {
    renderRules(loadComparison('block').rules);
    expect(detailTexts(ruleEntry('completed'))).toEqual([
      en['scope.rules.noAnchor'],
      en['scope.rules.noOrigin'],
    ]);
  });

  it('002 FR-016 says so when the comparison has no rules', () => {
    renderRules([]);
    const list = screen.getByRole('region', { name: en['scope.rules.heading'] });
    expect(within(list).getByText(en['scope.rules.none'])).toBeDefined();
  });

  it('002 FR-016 labels anchors and origins in the page language', () => {
    renderRules(loadComparison('block').rules, 'ko');
    expect(screen.getByRole('region', { name: ko['scope.rules.heading'] })).toBeDefined();
    expect(detailTexts(ruleEntry('completed'))).toEqual([
      ko['scope.rules.noAnchor'],
      ko['scope.rules.noOrigin'],
    ]);
  });

  it('002 FR-009 renders rule titles, quotes and origins from the rule files as text', () => {
    const { rules } = loadComparison('block');
    const [first] = rules;
    if (first === undefined) {
      throw new Error('no rule in the fixture');
    }
    first.title = '<b>bold</b> $&';
    first.anchors = [{ lang: 'en', quote: '<img src=x onerror=alert(1)>' }];
    first.origin = [{ commit: '</script>', date: '<!--' }];
    const { container } = renderRules(rules);
    expect(container.querySelector('b, img, script')).toBeNull();
    const entry = ruleEntry(first.id);
    expect(within(entry).getByText('<b>bold</b> $&')).toBeDefined();
    expect(detailTexts(entry)).toEqual([
      'Anchor (en): <img src=x onerror=alert(1)>',
      'Origin: commit </script> · date <!--',
    ]);
  });
});
