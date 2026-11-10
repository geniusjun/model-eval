import { describe, expect, it } from 'vitest';

import {
  aggregates,
  cellEvidence,
  cellOf,
  isNotApplicable,
  baselineRate,
  type CellEvidence,
  type CellsInput,
} from '../../../src/compare/cells.js';
import { commonCases } from '../../../src/compare/common-cases.js';
import { finishedTrials } from '../../../src/compare/finished.js';
import { systematicFailures } from '../../../src/compare/systematic.js';
import type { Sha256 } from '../../../src/config/identifiers.js';
import { caseSchema, ruleSchema, type Surface } from '../../../src/config/schema.js';
import type { RunCase } from '../../../src/grade/grade.js';
import type { Grade, GradeOutcome } from '../../../src/grade/record.js';
import { cellSchema } from '../../../src/report/schema.js';
import type { AttemptLine, TrialLine } from '../../../src/run/records.js';
import { zValues, type PerRole } from '../../../src/stats/interval.js';
import { errorLine, okLine, stoppedLine } from '../grade/lines.js';

const HASH: Sha256 = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH: Sha256 = `sha256:${'b'.repeat(64)}`;

const RULES = [
  { id: 'completed', check: { type: 'completed' }, scope: 'global' },
  { id: 'no-emoji', check: { type: 'emoji' }, scope: 'global', margin: 0.05 },
  { id: 'script-ko', check: { type: 'script', allow: ['Hangul', 'Common'] }, scope: 'global' },
].map((rule) => ruleSchema.parse({ title: rule.id, severity: 'major', ...rule }));

const Z = zValues(0.95, 0);

function runCase(
  id: string,
  lang: string,
  hash: Sha256 = HASH,
  current: Sha256 | null = HASH,
): RunCase {
  const definition = caseSchema.parse({
    id,
    target: 'chat',
    lang,
    provenance: 'synthetic',
    input: {},
  });
  return {
    id,
    target: 'chat',
    lang,
    hash,
    current: current === null ? undefined : { definition, hash: current, lang },
  };
}

/** Grades of one case for one rule and surface: `outcomes[r]` is the grade of repeat r. */
function grades(
  caseId: string,
  ruleId: string,
  surface: Surface,
  outcomes: readonly GradeOutcome[],
): Grade[] {
  return outcomes.map((outcome, repeat) => ({ caseId, repeat, ruleId, surface, outcome }));
}

const passes = (n: number, fails = 0): GradeOutcome[] => [
  ...new Array<GradeOutcome>(n).fill('pass'),
  ...new Array<GradeOutcome>(fails).fill('fail'),
];

const none: PerRole<readonly AttemptLine[]> = { baseline: [], candidate: [] };

function input(fields: Partial<CellsInput> & Pick<CellsInput, 'grades'>): CellsInput {
  return {
    cases: ['a', 'b', 'c', 'd'].map((id) => ({ id: `${id}-ko`, lang: 'ko' })),
    rules: RULES,
    gateMargin: 0.1,
    systematic: none,
    finished: none,
    ...fields,
  };
}

function only(
  evidence: readonly CellEvidence[],
  ruleId: string,
  surface: Surface,
  lang = 'ko',
): CellEvidence {
  const found = evidence.find(
    (cell) => cell.ruleId === ruleId && cell.surface === surface && cell.lang === lang,
  );
  if (found === undefined) {
    throw new Error(`no cell ${ruleId} ${lang} ${surface}`);
  }
  return found;
}

const context = { gated: false, z: Z, minCases: 3, runCases: 4 };

describe('common cases', () => {
  it('001 FR-021 keeps cases in both runs whose content is unchanged, with the manifest language', () => {
    const baseline = [
      runCase('both', 'ko'),
      runCase('changed-now', 'ko', HASH, OTHER_HASH),
      runCase('deleted', 'ko', HASH, null),
      runCase('baseline-only', 'ko'),
      runCase('changed-before', 'ja', OTHER_HASH, HASH),
    ];
    const candidate = [
      runCase('both', 'ko'),
      runCase('changed-now', 'ko', HASH, OTHER_HASH),
      runCase('deleted', 'ko', HASH, null),
      runCase('candidate-only', 'ko'),
      runCase('changed-before', 'ja'),
    ];
    expect(commonCases({ baseline, candidate })).toEqual([{ id: 'both', lang: 'ko' }]);
  });
});

