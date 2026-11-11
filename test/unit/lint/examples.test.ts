import { describe, expect, it } from 'vitest';

import { exampleMismatches } from '../../../src/lint/examples.js';
import { useWorkspace } from './subject.js';

const workspace = useWorkspace();

const CASES = `cases:
  - id: greet-ko
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
`;

describe('example-mismatch', () => {
  it('001 FR-005 a pass example that fails and a fail example that passes are both reported, at the example', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: banmal-ko
    title: Casual speech
    severity: major
    scope: global
    check: { type: pattern, regex: "(요|습니다)[.?!]*$", flags: m, mode: forbid }
    examples:
      pass: ["오늘 어땠어?", "좋습니다."]
      fail: ["오늘 어땠어요?", "좋아."]
  - id: old-rule
    title: Retired rules are not run
    severity: major
    status: retired
    scope: global
    check: { type: emoji }
    examples:
      pass: ["🙂"]
      fail: []
`,
      'cases/cases.yaml': CASES,
    });
    const at = { ruleId: 'banmal-ko', file: 'rules/rules.yaml' };
    expect(exampleMismatches(subject)).toEqual([
      {
        code: 'example-mismatch',
        params: { example: '좋습니다.', expected: 'pass' },
        ...at,
        line: 8,
        column: 25,
      },
      {
        code: 'example-mismatch',
        params: { example: '좋아.', expected: 'fail' },
        ...at,
        line: 9,
        column: 26,
      },
    ]);
  });

  it('001 FR-005 input and params of examples feed the …From references', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: mood-not-revealed
    title: Does not name the mood
    severity: major
    check: { type: phrases, mode: forbid, anyFrom: params.words }
    examples:
      params: { words: [짜증] }
      pass: ["오늘 좀 그랬구나."]
      fail: ["오늘 짜증 골랐더라."]
  - id: script-ko
    title: Korean answers use only Hangul
    severity: blocking
    scope: global
    check: { type: script, allow: [Hangul, Common], ignoreFrom: input.nickname }
    examples:
      input: { nickname: Sky }
      pass: ["Sky야 안녕"]
      fail: ["Moon야 안녕"]
`,
      'cases/cases.yaml': CASES,
    });
    expect(exampleMismatches(subject)).toEqual([]);
  });

  it('001 FR-005 an example whose check cannot run, such as a missing anyFrom value, matches neither', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: mood-not-revealed
    title: Does not name the mood
    severity: major
    check: { type: phrases, mode: forbid, anyFrom: params.words }
    examples:
      pass: ["오늘 좀 그랬구나."]
      fail: ["오늘 짜증 골랐더라."]
`,
      'cases/cases.yaml': CASES,
    });
    expect(
      exampleMismatches(subject).map((finding) =>
        finding.code === 'example-mismatch' ? finding.params : undefined,
      ),
    ).toEqual([
      { example: '오늘 좀 그랬구나.', expected: 'pass' },
      { example: '오늘 짜증 골랐더라.', expected: 'fail' },
    ]);
  });
});
