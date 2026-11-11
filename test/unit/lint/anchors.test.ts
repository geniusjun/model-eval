import { describe, expect, it } from 'vitest';

import {
  anchorMissing,
  normalizeWhitespace,
  type VariantRender,
} from '../../../src/lint/anchors.js';
import type { LintSubject } from '../../../src/lint/subject.js';
import { CHAT, useWorkspace } from './subject.js';

const workspace = useWorkspace();

const DIARY = { name: 'diary', languages: ['ko'], inputSchema: { type: 'object' } };

const CASES = `cases:
  - id: greet-ko-1
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
  - id: greet-ko-2
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
  - id: diary-ko
    target: diary
    lang: ko
    provenance: synthetic
    input: { user: hi }
`;

const ALL_CASES = ['greet-ko-1', 'greet-ko-2', 'diary-ko'];

/** A rule whose `anchors` and `targets` lines are given as YAML flow text. */
function rules(anchors: string, targets = '[]'): string {
  return `rules:
  - id: banmal-ko
    title: Casual speech
    severity: major
    scope: global
    targets: ${targets}
    check: { type: emoji }
    anchors: ${anchors}
`;
}

/** Every case rendered with the same prompt text, normalised as renders are. */
function render(variant: string, prompt: string): VariantRender {
  return {
    variant,
    prompts: new Map(ALL_CASES.map((id) => [id, normalizeWhitespace(prompt)])),
    failures: new Map(),
  };
}

async function subjectWith(rulesText: string): Promise<LintSubject> {
  return workspace.subject({ 'rules/rules.yaml': rulesText, 'cases/cases.yaml': CASES }, [
    CHAT,
    DIARY,
  ]);
}

function missedCases(subject: LintSubject, renders: readonly VariantRender[]) {
  return anchorMissing(subject, renders).map(({ caseIds, variants }) => ({ caseIds, variants }));
}

describe('anchor-missing', () => {
  it('001 FR-004 anchor.cases limits the cases that must contain the quote', async () => {
    const subject = await subjectWith(
      rules('[{ lang: ko, quote: 반말로 답한다, cases: [greet-ko-2] }]'),
    );
    expect(missedCases(subject, [render('current', '이모지를 붙이지 않는다.')])).toEqual([
      { caseIds: ['greet-ko-2'], variants: ['current'] },
    ]);
  });

  it('001 FR-004 anchor.target picks the target, else the rule targets apply', async () => {
    const byAnchor = await subjectWith(
      rules('[{ lang: ko, quote: 반말로 답한다, target: diary }]'),
    );
    expect(missedCases(byAnchor, [render('current', '')])).toEqual([
      { caseIds: ['diary-ko'], variants: ['current'] },
    ]);
    const byRule = await subjectWith(rules('[{ lang: ko, quote: 반말로 답한다 }]', '[chat]'));
    expect(missedCases(byRule, [render('current', '')])).toEqual([
      { caseIds: ['greet-ko-1', 'greet-ko-2'], variants: ['current'] },
    ]);
  });

  it('001 FR-004 the quote is whitespace normalised like the prompt', async () => {
    const subject = await subjectWith(rules('[{ lang: ko, quote: "반말로\\n   짧게  답한다" }]'));
    expect(anchorMissing(subject, [render('current', '규칙: 반말로 짧게 답한다.')])).toEqual([]);
  });

  it('001 FR-004 anchors with the same language and quote give one finding at the first anchor', async () => {
    const subject = await subjectWith(
      rules(`
      - { lang: ko, quote: 반말로 답한다, cases: [greet-ko-1] }
      - { lang: ko, quote: " 반말로  답한다", cases: [diary-ko] }`),
    );
    const next: VariantRender = {
      variant: 'next',
      prompts: new Map([
        ['greet-ko-1', '반말로 답한다'],
        ['greet-ko-2', '반말로 답한다'],
        ['diary-ko', ''],
      ]),
      failures: new Map(),
    };
    const findings = anchorMissing(subject, [render('current', ''), next]);
    expect(findings).toEqual([
      {
        code: 'anchor-missing',
        ruleId: 'banmal-ko',
        lang: 'ko',
        params: { quote: '반말로 답한다' },
        variants: ['current', 'next'],
        caseIds: ['greet-ko-1', 'diary-ko'],
        file: 'rules/rules.yaml',
        line: 9,
        column: 9,
      },
    ]);
  });
});