describe('finished trials', () => {
  it('001 FR-009 keeps the effective line of finished keys on the given cases only', () => {
    const lines: TrialLine[] = [
      errorLine('transient', { caseId: 'a', repeat: 0, attempt: 1 }),
      okLine({ caseId: 'a', repeat: 0, attempt: 2 }),
      errorLine('transient', { caseId: 'a', repeat: 1, attempt: 1 }),
      stoppedLine({ caseId: 'a', repeat: 2 }),
      errorLine('adapter', { caseId: 'a', repeat: 3 }),
      okLine({ caseId: 'gone', repeat: 0 }),
    ];
    const finished = finishedTrials(lines, 2, new Set(['a']));
    expect(finished.map((line) => [line.repeat, line.status])).toEqual([
      [0, 'ok'],
      [3, 'error'],
    ]);
  });

  it('001 FR-009 a transient line without retries left is finished', () => {
    const lines: TrialLine[] = [errorLine('transient', { caseId: 'a', repeat: 0, attempt: 1 })];
    expect(finishedTrials(lines, 0, new Set(['a']))).toHaveLength(1);
  });
});

describe('systematic failures', () => {
  const transient = (caseId: string, repeat: number) => errorLine('transient', { caseId, repeat });
  const adapter = (caseId: string, repeat: number) => errorLine('adapter', { caseId, repeat });
  const ok = (caseId: string, repeat: number) => okLine({ caseId, repeat });

  it('001 FR-009 two or more finished trials of a case all transient or adapter, with a completed-graded trial on the other side', () => {
    const result = systematicFailures({
      baseline: [ok('a', 0), ok('a', 1), ok('b', 0)],
      candidate: [transient('a', 0), adapter('a', 1), transient('b', 0), ok('b', 1)],
    });
    expect(result.candidate.map((line) => [line.caseId, line.repeat])).toEqual([
      ['a', 0],
      ['a', 1],
    ]);
    expect(result.baseline).toEqual([]);
  });

  it('001 FR-009 one such trial is not systematic', () => {
    const result = systematicFailures({ baseline: [ok('a', 0)], candidate: [transient('a', 0)] });
    expect(result.candidate).toEqual([]);
  });

  it('001 FR-009 needs a completed-graded trial of the case in the other variant', () => {
    const permanent = errorLine('permanent', { caseId: 'b', repeat: 0 });
    const result = systematicFailures({
      baseline: [transient('a', 0), transient('a', 1), permanent],
      candidate: [adapter('a', 0), adapter('a', 1), transient('b', 0), transient('b', 1)],
    });
    expect(result.baseline).toEqual([]);
    expect(result.candidate.map((line) => line.caseId)).toEqual(['b', 'b']);
  });
});

