import { describe, expect, it } from 'vitest';

import { applicableRules, gradeRun, type RunCase } from '../../../src/grade/grade.js';
import { caseSchema, ruleSchema, type Case } from '../../../src/config/schema.js';
import type { AttemptLine } from '../../../src/run/records.js';
import { errorLine, okLine, stoppedLine } from './lines.js';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const OTHER_HASH = `sha256:${'b'.repeat(64)}` as const;

const RULES = [
  { id: 'completed', check: { type: 'completed' }, scope: 'global' },
  { id: 'no-emoji', check: { type: 'emoji' }, scope: 'global' },
  {
    id: 'script-ko',
    scope: 'global',
    languages: ['ko'],
    check: { type: 'script', allow: ['Hangul', 'Common'], ignoreFrom: 'input.nickname' },
  },
  { id: 'mood-hidden', check: { type: 'phrases', mode: 'forbid', anyFrom: 'params.words' } },
  { id: 'self-state', check: { type: 'review' } },
  { id: 'old-emoji', status: 'retired', scope: 'global', check: { type: 'emoji' } },
  { id: 'other-target', scope: 'global', targets: ['summary'], check: { type: 'emoji' } },
  { id: 'chat-only', scope: 'global', targets: ['chat'], check: { type: 'emoji' } },
].map((rule) => ruleSchema.parse({ title: rule.id, severity: 'major', ...rule }));

function caseOf(fields: Record<string, unknown>): Case {
  return caseSchema.parse({ target: 'chat', provenance: 'synthetic', input: {}, ...fields });
}

const greet = caseOf({ id: 'greet-ko', lang: 'ko', input: { nickname: 'Sky' } });
const mood = caseOf({
  id: 'mood-ko',
  lang: 'ko',
  rules: [{ id: 'mood-hidden', params: { words: ['짜증'] } }, 'self-state'],
});

function runCase(definition: Case, lang = 'ko'): RunCase {
  return {
    id: definition.id,
    target: definition.target,
    lang,
    hash: HASH,
    current: { definition, hash: HASH },
  };
}

function ruleIds(definition: Case, lang: string): string[] {
  return applicableRules(RULES, definition, lang).map(({ rule }) => rule.id);
}

function gradesOf(line: AttemptLine, testCase: RunCase = runCase(greet)) {
  return gradeRun({ rules: RULES, cases: [testCase], trials: [line] }).map(
    ({ ruleId, surface, outcome, evidence }) =>
      evidence === undefined ? [ruleId, surface, outcome] : [ruleId, surface, outcome, evidence],
  );
}

describe('applicable rules', () => {
  it('001 FR-018 global rules apply to every case of a matching target and language', () => {
    expect(ruleIds(greet, 'ko')).toEqual(['completed', 'no-emoji', 'script-ko', 'chat-only']);
    expect(ruleIds(greet, 'en')).toEqual(['completed', 'no-emoji', 'chat-only']);
  });

  it('001 FR-018 listed rules apply only to cases that list them, with their params', () => {
    const applied = applicableRules(RULES, mood, 'ko');
    expect(applied.map(({ rule }) => rule.id)).toEqual([
      'completed',
      'no-emoji',
      'script-ko',
      'mood-hidden',
      'self-state',
      'chat-only',
    ]);
    expect(applied.find(({ rule }) => rule.id === 'mood-hidden')?.params).toEqual({
      words: ['짜증'],
    });
  });

  it('001 FR-018 a listed rule whose target or language does not match is not graded', () => {
    const listing = caseOf({ id: 'listing', lang: 'en', rules: ['script-ko', 'other-target'] });
    expect(ruleIds(listing, 'en')).toEqual(['completed', 'no-emoji', 'chat-only']);
  });

  it('001 FR-018 retired rules are never graded', () => {
    const listing = caseOf({ id: 'listing', lang: 'ko', rules: ['old-emoji'] });
    expect(ruleIds(listing, 'ko')).not.toContain('old-emoji');
  });

  it('001 FR-018 rules with languages never apply to cases without a language', () => {
    const plain = caseOf({ id: 'plain' });
    expect(ruleIds(plain, '*')).toEqual(['completed', 'no-emoji', 'chat-only']);
  });
});

