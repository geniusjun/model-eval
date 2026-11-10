import { describe, expect, it } from 'vitest';

import type { CellTrials } from '../../../src/compare/gate.js';
import {
  comparisonSamples,
  decisionSummary,
  judgedScope,
  type ComparedCase,
  type SamplesInput,
} from '../../../src/compare/summary.js';
import { caseSchema, ruleSchema, type Rule } from '../../../src/config/schema.js';
import {
  cellSchema,
  samplesSchema,
  summarySchema,
  type Cell,
  type OpsChange,
} from '../../../src/report/schema.js';
import type { AttemptLine } from '../../../src/run/records.js';
import { errorLine, okLine, stoppedLine } from '../grade/lines.js';

function rule(fields: Record<string, unknown>): Rule {
  return ruleSchema.parse({
    title: 'title',
    severity: 'blocking',
    scope: 'global',
    check: { type: 'emoji' },
    ...fields,
  });
}

const RULES = [
  rule({ id: 'completed', check: { type: 'completed' } }),
  rule({ id: 'no-emoji' }),
  rule({ id: 'script-ja', languages: ['ja'], check: { type: 'script', allow: ['Han'] } }),
  rule({ id: 'self-state', scope: 'listed', check: { type: 'review', samples: 2 } }),
];

const rate = (value: number) => ({
  cases: 30,
  trials: 150,
  passes: Math.round(value * 150),
  rate: value,
  pooledRate: value,
  low: Math.max(0, value - 0.05),
  high: Math.min(1, value + 0.03),
  nEff: 150,
});

function cell(fields: Record<string, unknown> = {}): Cell {
  return cellSchema.parse({
    ruleId: 'no-emoji',
    lang: 'ko',
    surface: 'raw',
    gated: true,
    cases: 30,
    droppedCases: 0,
    baseline: rate(1),
    candidate: rate(0.99),
    diff: { estimate: -0.01, low: -0.05, high: 0.02 },
    deff: 1,
    failRatio: null,
    margin: 0.1,
    verdict: 'non-inferior',
    ...fields,
  });
}

const key = (c: Cell) => ({ ruleId: c.ruleId, lang: c.lang, surface: c.surface });

describe('decision summary', () => {
  const regressed = cell({
    ruleId: 'script-ja',
    lang: 'ja',
    diff: { estimate: -0.3, low: -0.37, high: -0.19 },
    verdict: 'regressed',
  });
  const dropUndecided = cell({
    ruleId: 'completed',
    surface: 'trial',
    diff: { estimate: -0.1, low: -0.16, high: -0.04 },
    verdict: 'inconclusive',
    note: 'drop-margin-undecided',
    needed: { kind: 'on-margin' },
  });
  const dropHeld = cell({
    surface: 'final',
    gated: false,
    diff: { estimate: -0.03, low: -0.06, high: -0.01 },
    note: 'drop-within-margin',
  });
  const clearDrop = cell({
    lang: 'en',
    cases: 2,
    gated: false,
    diff: { estimate: -0.5, low: -0.9, high: 0.1 },
    verdict: 'insufficient',
    note: 'clear-drop-too-few-cases',
  });
  const undecided = cell({
    lang: 'ja',
    cases: 2,
    verdict: 'insufficient',
    needed: { kind: 'cases', cases: 3 },
  });
  const improved = cell({
    ruleId: 'completed',
    lang: 'ja',
    surface: 'trial',
    diff: { estimate: 0.1, low: 0.02, high: 0.15 },
    verdict: 'improved',
  });
  const held = cell();
  const notApplicable = cell({ lang: 'zh', verdict: 'not-applicable', diff: null });
  const cells = [
    held,
    regressed,
    dropUndecided,
    improved,
    dropHeld,
    clearDrop,
    undecided,
    notApplicable,
  ];
  const ops: OpsChange[] = [
    { metric: 'discard', baseline: 0.003, candidate: 0.03, warning: 'discard-rate-increase' },
    { metric: 'latencyP95', baseline: 1900, candidate: 2600, ratio: 1.37 },
  ];
  const scope = judgedScope(RULES, ['chat'], cells);
  const summary = summarySchema.parse(decisionSummary({ cells, ops, scope }));

  it('001 FR-028 is in the order worse, improved, unknown, ops, scope', () => {
    expect(Object.keys(summary)).toEqual(['worse', 'improved', 'unknown', 'ops', 'scope']);
  });

  it('001 FR-028 lists regressed cells and every confirmed or clear drop as worse, in cell order', () => {
    expect(summary.worse).toEqual([
      { ...key(regressed), verdict: 'regressed' },
      {
        ...key(dropUndecided),
        verdict: 'inconclusive',
        note: 'drop-margin-undecided',
        needed: { kind: 'on-margin' },
      },
      { ...key(dropHeld), verdict: 'non-inferior', note: 'drop-within-margin' },
      { ...key(clearDrop), verdict: 'insufficient', note: 'clear-drop-too-few-cases' },
    ]);
  });

  it('001 FR-028 lists improved cells', () => {
    expect(summary.improved).toEqual([{ ...key(improved), verdict: 'improved' }]);
  });

  it('001 FR-024 lists undecided cells with `needed`; a confirmed drop is in worse and unknown', () => {
    expect(summary.unknown).toEqual([
      {
        ...key(dropUndecided),
        verdict: 'inconclusive',
        note: 'drop-margin-undecided',
        needed: { kind: 'on-margin' },
      },
      { ...key(undecided), verdict: 'insufficient', needed: { kind: 'cases', cases: 3 } },
    ]);
  });

  it('001 FR-028 carries the operational changes as given', () => {
    expect(summary.ops).toEqual(ops);
  });

  it('001 FR-028 scope: judged rules have a judged cell; `review` rules are listed apart', () => {
    expect(summary.scope).toEqual({
      targets: ['chat'],
      judgedRules: ['completed', 'no-emoji', 'script-ja'],
      notJudgedRules: [],
      reviewRules: ['self-state'],
    });
    expect(
      judgedScope(
        RULES,
        ['chat'],
        [notApplicable, cell({ ruleId: 'completed', surface: 'trial' })],
      ),
    ).toEqual({
      targets: ['chat'],
      judgedRules: ['completed'],
      notJudgedRules: ['no-emoji', 'script-ja'],
      reviewRules: ['self-state'],
    });
  });
});