describe('cell evidence', () => {
  it('001 FR-021 K counts common cases judged in both runs; a case judged in one run only is dropped', () => {
    const evidence = cellEvidence(
      input({
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(3)),
            ...grades('b-ko', 'no-emoji', 'raw', passes(3)),
            ...grades('c-ko', 'no-emoji', 'raw', passes(2)),
            ...grades('x-ko', 'no-emoji', 'raw', passes(3)),
          ],
          candidate: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(2, 1)),
            ...grades('b-ko', 'no-emoji', 'raw', ['pass', 'skip', 'error']),
            ...grades('c-ko', 'no-emoji', 'raw', ['skip', 'skip']),
          ],
        },
      }),
    );
    const cell = only(evidence, 'no-emoji', 'raw');
    expect(cell.pairs).toEqual([
      { baseline: { trials: 3, passes: 3 }, candidate: { trials: 3, passes: 2 } },
      { baseline: { trials: 3, passes: 3 }, candidate: { trials: 1, passes: 1 } },
    ]);
    expect(cell.droppedCases).toBe(1);
    expect(cell.judgedTrials).toEqual({ baseline: 8, candidate: 4 });
    expect(cell.margin).toBe(0.05);
  });

  it('001 FR-021 a cell with only excluded grades is not applicable and has no baseline rate', () => {
    const evidence = cellEvidence(
      input({
        grades: {
          baseline: grades('a-ko', 'script-ko', 'final', ['skip']),
          candidate: grades('a-ko', 'script-ko', 'final', ['skip', 'error']),
        },
      }),
    );
    const cell = only(evidence, 'script-ko', 'final');
    expect(isNotApplicable(cell)).toBe(true);
    expect(baselineRate(cell)).toBeNull();
    expect(cellOf(cell, context)).toMatchObject({
      verdict: 'not-applicable',
      cases: 0,
      margin: 0.1,
    });
  });

  it('001 FR-021 the baseline rate is case-weighted over the common cases', () => {
    const evidence = cellEvidence(
      input({
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(1, 1)),
            ...grades('b-ko', 'no-emoji', 'raw', passes(4)),
          ],
          candidate: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(1)),
            ...grades('b-ko', 'no-emoji', 'raw', passes(1)),
          ],
        },
      }),
    );
    expect(baselineRate(only(evidence, 'no-emoji', 'raw'))).toBe(0.75);
  });

  it('001 FR-009 systematic failures fail the completed cell only, counted per variant', () => {
    const systematic = {
      baseline: [],
      candidate: [
        errorLine('transient', { caseId: 'a-ko', repeat: 0 }),
        errorLine('adapter', { caseId: 'a-ko', repeat: 1 }),
      ],
    };
    const evidence = cellEvidence(
      input({
        systematic,
        grades: {
          baseline: [
            ...grades('a-ko', 'completed', 'trial', passes(2)),
            ...grades('a-ko', 'no-emoji', 'raw', passes(2)),
          ],
          candidate: [
            ...grades('a-ko', 'completed', 'trial', ['skip', 'skip']),
            ...grades('a-ko', 'no-emoji', 'raw', ['skip', 'skip']),
          ],
        },
      }),
    );
    const completed = only(evidence, 'completed', 'trial');
    expect(completed.pairs).toEqual([
      { baseline: { trials: 2, passes: 2 }, candidate: { trials: 2, passes: 0 } },
    ]);
    expect(completed.systematic).toEqual({
      baseline: { trials: 0, cases: 0 },
      candidate: { trials: 2, cases: 1 },
    });
    const raw = only(evidence, 'no-emoji', 'raw');
    expect(raw.pairs).toEqual([]);
    expect(raw.droppedCases).toBe(1);
    expect(raw.systematic).toBeUndefined();
  });

  it('001 FR-009 completed cells count the transient and adapter errors left out because they were not systematic', () => {
    const key = (caseId: string, repeat: number) => ({ caseId, repeat });
    const systematic = {
      baseline: [],
      candidate: [errorLine('transient', key('a-ko', 0)), errorLine('transient', key('a-ko', 1))],
    };
    const finished = {
      baseline: [errorLine('adapter', key('b-ko', 1)), okLine(key('b-ko', 0))],
      candidate: [
        ...systematic.candidate,
        errorLine('transient', key('b-ko', 0)),
        errorLine('adapter', key('b-ko', 1)),
        errorLine('transient', key('c-ko', 0)),
        errorLine('config', key('c-ko', 1)),
      ],
    };
    const evidence = cellEvidence(
      input({
        systematic,
        finished,
        grades: {
          baseline: [
            ...grades('a-ko', 'completed', 'trial', passes(2)),
            ...grades('b-ko', 'completed', 'trial', ['pass', 'skip']),
            ...grades('c-ko', 'completed', 'trial', passes(2)),
            ...grades('b-ko', 'no-emoji', 'raw', ['pass', 'skip']),
          ],
          candidate: [
            ...grades('a-ko', 'completed', 'trial', ['skip', 'skip']),
            ...grades('b-ko', 'completed', 'trial', ['skip', 'skip']),
            ...grades('c-ko', 'completed', 'trial', ['skip', 'skip']),
            ...grades('b-ko', 'no-emoji', 'raw', ['skip', 'skip']),
          ],
        },
      }),
    );
    // a-ko is systematic and c-ko #1 is a configuration error, so neither counts.
    const completed = only(evidence, 'completed', 'trial');
    expect(completed.excluded).toEqual({
      baseline: { transient: 0, adapter: 1 },
      candidate: { transient: 2, adapter: 1 },
    });
    expect(cellOf(completed, context).excluded).toEqual(completed.excluded);
    expect(cellSchema.parse(cellOf(completed, context))).toMatchObject({
      excluded: completed.excluded,
    });
    expect(only(evidence, 'no-emoji', 'raw').excluded).toBeUndefined();
  });

  it('001 FR-009 masked is the share of trials judged on both surfaces that failed raw and passed final, on raw cells only', () => {
    const evidence = cellEvidence(
      input({
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'raw', ['fail', 'fail', 'pass', 'pass']),
            ...grades('a-ko', 'no-emoji', 'final', ['pass', 'fail', 'pass', 'skip']),
          ],
          candidate: [
            ...grades('a-ko', 'no-emoji', 'raw', ['pass', 'pass']),
            ...grades('a-ko', 'no-emoji', 'final', ['skip', 'skip']),
          ],
        },
      }),
    );
    expect(only(evidence, 'no-emoji', 'raw').masked).toEqual({ baseline: 1 / 3, candidate: null });
    expect(only(evidence, 'no-emoji', 'final').masked).toBeUndefined();
  });

  it('001 FR-009 masked counts the K paired cases only', () => {
    const evidence = cellEvidence(
      input({
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'raw', ['pass', 'pass']),
            ...grades('a-ko', 'no-emoji', 'final', ['pass', 'pass']),
          ],
          candidate: [
            ...grades('a-ko', 'no-emoji', 'raw', ['pass', 'pass']),
            ...grades('a-ko', 'no-emoji', 'final', ['pass', 'pass']),
            ...grades('b-ko', 'no-emoji', 'raw', ['fail', 'fail']),
            ...grades('b-ko', 'no-emoji', 'final', ['pass', 'pass']),
          ],
        },
      }),
    );
    const raw = only(evidence, 'no-emoji', 'raw');
    expect(raw.droppedCases).toBe(1);
    expect(raw.masked).toEqual({ baseline: 0, candidate: 0 });
  });

  it('001 FR-009 a trial with a config call is not a left-out adapter error, whatever the adapter reported', () => {
    const configCall = { model: 'm', outcome: 'failed', errorKind: 'config' };
    const finished = {
      baseline: [],
      candidate: [errorLine('adapter', { caseId: 'a-ko', repeat: 0, calls: [configCall] })],
    };
    const evidence = cellEvidence(
      input({
        finished,
        grades: {
          baseline: grades('a-ko', 'completed', 'trial', passes(1)),
          candidate: grades('a-ko', 'completed', 'trial', ['skip']),
        },
      }),
    );
    expect(only(evidence, 'completed', 'trial').excluded?.candidate).toEqual({
      transient: 0,
      adapter: 0,
    });
  });

  it('001 FR-021 cells follow rule order, then language, then raw, final, trial', () => {
    const evidence = cellEvidence(
      input({
        cases: [
          { id: 'a-ko', lang: 'ko' },
          { id: 'a-ja', lang: 'ja' },
        ],
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'final', passes(1)),
            ...grades('a-ko', 'no-emoji', 'raw', passes(1)),
            ...grades('a-ja', 'no-emoji', 'raw', passes(1)),
            ...grades('a-ko', 'completed', 'trial', passes(1)),
            ...grades('x-ko', 'script-ko', 'raw', passes(1)),
          ],
          candidate: [],
        },
      }),
    );
    expect(evidence.map(({ ruleId, lang, surface }) => `${ruleId}/${lang}/${surface}`)).toEqual([
      'completed/ko/trial',
      'no-emoji/ja/raw',
      'no-emoji/ko/raw',
      'no-emoji/ko/final',
    ]);
  });
});

