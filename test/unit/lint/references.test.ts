import { describe, expect, it } from 'vitest';

import { lintFindingSchema } from '../../../src/config/diagnostics.js';
import { runCheck } from '../../../src/checks/registry.js';
import type { CaseValues } from '../../../src/config/paths.js';
import { unanchored } from '../../../src/lint/anchors.js';
import {
  completedNotGated,
  excludedFromGate,
  samplePlanFindings,
} from '../../../src/lint/gate-config.js';
import { inputSchemaFindings } from '../../../src/lint/input-schema.js';
import {
  duplicateIds,
  languageGaps,
  missingLangs,
  ruleFilterMismatches,
  rulesWithoutCases,
  unknownRules,
  unknownTargets,
  unresolvedRefs,
} from '../../../src/lint/references.js';
import { CHAT, CONFIG, useWorkspace } from './subject.js';

const workspace = useWorkspace();

const NO_EMOJI = `rules:
  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    check: { type: emoji }
`;

const GREET_KO = `cases:
  - id: greet-ko
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
`;

describe('reference lint codes', () => {
  it('001 FR-001 duplicate-id for rules, cases and variants at the later occurrence', async () => {
    const subject = await workspace.subject({
      'model-eval.config.yaml': `version: 1
adapter:
  command: [node, adapter.mjs]
variants:
  - id: current
    model: model-a
  - id: current
    model: model-b
pricing: {}
`,
      'rules/rules.yaml': `${NO_EMOJI}  - id: no-emoji
    title: No emoji again
    severity: minor
    scope: global
    check: { type: emoji }
`,
      'cases/a.yaml': GREET_KO,
      'cases/b.yaml': GREET_KO,
    });
    const findings = duplicateIds(subject);
    expect(findings).toEqual([
      {
        code: 'duplicate-id',
        params: { kind: 'variant', id: 'current' },
        file: 'model-eval.config.yaml',
        line: 7,
        column: 9,
      },
      {
        code: 'duplicate-id',
        params: { kind: 'rule', id: 'no-emoji' },
        file: 'rules/rules.yaml',
        line: 7,
        column: 9,
      },
      {
        code: 'duplicate-id',
        params: { kind: 'case', id: 'greet-ko' },
        file: 'cases/b.yaml',
        line: 2,
        column: 9,
      },
    ]);
    for (const finding of findings) {
      expect(lintFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  it('001 FR-002 unknown-rule names the rule and the case, with the file and position of the entry', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': `${GREET_KO}    rules: [no-emoji, no-such]
`,
    });
    expect(unknownRules(subject)).toEqual([
      {
        code: 'unknown-rule',
        ruleId: 'no-such',
        caseIds: ['greet-ko'],
        file: 'cases/cases.yaml',
        line: 7,
        column: 23,
      },
    ]);
  });

  it('001 FR-002 missing-lang for a case of a multi-language target, decided by the adapter targets', async () => {
    const files = {
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': `cases:
  - id: greet
    target: chat
    provenance: synthetic
    input: { user: hi }
  - id: diary-entry
    target: diary
    provenance: synthetic
    input: { user: hi }
`,
    };
    const diary = { name: 'diary', languages: ['ko'], inputSchema: { type: 'object' } };
    expect(missingLangs(await workspace.subject(files, [CHAT, diary]))).toEqual([
      {
        code: 'missing-lang',
        params: { target: 'chat' },
        caseIds: ['greet'],
        file: 'cases/cases.yaml',
        line: 2,
        column: 5,
      },
    ]);
    expect(missingLangs(await workspace.subject(files))).toEqual([]);
  });

  it('001 FR-002 unresolved-ref for a missing anyFrom value or one with only empty strings', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: mood-not-revealed
    title: Does not name the mood
    severity: major
    check: { type: phrases, mode: forbid, anyFrom: params.words }
  - id: uses-nickname
    title: Uses the nickname
    severity: minor
    scope: global
    check: { type: all, checks: [{ type: phrases, mode: require, anyFrom: input.nickname }] }
  - id: old-words
    title: Retired
    severity: minor
    status: retired
    scope: global
    check: { type: phrases, mode: forbid, anyFrom: input.words }
`,
      'cases/cases.yaml': `cases:
  - id: words-given
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi, nickname: 하늘 }
    rules: [{ id: mood-not-revealed, params: { words: [짜증] } }]
  - id: words-missing
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi, nickname: "" }
    rules: [mood-not-revealed]
`,
    });
    const at = { caseIds: ['words-missing'], file: 'cases/cases.yaml', line: 8, column: 5 };
    expect(unresolvedRefs(subject)).toEqual([
      {
        code: 'unresolved-ref',
        ruleId: 'mood-not-revealed',
        params: { path: 'params.words' },
        ...at,
      },
      {
        code: 'unresolved-ref',
        ruleId: 'uses-nickname',
        params: { path: 'input.nickname' },
        ...at,
      },
    ]);
  });

  it('001 FR-002 unresolved-ref for any …From value that is present but neither text nor a list of text, as grading sees it', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: script-ko
    title: Korean script
    severity: blocking
    scope: global
    check: { type: script, allow: [Hangul, Common], ignoreFrom: input.nickname }
  - id: no-copy
    title: Does not copy the profile
    severity: minor
    scope: global
    check: { type: not, check: { type: overlap, withFrom: input.profile, minChars: 5 } }
  - id: no-words
    title: Avoids the words
    severity: minor
    scope: global
    check: { type: phrases, mode: forbid, anyFrom: input.words }
`,
      'cases/cases.yaml': `cases:
  - id: odd-values
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi, nickname: 7, profile: { bio: text }, words: [fine, 3] }
  - id: text-values
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi, profile: about me, words: [fine] }
`,
    });
    const at = { caseIds: ['odd-values'], file: 'cases/cases.yaml', line: 2, column: 5 };
    expect(unresolvedRefs(subject)).toEqual([
      { code: 'unresolved-ref', ruleId: 'script-ko', params: { path: 'input.nickname' }, ...at },
      { code: 'unresolved-ref', ruleId: 'no-copy', params: { path: 'input.profile' }, ...at },
      { code: 'unresolved-ref', ruleId: 'no-words', params: { path: 'input.words' }, ...at },
    ]);
    // Each reported value is one grading cannot use either.
    for (const { rule } of subject.rules) {
      const [odd] = subject.cases;
      const values: CaseValues = { input: odd?.definition.input ?? {} };
      if (rule.check.type !== 'completed' && rule.check.type !== 'review') {
        expect(runCheck(rule.check, 'answer', values).outcome, rule.id).toBe('error');
      }
    }
  });

  it('001 FR-002 input-schema checks each case input against its target, only with adapter targets', async () => {
    const files = {
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': `cases:
  - id: greet-ko
    target: chat
    lang: ko
    provenance: synthetic
    input: { name: hi }
  - id: greet-ja
    target: chat
    lang: ja
    provenance: synthetic
    input: { user: hi }
`,
    };
    expect(inputSchemaFindings(await workspace.subject(files, [CHAT]))).toEqual([
      {
        code: 'input-schema',
        params: { target: 'chat', detail: "/ must have required property 'user'" },
        caseIds: ['greet-ko'],
        file: 'cases/cases.yaml',
        line: 6,
        column: 12,
      },
    ]);
    expect(inputSchemaFindings(await workspace.subject(files))).toEqual([]);
  });

  it('001 FR-002 unknown-target for a case whose target the adapter does not declare, only with adapter targets', async () => {
    const files = {
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': `${GREET_KO}  - id: diary-ko
    target: diary
    lang: ko
    provenance: synthetic
    input: { user: hi }
`,
    };
    const findings = unknownTargets(await workspace.subject(files, [CHAT]));
    expect(findings).toEqual([
      {
        code: 'unknown-target',
        params: { target: 'diary' },
        caseIds: ['diary-ko'],
        file: 'cases/cases.yaml',
        line: 8,
        column: 13,
      },
    ]);
    expect(lintFindingSchema.parse(findings[0])).toEqual(findings[0]);
    expect(unknownTargets(await workspace.subject(files))).toEqual([]);
  });

  it('001 FR-002 without adapter targets, a case without lang has an unknown language that language checks leave out', async () => {
    const files = {
      'model-eval.config.yaml': `${CONFIG}gate:
  severities: [blocking]
`,
      'rules/rules.yaml': `rules:
  - id: formal-ja
    title: Japanese answers are polite
    severity: blocking
    languages: [ja]
    check: { type: phrases, mode: forbid, anyFrom: input.words }
  - id: no-banned
    title: Avoids banned words
    severity: minor
    scope: global
    check: { type: phrases, mode: forbid, anyFrom: input.banned }
`,
      'cases/cases.yaml': `cases:
  - id: greet
    target: chat
    provenance: synthetic
    input: { user: hi }
    rules: [formal-ja]
`,
    };
    const at = { caseIds: ['greet'], file: 'cases/cases.yaml', line: 2, column: 5 };
    const unknown = await workspace.subject(files);
    expect(ruleFilterMismatches(unknown)).toEqual([]);
    expect(languageGaps(unknown)).toEqual([]);
    expect(unanchored(unknown)).toEqual([]);
    expect(samplePlanFindings(unknown)).toEqual([]);
    expect(unresolvedRefs(unknown)).toEqual([
      { code: 'unresolved-ref', ruleId: 'no-banned', params: { path: 'input.banned' }, ...at },
    ]);

    const jaOnly = { ...CHAT, languages: ['ja'] };
    const known = await workspace.subject(files, [jaOnly]);
    expect(ruleFilterMismatches(known)).toEqual([]);
    expect(languageGaps(known)).toEqual([]);
    expect(unanchored(known).map(({ ruleId, lang }) => ({ ruleId, lang }))).toEqual([
      { ruleId: 'formal-ja', lang: 'ja' },
      { ruleId: 'no-banned', lang: 'ja' },
    ]);
    expect(
      samplePlanFindings(known).map(({ code, ruleId, lang }) => ({ code, ruleId, lang })),
    ).toEqual([
      { code: 'few-cases', ruleId: 'formal-ja', lang: 'ja' },
      { code: 'margin-unreachable', ruleId: 'formal-ja', lang: 'ja' },
    ]);
    expect(unresolvedRefs(known).map(({ ruleId }) => ruleId)).toEqual(['formal-ja', 'no-banned']);
  });

  it('001 FR-002 an input schema that does not compile is adapter-failed at adapter.command', async () => {
    const broken = { ...CHAT, inputSchema: { type: 'nonsense' } };
    const findings = inputSchemaFindings(
      await workspace.subject({ 'rules/rules.yaml': NO_EMOJI, 'cases/cases.yaml': GREET_KO }, [
        broken,
      ]),
    );
    expect(findings).toMatchObject([
      { code: 'adapter-failed', file: 'model-eval.config.yaml', line: 3, column: 12 },
    ]);
    expect(findings[0]?.code === 'adapter-failed' ? findings[0].params.detail : '').toContain(
      'the inputSchema of target chat does not compile',
    );
  });

  it('001 FR-002 rule-filter-mismatch for a listed rule whose target or language does not match', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: formal-ja
    title: Japanese answers are polite
    severity: minor
    languages: [ja]
    check: { type: emoji }
  - id: diary-only
    title: Diary rule
    severity: minor
    targets: [diary]
    check: { type: emoji }
`,
      'cases/cases.yaml': `${GREET_KO}    rules: [formal-ja, diary-only]
`,
    });
    const at = { caseIds: ['greet-ko'], file: 'cases/cases.yaml', line: 7 };
    expect(ruleFilterMismatches(subject)).toEqual([
      { code: 'rule-filter-mismatch', ruleId: 'formal-ja', ...at, column: 13 },
      { code: 'rule-filter-mismatch', ruleId: 'diary-only', ...at, column: 24 },
    ]);
  });

  it('001 FR-004 rule-without-case for an active listed rule that no case names', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `${NO_EMOJI}  - id: mood-not-revealed
    title: Does not name the mood
    severity: major
    check: { type: phrases, mode: forbid, any: [짜증] }
  - id: old-rule
    title: Retired
    severity: major
    status: retired
    check: { type: emoji }
`,
      'cases/cases.yaml': GREET_KO,
    });
    expect(rulesWithoutCases(subject)).toEqual([
      {
        code: 'rule-without-case',
        ruleId: 'mood-not-revealed',
        file: 'rules/rules.yaml',
        line: 7,
        column: 5,
      },
    ]);
  });

  it('001 FR-004 language-gap for a rule language without cases, once per rule and language', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': `rules:
  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    languages: [ko, ja]
    check: { type: emoji }
  - id: mood-not-revealed
    title: Listed rule that no case names; rule-without-case reports it
    severity: major
    languages: [ko]
    check: { type: phrases, mode: forbid, any: [짜증] }
`,
      'cases/cases.yaml': GREET_KO,
    });
    expect(languageGaps(subject)).toEqual([
      {
        code: 'language-gap',
        ruleId: 'no-emoji',
        lang: 'ja',
        file: 'rules/rules.yaml',
        line: 2,
        column: 5,
      },
    ]);
  });

  it('001 FR-006 completed-not-gated when a gate exists without a gated completed rule', async () => {
    const gated = `${CONFIG}gate:
  severities: [blocking]
`;
    const completed = (severity: string): string => `rules:
  - id: answered
    title: Complete answer
    severity: ${severity}
    scope: global
    check: { type: completed }
`;
    const noRule = await workspace.subject({
      'model-eval.config.yaml': gated,
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': GREET_KO,
    });
    expect(completedNotGated(noRule)).toEqual([
      {
        code: 'completed-not-gated',
        params: { cause: 'no-rule' },
        file: 'model-eval.config.yaml',
        line: 10,
        column: 15,
      },
    ]);
    const notGated = await workspace.subject({
      'model-eval.config.yaml': gated,
      'rules/rules.yaml': completed('major'),
      'cases/cases.yaml': GREET_KO,
    });
    expect(completedNotGated(notGated)).toEqual([
      {
        code: 'completed-not-gated',
        params: { cause: 'not-gated' },
        ruleId: 'answered',
        file: 'rules/rules.yaml',
        line: 2,
        column: 5,
      },
    ]);
    const held = await workspace.subject({
      'model-eval.config.yaml': gated,
      'rules/rules.yaml': completed('blocking'),
      'cases/cases.yaml': GREET_KO,
    });
    expect(completedNotGated(held)).toEqual([]);
    const noGate = await workspace.subject({
      'rules/rules.yaml': NO_EMOJI,
      'cases/cases.yaml': GREET_KO,
    });
    expect(completedNotGated(noGate)).toEqual([]);
  });

  it('001 FR-006 excluded-from-gate for a review rule of a gated severity', async () => {
    const subject = await workspace.subject({
      'model-eval.config.yaml': `${CONFIG}gate:
  severities: [blocking]
`,
      'rules/rules.yaml': `rules:
  - id: answered
    title: Complete answer
    severity: blocking
    scope: global
    check: { type: completed }
  - id: no-self-state
    title: Judged by people
    severity: blocking
    scope: global
    check: { type: review }
  - id: tone
    title: Not gated
    severity: major
    scope: global
    check: { type: review }
`,
      'cases/cases.yaml': GREET_KO,
    });
    expect(excludedFromGate(subject)).toEqual([
      {
        code: 'excluded-from-gate',
        ruleId: 'no-self-state',
        params: { cause: 'review' },
        file: 'rules/rules.yaml',
        line: 7,
        column: 5,
      },
    ]);
  });
});