describe('grading per surface', () => {
  it('001 FR-018 grades text rules on raw and final and completed on the trial surface', () => {
    expect(gradesOf(okLine())).toEqual([
      ['chat-only', 'final', 'pass'],
      ['chat-only', 'raw', 'pass'],
      ['completed', 'trial', 'pass'],
      ['no-emoji', 'final', 'pass'],
      ['no-emoji', 'raw', 'pass'],
      ['script-ko', 'final', 'pass'],
      ['script-ko', 'raw', 'pass'],
    ]);
  });

  it('001 FR-018 review rules are not graded', () => {
    const grades = gradeRun({ rules: RULES, cases: [runCase(mood)], trials: [moodLine(okLine())] });
    expect(grades.some(({ ruleId }) => ruleId === 'self-state')).toBe(false);
  });

  it('001 FR-018 raw rules read the first answer and final rules the shipped one, with evidence', () => {
    const picked = okLine({ raw: '안녕 😀 你', answers: 2, final: '안녕' });
    expect(gradesOf(picked)).toEqual([
      ['chat-only', 'final', 'pass'],
      ['chat-only', 'raw', 'fail', ['😀']],
      ['completed', 'trial', 'pass'],
      ['no-emoji', 'final', 'pass'],
      ['no-emoji', 'raw', 'fail', ['😀']],
      ['script-ko', 'final', 'pass'],
      // Emoji are Script=Common, so only the Han character breaks the script rule.
      ['script-ko', 'raw', 'fail', ['你']],
    ]);
  });

  it('001 FR-017 reads ignoreFrom from the case input and anyFrom from the listed params', () => {
    expect(gradesOf(okLine({ raw: 'Sky 안녕', final: 'Sky 안녕' }))).toContainEqual([
      'script-ko',
      'raw',
      'pass',
    ]);
    const grades = gradeRun({
      rules: RULES,
      cases: [runCase(mood)],
      trials: [moodLine(okLine({ raw: '짜증 났구나', final: '그랬구나' }))],
    });
    expect(grades.filter(({ ruleId }) => ruleId === 'mood-hidden')).toEqual([
      { caseId: 'mood-ko', repeat: 0, ruleId: 'mood-hidden', surface: 'final', outcome: 'pass' },
      {
        caseId: 'mood-ko',
        repeat: 0,
        ruleId: 'mood-hidden',
        surface: 'raw',
        outcome: 'fail',
        evidence: ['짜증'],
      },
    ]);
  });

  it('001 FR-018 a check that cannot run records error', () => {
    const unlisted = caseOf({ id: 'mood-ko', lang: 'ko', rules: ['mood-hidden'] });
    const grades = gradeRun({
      rules: RULES,
      cases: [runCase(unlisted)],
      trials: [moodLine(okLine())],
    });
    expect(grades.filter(({ ruleId }) => ruleId === 'mood-hidden').map((g) => g.outcome)).toEqual([
      'error',
      'error',
    ]);
  });

  it('001 FR-018 shipped text of discarded and substituted trials is not graded', () => {
    expect(gradesOf(okLine({ raw: '😀', finalKind: 'discarded' }))).toEqual([
      ['chat-only', 'final', 'skip'],
      ['chat-only', 'raw', 'fail', ['😀']],
      ['completed', 'trial', 'fail'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'fail', ['😀']],
      ['script-ko', 'final', 'skip'],
      ['script-ko', 'raw', 'pass'],
    ]);
    expect(gradesOf(okLine({ raw: '안녕', finalKind: 'fallback', final: '😀' }))).toEqual([
      ['chat-only', 'final', 'skip'],
      ['chat-only', 'raw', 'pass'],
      ['completed', 'trial', 'fail'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'pass'],
      ['script-ko', 'final', 'skip'],
      ['script-ko', 'raw', 'pass'],
    ]);
  });

  it('001 FR-018 an empty output is judged only by completed', () => {
    const skippedText = [
      ['chat-only', 'final', 'skip'],
      ['chat-only', 'raw', 'skip'],
      ['completed', 'trial', 'fail'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'skip'],
      ['script-ko', 'final', 'skip'],
      ['script-ko', 'raw', 'skip'],
    ];
    expect(gradesOf(okLine({ raw: ' 　', final: ' 　', finishReason: 'length' }))).toEqual(
      skippedText,
    );
    expect(gradesOf(okLine({ raw: '', answers: 0, finalKind: 'discarded' }))).toEqual(skippedText);
    expect(gradesOf(okLine({ raw: '😀', final: '' }))).toContainEqual([
      'no-emoji',
      'final',
      'skip',
    ]);
  });

  it('001 FR-009 error trials: completion failures for rejections and time-outs, excluded otherwise', () => {
    const allSkipped = gradesOf(errorLine('transient')).map(([, , outcome]) => outcome);
    expect(new Set(allSkipped)).toEqual(new Set(['skip']));
    for (const line of [errorLine('config'), errorLine('adapter'), stoppedLine()]) {
      expect(new Set(gradesOf(line).map(([, , outcome]) => outcome))).toEqual(new Set(['skip']));
    }
    for (const kind of ['permanent', 'timeout'] as const) {
      const grades = gradesOf(errorLine(kind));
      expect(grades.filter(([, , outcome]) => outcome !== 'skip')).toEqual([
        ['completed', 'trial', 'fail'],
      ]);
    }
  });

  it('001 FR-027 a changed case gets skip for every rule that applies to it as defined now', () => {
    const changed: RunCase = { ...runCase(mood), current: { definition: mood, hash: OTHER_HASH } };
    expect(gradesOf(moodLine(okLine({ raw: '😀', final: '😀' })), changed)).toEqual([
      ['chat-only', 'final', 'skip'],
      ['chat-only', 'raw', 'skip'],
      ['completed', 'trial', 'skip'],
      ['mood-hidden', 'final', 'skip'],
      ['mood-hidden', 'raw', 'skip'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'skip'],
      ['script-ko', 'final', 'skip'],
      ['script-ko', 'raw', 'skip'],
    ]);
    // The current definition decides, not the target the manifest recorded.
    const moved: RunCase = { ...changed, target: 'summary' };
    expect(gradesOf(moodLine(okLine()), moved).map(([ruleId]) => ruleId)).toContain('chat-only');
  });

  it('001 FR-027 a deleted case gets skip for every global rule matching its target and language', () => {
    const deleted: RunCase = { id: 'greet-ko', lang: 'ko', hash: HASH, target: 'chat' };
    expect(gradesOf(okLine(), deleted)).toEqual([
      ['chat-only', 'final', 'skip'],
      ['chat-only', 'raw', 'skip'],
      ['completed', 'trial', 'skip'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'skip'],
      ['script-ko', 'final', 'skip'],
      ['script-ko', 'raw', 'skip'],
    ]);
    const english: RunCase = { id: 'greet-ko', lang: 'en', hash: HASH, target: 'summary' };
    expect(gradesOf(okLine(), english)).toEqual([
      ['completed', 'trial', 'skip'],
      ['no-emoji', 'final', 'skip'],
      ['no-emoji', 'raw', 'skip'],
      ['other-target', 'final', 'skip'],
      ['other-target', 'raw', 'skip'],
    ]);
  });

  it('001 FR-018 sorts grades by case, repeat, rule and surface', () => {
    const grades = gradeRun({
      rules: RULES,
      cases: [runCase(mood), runCase(greet)],
      trials: [
        moodLine(okLine({ repeat: 1 })),
        okLine({ repeat: 1 }),
        moodLine(okLine()),
        okLine(),
      ],
    });
    const keys = grades.map(({ caseId, repeat }) => `${caseId}#${String(repeat)}`);
    expect([...new Set(keys)]).toEqual(['greet-ko#0', 'greet-ko#1', 'mood-ko#0', 'mood-ko#1']);
  });

  it('001 FR-017 gives the same grades for the same trials and rules every time', () => {
    const input = {
      rules: RULES,
      cases: [runCase(greet), runCase(mood)],
      trials: [okLine({ raw: '안녕 😀' }), moodLine(okLine({ raw: '짜증' }))],
    };
    expect(gradeRun(input)).toEqual(gradeRun(input));
  });
});

function moodLine(line: AttemptLine): AttemptLine {
  return { ...line, caseId: 'mood-ko' };
}
