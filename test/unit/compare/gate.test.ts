import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../../../src/cli/exit-codes.js';
import {
  completionRates,
  decideGate,
  excludedFromGateWarnings,
  gateExit,
  gateRules,
  gatedCellTest,
  type CellTrials,
  type GateInput,
  type LanguageCompletion,
} from '../../../src/compare/gate.js';
import type { CellEvidence } from '../../../src/compare/cells.js';
import { gateConfigSchema, ruleSchema, type Rule } from '../../../src/config/schema.js';
import { cellSchema, gateSchema, type Cell } from '../../../src/report/schema.js';
import { errorLine, okLine } from '../grade/lines.js';

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
  rule({ id: 'self-state', check: { type: 'review' } }),
  rule({ id: 'style-note', severity: 'minor', check: { type: 'review' } }),
];

const GATE = gateConfigSchema.parse({ severities: ['blocking'] });
const EMPTY_GATE = gateConfigSchema.parse({});

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

const completedCell = (fields: Record<string, unknown> = {}) =>
  cell({ ruleId: 'completed', surface: 'trial', ...fields });

const regressed = (fields: Record<string, unknown> = {}) =>
  cell({
    candidate: rate(0.7),
    diff: { estimate: -0.3, low: -0.37, high: -0.19 },
    verdict: 'regressed',
    ...fields,
  });

const inconclusive = (fields: Record<string, unknown> = {}) =>
  cell({
    diff: { estimate: -0.1, low: -0.16, high: -0.04 },
    verdict: 'inconclusive',
    note: 'drop-margin-undecided',
    needed: { kind: 'on-margin' },
    ...fields,
  });

const full = (lang: string, trials = 150, passes = trials): LanguageCompletion => ({
  lang,
  trials,
  passes,
  rate: trials === 0 ? null : passes / trials,
});

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    runs: {
      baseline: { variant: 'current', status: 'complete', timeoutMs: 120000 },
      candidate: { variant: 'next', status: 'complete', timeoutMs: 90000 },
    },
    completion: { baseline: [full('ko')], candidate: [full('ko')] },
    rules: RULES,
    targets: ['chat'],
    gate: GATE,
    cells: [completedCell(), cell()],
    cellTrials: [],
    ...overrides,
  };
}

function gate(overrides: Partial<GateInput> = {}) {
  return gateSchema.parse(decideGate(input(overrides)));
}

const codes = (overrides: Partial<GateInput> = {}) =>
  gate(overrides).reasons.map((reason) => reason.code);

describe('gated rules', () => {
  it('001 FR-025 are active rules of a gated severity applicable to the compared targets', () => {
    const rules = [
      ...RULES,
      rule({ id: 'retired', status: 'retired' }),
      rule({ id: 'summary-only', targets: ['summary'] }),
      rule({ id: 'chat-only', targets: ['chat', 'summary'] }),
      rule({ id: 'major', severity: 'major' }),
    ];
    const { gated } = gateRules(rules, ['chat'], GATE);
    expect(gated.map(({ id }) => id)).toEqual(['completed', 'no-emoji', 'chat-only']);
  });

  it('001 FR-020 moves `review` rules of a gated severity to excluded[] with `excluded-from-gate`', () => {
    const { gated, excluded } = gateRules(RULES, ['chat'], GATE);
    expect(gated.map(({ id }) => id)).not.toContain('self-state');
    expect(excluded).toEqual([{ ruleId: 'self-state', cause: 'review' }]);
    expect(excludedFromGateWarnings(excluded)).toEqual([
      { code: 'excluded-from-gate', ruleId: 'self-state', params: { cause: 'review' } },
    ]);
    expect(gate().excluded).toEqual([{ ruleId: 'self-state', cause: 'review' }]);
  });

  it('001 FR-025 are none for an empty gate', () => {
    expect(gateRules(RULES, ['chat'], EMPTY_GATE)).toEqual({ gated: [], excluded: [] });
  });
});