describe('cells', () => {
  const fiveCases = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id: `${id}-ko`, lang: 'ko' }));

  function evidenceOf(baselinePasses: number, candidatePasses: number, repeats = 10): CellEvidence {
    const of = (passed: number) =>
      fiveCases.flatMap(({ id }) =>
        grades(id, 'completed', 'trial', passes(passed, repeats - passed)),
      );
    return only(
      cellEvidence(
        input({
          cases: fiveCases,
          grades: { baseline: of(baselinePasses), candidate: of(candidatePasses) },
        }),
      ),
      'completed',
      'trial',
    );
  }

  it('001 FR-021 failRatio is null when the baseline has no failure', () => {
    const cell = cellOf(evidenceOf(10, 9), context);
    expect(cell.failRatio).toBeNull();
    expect(cellSchema.parse(cell)).toEqual(cell);
  });

  it('001 FR-021 failRatio divides the failure rates, 1 − rate', () => {
    const cell = cellOf(evidenceOf(8, 6), context);
    expect(cell.failRatio).toBeCloseTo(2, 12);
  });

  it('001 FR-021 a completed cell carries systematic counts even without systematic failures', () => {
    expect(cellOf(evidenceOf(10, 10), context).systematic).toEqual({
      baseline: { trials: 0, cases: 0 },
      candidate: { trials: 0, cases: 0 },
    });
  });

  it('001 FR-024 needed is attached to undecided gated cells only', () => {
    const evidence = evidenceOf(4, 3, 4);
    const ungated = cellOf(evidence, context);
    expect(ungated.verdict).toBe('insufficient');
    expect(ungated.needed).toBeUndefined();
    const gated = cellOf(evidence, { ...context, gated: true, z: zValues(0.95, 1) });
    expect(gated).toMatchObject({ gated: true, verdict: 'insufficient' });
    expect(gated.needed).toBeDefined();
    expect(cellSchema.parse(gated)).toEqual(gated);
  });

  it('001 FR-021 a decided gated cell has no needed', () => {
    const cell = cellOf(evidenceOf(20, 20, 20), { ...context, gated: true, z: zValues(0.95, 1) });
    expect(cell.verdict).toBe('non-inferior');
    expect(cell.needed).toBeUndefined();
  });
});