describe('samples', () => {
  function comparedCase(id: string, lang: string, rules: string[] = []): ComparedCase {
    return {
      definition: caseSchema.parse({
        id,
        target: 'chat',
        lang,
        provenance: 'synthetic',
        input: {},
        rules,
      }),
      lang,
    };
  }
  const CASES = [
    comparedCase('mood-ko', 'ko', ['self-state']),
    comparedCase('greet-ja', 'ja'),
    comparedCase('ask-ko', 'ko', ['self-state']),
  ];
  const line = (caseId: string, repeat: number, fields: Record<string, unknown> = {}) =>
    okLine({
      caseId,
      repeat,
      raw: `${caseId} ${String(repeat)} raw`,
      final: `${caseId} final`,
      ...fields,
    });

  const baselineTrials: AttemptLine[] = [
    line('ask-ko', 0),
    line('ask-ko', 1),
    line('ask-ko', 2),
    line('greet-ja', 0),
    line('greet-ja', 1),
    stoppedLine({ caseId: 'mood-ko', repeat: 0 }),
    line('mood-ko', 1),
    line('mood-ko', 2),
  ];
  const candidateTrials: AttemptLine[] = [
    line('ask-ko', 0),
    errorLine('transient', { caseId: 'ask-ko', repeat: 1 }),
    line('ask-ko', 2),
    line('greet-ja', 0, { raw: '안녕', finalKind: 'discarded', final: undefined }),
    line('greet-ja', 1, { raw: '안녕하세요' }),
    line('mood-ko', 0),
    line('mood-ko', 1),
    line('mood-ko', 2),
  ];
  const regressed = cell({
    ruleId: 'script-ja',
    lang: 'ja',
    diff: { estimate: -0.3, low: -0.37, high: -0.19 },
    verdict: 'regressed',
  });

  function samples(overrides: Partial<SamplesInput> = {}) {
    return samplesSchema.parse(
      comparisonSamples({
        rules: RULES,
        cases: CASES,
        trials: { baseline: baselineTrials, candidate: candidateTrials },
        cells: [cell(), regressed],
        cellTrials: [],
        perCell: 3,
        ...overrides,
      }),
    );
  }

  it('001 FR-020 takes the lowest `samples` repeats per case of each `review` rule in both runs', () => {
    expect(samples().review).toEqual([
      {
        ruleId: 'self-state',
        keys: [
          { variant: 'baseline', caseId: 'ask-ko', repeat: 0 },
          { variant: 'candidate', caseId: 'ask-ko', repeat: 0 },
          { variant: 'baseline', caseId: 'ask-ko', repeat: 1 },
          { variant: 'candidate', caseId: 'ask-ko', repeat: 1 },
          { variant: 'candidate', caseId: 'mood-ko', repeat: 0 },
          { variant: 'baseline', caseId: 'mood-ko', repeat: 1 },
          { variant: 'candidate', caseId: 'mood-ko', repeat: 1 },
        ],
      },
    ]);
  });

  it('001 FR-020 stores each text once, raw and final, and error trials as kind and message', () => {
    const { texts } = samples();
    expect(texts.map((text) => [text.variant, text.caseId, text.repeat])).toEqual([
      ['baseline', 'ask-ko', 0],
      ['candidate', 'ask-ko', 0],
      ['baseline', 'ask-ko', 1],
      ['candidate', 'ask-ko', 1],
      ['candidate', 'mood-ko', 0],
      ['baseline', 'mood-ko', 1],
      ['candidate', 'mood-ko', 1],
    ]);
    expect(texts[0]).toEqual({
      variant: 'baseline',
      caseId: 'ask-ko',
      repeat: 0,
      raw: 'ask-ko 0 raw',
      finalKind: 'model',
      final: 'ask-ko final',
      finishReason: 'stop',
    });
    expect(texts[3]).toEqual({
      variant: 'candidate',
      caseId: 'ask-ko',
      repeat: 1,
      error: { kind: 'transient', message: 'transient failure' },
    });
  });

  it('001 FR-028 takes up to `report.samples` failing examples per regressed cell, round-robin across cases', () => {
    const cellTrials: CellTrials[] = [
      {
        ...key(regressed),
        candidateFailures: [
          { caseId: 'b-ja', repeat: 1 },
          { caseId: 'a-ja', repeat: 2, evidence: ['안'] },
          { caseId: 'a-ja', repeat: 0, evidence: ['녕'] },
          { caseId: 'c-ja', repeat: 0 },
          { caseId: 'b-ja', repeat: 0 },
        ],
      },
    ];
    const { failing } = samples({ cellTrials, perCell: 4 });
    expect(failing).toEqual([
      {
        ...key(regressed),
        keys: [
          { variant: 'candidate', caseId: 'a-ja', repeat: 0, evidence: ['녕'] },
          { variant: 'candidate', caseId: 'b-ja', repeat: 0 },
          { variant: 'candidate', caseId: 'c-ja', repeat: 0 },
          { variant: 'candidate', caseId: 'a-ja', repeat: 2, evidence: ['안'] },
        ],
      },
    ]);
  });

  it('001 FR-028 stores failing examples next to the baseline answer to the same case and repeat', () => {
    const cellTrials: CellTrials[] = [
      {
        ...key(regressed),
        candidateFailures: [
          { caseId: 'greet-ja', repeat: 1, evidence: ['안'] },
          { caseId: 'greet-ja', repeat: 0 },
        ],
      },
    ];
    const { texts, failing } = samples({ cellTrials, rules: RULES.slice(0, 3) });
    expect(failing[0]?.keys.map(({ caseId, repeat }) => [caseId, repeat])).toEqual([
      ['greet-ja', 0],
      ['greet-ja', 1],
    ]);
    expect(texts).toEqual([
      {
        variant: 'baseline',
        caseId: 'greet-ja',
        repeat: 0,
        raw: 'greet-ja 0 raw',
        finalKind: 'model',
        final: 'greet-ja final',
        finishReason: 'stop',
      },
      {
        variant: 'candidate',
        caseId: 'greet-ja',
        repeat: 0,
        raw: '안녕',
        finalKind: 'discarded',
        finishReason: 'stop',
      },
      {
        variant: 'baseline',
        caseId: 'greet-ja',
        repeat: 1,
        raw: 'greet-ja 1 raw',
        finalKind: 'model',
        final: 'greet-ja final',
        finishReason: 'stop',
      },
      {
        variant: 'candidate',
        caseId: 'greet-ja',
        repeat: 1,
        raw: '안녕하세요',
        finalKind: 'model',
        final: 'greet-ja final',
        finishReason: 'stop',
      },
    ]);
  });

  it('001 FR-028 gives failing examples only for regressed cells', () => {
    const cellTrials: CellTrials[] = [
      { ...key(cell()), candidateFailures: [{ caseId: 'ask-ko', repeat: 0 }] },
    ];
    expect(samples({ cellTrials }).failing).toEqual([{ ...key(regressed), keys: [] }]);
  });
});