describe('gated cells', () => {
  const rules = [
    ...RULES,
    rule({ id: 'final-only', gateOn: 'final' }),
    rule({ id: 'both', gateOn: 'both' }),
    rule({ id: 'major', severity: 'major' }),
  ];
  const isGated = gatedCellTest(gateRules(rules, ['chat'], GATE).gated, 0.9);
  const evidence = (
    ruleId: string,
    surface: 'raw' | 'final' | 'trial',
    baselinePasses = 100,
  ): CellEvidence => ({
    ruleId,
    lang: 'ko',
    surface,
    margin: 0.1,
    pairs: [
      {
        baseline: { trials: 100, passes: baselinePasses },
        candidate: { trials: 100, passes: 100 },
      },
    ],
    judgedTrials: { baseline: 100, candidate: 100 },
    droppedCases: 0,
  });

  it('001 FR-025 read the `gateOn` surface, and `trial` for `completed`', () => {
    expect(isGated(evidence('no-emoji', 'raw'))).toBe(true);
    expect(isGated(evidence('no-emoji', 'final'))).toBe(false);
    expect(isGated(evidence('final-only', 'final'))).toBe(true);
    expect(isGated(evidence('final-only', 'raw'))).toBe(false);
    expect(isGated(evidence('both', 'raw'))).toBe(true);
    expect(isGated(evidence('both', 'final'))).toBe(true);
    expect(isGated(evidence('completed', 'trial'))).toBe(true);
    expect(isGated(evidence('completed', 'raw'))).toBe(false);
  });

  it('001 FR-025 exclude rules outside the gate and cells no run judged', () => {
    expect(isGated(evidence('major', 'raw'))).toBe(false);
    expect(isGated(evidence('self-state', 'raw'))).toBe(false);
    expect(
      isGated({
        ...evidence('no-emoji', 'raw'),
        pairs: [],
        judgedTrials: { baseline: 0, candidate: 0 },
      }),
    ).toBe(false);
  });

  it('001 FR-029 exclude low-baseline cells except `completed`', () => {
    expect(isGated(evidence('no-emoji', 'raw', 89))).toBe(false);
    expect(isGated(evidence('no-emoji', 'raw', 90))).toBe(true);
    expect(isGated(evidence('completed', 'trial', 40))).toBe(true);
  });

  it('001 FR-025 keep a judged cell without a common case, so its rule can still block', () => {
    expect(
      isGated({
        ...evidence('no-emoji', 'raw'),
        pairs: [],
        judgedTrials: { baseline: 5, candidate: 0 },
      }),
    ).toBe(true);
  });
});

describe('completion rate', () => {
  const cases = [
    { id: 'a-ko', lang: 'ko' },
    { id: 'b-ja', lang: 'ja' },
    { id: 'c-ko', lang: 'ko' },
  ];
  const at = (caseId: string, repeat: number) => ({ caseId, repeat });
  const systematicLine = errorLine('transient', at('c-ko', 1));
  const finished = {
    baseline: [
      okLine(at('a-ko', 0)),
      errorLine('timeout', at('a-ko', 1)),
      errorLine('adapter', at('b-ja', 0)),
      errorLine('transient', at('c-ko', 0)),
      systematicLine,
      okLine(at('gone-ko', 0)),
    ],
    candidate: [okLine({ ...at('a-ko', 0), finishReason: 'length' })],
  };

  it('001 FR-025 is the share of `pass` among judged trials per language, systematic failures in', () => {
    expect(completionRates(cases, finished, { baseline: [systematicLine], candidate: [] })).toEqual(
      {
        baseline: [
          { lang: 'ko', trials: 3, passes: 1, rate: 1 / 3 },
          { lang: 'ja', trials: 0, passes: 0, rate: null },
        ],
        candidate: [
          { lang: 'ko', trials: 1, passes: 0, rate: 0 },
          { lang: 'ja', trials: 0, passes: 0, rate: null },
        ],
      },
    );
  });
});