describe('aggregates', () => {
  it('001 FR-021 pool trials and passes per rule and surface over languages, without a verdict', () => {
    const cases = [
      { id: 'a-ko', lang: 'ko' },
      { id: 'a-ja', lang: 'ja' },
    ];
    const evidence = cellEvidence(
      input({
        cases,
        grades: {
          baseline: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(4)),
            ...grades('a-ja', 'no-emoji', 'raw', passes(3, 1)),
          ],
          candidate: [
            ...grades('a-ko', 'no-emoji', 'raw', passes(2, 2)),
            ...grades('a-ja', 'no-emoji', 'raw', passes(4)),
          ],
        },
      }),
    );
    const result = aggregates(evidence.map((cell) => cellOf(cell, context)));
    expect(result).toEqual([
      {
        ruleId: 'no-emoji',
        surface: 'raw',
        baseline: { trials: 8, passes: 7, rate: 7 / 8 },
        candidate: { trials: 8, passes: 6, rate: 6 / 8 },
        diff: 6 / 8 - 7 / 8,
      },
    ]);
    expect(result[0]).not.toHaveProperty('verdict');
  });

  it('001 FR-021 an aggregate without common trials has null rates', () => {
    const evidence = cellEvidence(
      input({ grades: { baseline: grades('a-ko', 'no-emoji', 'raw', ['skip']), candidate: [] } }),
    );
    expect(aggregates(evidence.map((cell) => cellOf(cell, context)))).toEqual([
      {
        ruleId: 'no-emoji',
        surface: 'raw',
        baseline: { trials: 0, passes: 0, rate: null },
        candidate: { trials: 0, passes: 0, rate: null },
        diff: null,
      },
    ]);
  });
});