describe('gate rows', () => {
  it('001 FR-025 row 1: a `partial` run is `undecided` with `partial-run`', () => {
    const result = gate({
      runs: {
        baseline: { variant: 'current', status: 'complete', timeoutMs: 120000 },
        candidate: { variant: 'next', status: 'partial', stopReason: 'budget', timeoutMs: 90000 },
      },
    });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([
      {
        code: 'partial-run',
        params: { runs: { next: { status: 'partial', stopReason: 'budget' } } },
      },
    ]);
  });

  it('001 FR-025 row 1: a `running` run is `undecided` with stopReason null', () => {
    const result = gate({
      runs: {
        baseline: { variant: 'current', status: 'running', timeoutMs: 120000 },
        candidate: { variant: 'next', status: 'complete', timeoutMs: 90000 },
      },
    });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([
      {
        code: 'partial-run',
        params: { runs: { current: { status: 'running', stopReason: null } } },
      },
    ]);
  });

  it('001 FR-025 row 1: an unfinished run never blocks; its regressed cells stay in the reasons', () => {
    const result = gate({
      runs: {
        baseline: { variant: 'current', status: 'complete', timeoutMs: 120000 },
        candidate: { variant: 'next', status: 'partial', stopReason: 'budget', timeoutMs: 90000 },
      },
      cells: [
        completedCell(),
        regressed(),
        inconclusive({ ruleId: 'completed', surface: 'trial' }),
      ],
    });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons.map((reason) => reason.code)).toEqual(['partial-run', 'regressed']);
    expect(result.blocking).toEqual([]);
    expect(result.undecided).toEqual([]);
  });

  it('001 FR-025 row 2: a run without a judged trial is `undecided` with `no-judged-trials`', () => {
    const result = gate({ completion: { baseline: [full('ko')], candidate: [full('ko', 0)] } });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([{ code: 'no-judged-trials', params: { variants: ['next'] } }]);
  });

  it('001 FR-025 row 2: two runs without a common case are `no-judged-trials` for both', () => {
    const result = gate({ completion: { baseline: [], candidate: [] }, cells: [] });
    expect(result.reasons).toEqual([
      { code: 'no-judged-trials', params: { variants: ['current', 'next'] } },
    ]);
  });

  it('001 FR-025 row 3: baseline completion below 0.5 in a language is `baseline-incomplete`', () => {
    const result = gate({
      completion: {
        baseline: [full('ko'), full('ja', 100, 49), full('en', 100, 50)],
        candidate: [full('ko'), full('ja'), full('en')],
      },
    });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([
      { code: 'baseline-incomplete', lang: 'ja', params: { rate: 0.49 } },
    ]);
  });

  it('001 FR-025 row 3 reads the baseline only', () => {
    const result = gate({
      completion: { baseline: [full('ko')], candidate: [full('ko', 100, 10)] },
    });
    expect(result.reasons.map((reason) => reason.code)).not.toContain('baseline-incomplete');
  });

  it('001 FR-025 rows 1 to 3 come before the gate config, so an empty gate is `undecided` there', () => {
    const premises: Partial<GateInput>[] = [
      {
        runs: {
          baseline: { variant: 'current', status: 'complete', timeoutMs: 120000 },
          candidate: { variant: 'next', status: 'running', timeoutMs: 90000 },
        },
      },
      { completion: { baseline: [full('ko', 0)], candidate: [full('ko')] } },
      { completion: { baseline: [full('ko', 10, 4)], candidate: [full('ko')] } },
    ];
    for (const premise of premises) {
      expect(gate({ gate: EMPTY_GATE, cells: [], ...premise }).outcome).toBe('undecided');
    }
  });

  it('001 FR-025 row 4: an empty gate is `no-gate` with exit 0', () => {
    const result = gate({
      gate: EMPTY_GATE,
      cells: [completedCell({ gated: false }), regressed({ gated: false })],
    });
    expect(result).toEqual({
      outcome: 'no-gate',
      reasons: [{ code: 'no-gate' }],
      blocking: [],
      undecided: [],
      excluded: [],
    });
    expect(EXIT_CODES[gateExit(result.outcome)]).toBe(0);
  });

  it('001 FR-025 row 5: no gated cell is `undecided` with `no-gated-cells`', () => {
    const result = gate({
      cells: [completedCell({ gated: false, verdict: 'not-applicable' })],
    });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons[0]).toEqual({ code: 'no-gated-cells' });
  });

  it('001 FR-025 row 6: a regressed gated cell blocks, one reason per cell', () => {
    const result = gate({
      cells: [
        completedCell(),
        regressed(),
        regressed({ lang: 'ja' }),
        regressed({ gated: false, lang: 'en' }),
      ],
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toEqual([
      { code: 'regressed', ruleId: 'no-emoji', lang: 'ko', surface: 'raw' },
      { code: 'regressed', ruleId: 'no-emoji', lang: 'ja', surface: 'raw' },
    ]);
    expect(result.blocking).toEqual([
      { ruleId: 'no-emoji', lang: 'ko', surface: 'raw' },
      { ruleId: 'no-emoji', lang: 'ja', surface: 'raw' },
    ]);
    expect(EXIT_CODES[gateExit(result.outcome)]).toBe(1);
  });

  it('001 FR-025 row 6 also lists undecided gated cells', () => {
    const result = gate({
      cells: [inconclusive({ ruleId: 'completed', surface: 'trial' }), regressed()],
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons.map((reason) => reason.code)).toEqual(['regressed', 'cell-undecided']);
    expect(result.undecided).toEqual([
      { ruleId: 'completed', lang: 'ko', surface: 'trial', needed: { kind: 'on-margin' } },
    ]);
  });

  it('001 FR-025 row 7: an undecided gated cell is `undecided` with `cell-undecided` and `needed`', () => {
    const insufficient = cell({
      lang: 'en',
      cases: 2,
      verdict: 'insufficient',
      needed: { kind: 'cases', cases: 3 },
    });
    const result = gate({ cells: [completedCell(), inconclusive(), insufficient] });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([
      { code: 'cell-undecided', ruleId: 'no-emoji', lang: 'ko', surface: 'raw' },
      { code: 'cell-undecided', ruleId: 'no-emoji', lang: 'en', surface: 'raw' },
    ]);
    expect(result.undecided).toEqual([
      { ruleId: 'no-emoji', lang: 'ko', surface: 'raw', needed: { kind: 'on-margin' } },
      { ruleId: 'no-emoji', lang: 'en', surface: 'raw', needed: { kind: 'cases', cases: 3 } },
    ]);
    expect(EXIT_CODES[gateExit(result.outcome)]).toBe(2);
  });

  it('001 FR-025 row 7: a gated rule without a judged cell is `undecided` with `rule-not-judged`', () => {
    const cells = [
      completedCell(),
      cell({ gated: false, verdict: 'not-applicable', diff: null }),
      cell({ surface: 'final', gated: false }),
    ];
    const result = gate({ cells });
    expect(result.outcome).toBe('undecided');
    expect(result.reasons).toEqual([{ code: 'rule-not-judged', ruleId: 'no-emoji' }]);
    expect(result.undecided).toEqual([{ ruleId: 'no-emoji' }]);
  });

  it('001 FR-025 row 7: a rule whose only judged cells are low-baseline is judged, not missing', () => {
    const lowBaseline = cell({ gated: false, baseline: rate(0.8) });
    expect(gate({ cells: [completedCell(), lowBaseline] }).outcome).toBe('pass');
  });

  it('001 FR-025 row 8: otherwise `pass`', () => {
    const result = gate();
    expect(result).toEqual({
      outcome: 'pass',
      reasons: [],
      blocking: [],
      undecided: [],
      excluded: [{ ruleId: 'self-state', cause: 'review' }],
    });
    expect(EXIT_CODES[gateExit(result.outcome)]).toBe(0);
  });

  it('001 FR-025 none of the premise failures, an undecided rule or an empty gate passes', () => {
    const notPassing: Partial<GateInput>[] = [
      { completion: { baseline: [], candidate: [] }, cells: [] },
      {
        runs: {
          baseline: {
            variant: 'current',
            status: 'partial',
            stopReason: 'interrupted',
            timeoutMs: 1,
          },
          candidate: { variant: 'next', status: 'complete', timeoutMs: 1 },
        },
      },
      {
        runs: {
          baseline: { variant: 'current', status: 'complete', timeoutMs: 1 },
          candidate: { variant: 'next', status: 'running', timeoutMs: 1 },
        },
      },
      { completion: { baseline: [full('ko', 10, 2)], candidate: [full('ko')] } },
      { cells: [completedCell()] },
      { gate: EMPTY_GATE },
    ];
    for (const overrides of notPassing) {
      expect(gate(overrides).outcome).not.toBe('pass');
    }
  });
});

describe('informational reasons', () => {
  const failures = (count: number, message: string | undefined, from = 0) =>
    Array.from({ length: count }, (_, index) => ({
      caseId: `case-${String(from + index).padStart(2, '0')}`,
      repeat: 0,
      message,
    }));
  const blockingTrials = (candidateFailures: CellTrials['candidateFailures']): CellTrials[] => [
    { ruleId: 'completed', lang: 'ko', surface: 'trial', candidateFailures },
  ];
  const blockingCompleted = regressed({ ruleId: 'completed', surface: 'trial' });

  it('001 FR-026 puts `dominant-error` first when 80% of blocking failures share a message', () => {
    const quota = `quota exceeded ${'x'.repeat(250)}`;
    const result = gate({
      cells: [blockingCompleted, cell()],
      cellTrials: blockingTrials([
        ...failures(8, quota),
        ...failures(1, 'other', 8),
        ...failures(1, undefined, 9),
      ]),
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons[0]).toEqual({
      code: 'dominant-error',
      params: { message: Array.from(quota).slice(0, 200).join(''), share: 0.8 },
    });
    expect(result.reasons.slice(1).map((reason) => reason.code)).toEqual(['regressed']);
  });

  it('001 FR-026 compares messages on their first 200 characters and counts each trial once', () => {
    const head = '한'.repeat(200);
    const trials: CellTrials[] = [
      ...blockingTrials([...failures(4, `${head}a`), ...failures(1, 'other', 4)]),
      {
        ruleId: 'no-emoji',
        lang: 'ko',
        surface: 'raw',
        candidateFailures: failures(4, `${head}b`),
      },
    ];
    const result = gate({ cells: [blockingCompleted, regressed()], cellTrials: trials });
    expect(result.reasons[0]).toEqual({
      code: 'dominant-error',
      params: { message: head, share: 0.8 },
    });
  });

  it('001 FR-026 gives no `dominant-error` below 80%', () => {
    const result = gate({
      cells: [blockingCompleted, cell()],
      cellTrials: blockingTrials([...failures(7, 'quota'), ...failures(3, undefined, 7)]),
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(['regressed']);
  });

  it('001 FR-026 `dominant-error` leaves the outcome unchanged', () => {
    const cells = [blockingCompleted, cell()];
    const withMessages = gate({ cells, cellTrials: blockingTrials(failures(5, 'quota')) });
    expect(withMessages.reasons[0]?.code).toBe('dominant-error');
    expect(withMessages.outcome).toBe(gate({ cells }).outcome);
  });

  it('001 FR-025 lists `abandoned-in-systematic` per gated `completed` cell without changing the outcome', () => {
    const cellTrials: CellTrials[] = [
      {
        ruleId: 'completed',
        lang: 'ko',
        surface: 'trial',
        candidateFailures: [],
        abandonedInSystematic: {
          baseline: { timeout: 0, restart: 0 },
          candidate: { timeout: 1, restart: 2 },
        },
      },
    ];
    const result = gate({ cellTrials });
    expect(result.outcome).toBe('pass');
    expect(result.reasons).toEqual([
      {
        code: 'abandoned-in-systematic',
        ruleId: 'completed',
        lang: 'ko',
        surface: 'trial',
        params: { trials: { next: { timeout: 1, restart: 2 } }, timeoutMs: { next: 90000 } },
      },
    ]);
  });

  it('001 FR-025 gives no `abandoned-in-systematic` without abandoned trials', () => {
    const cellTrials: CellTrials[] = [
      {
        ruleId: 'completed',
        lang: 'ko',
        surface: 'trial',
        candidateFailures: [],
        abandonedInSystematic: {
          baseline: { timeout: 0, restart: 0 },
          candidate: { timeout: 0, restart: 0 },
        },
      },
    ];
    expect(codes({ cellTrials })).toEqual([]);
  });
});
