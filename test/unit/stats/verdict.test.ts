import { describe, expect, it } from 'vitest';

import type { PairedCase } from '../../../src/stats/interval.js';
import {
  cellNote,
  decideVerdict,
  isUndecided,
  judgeCell,
  nMin,
  type CellInput,
  type VerdictEvidence,
} from '../../../src/stats/verdict.js';

import { counts, pairedRepeats, times, Z_GATED4, Z_L } from './cases.js';

// Expected bounds come from an independent Python implementation of data-model §Statistics.

function cell(pairs: PairedCase[], overrides: Partial<CellInput> = {}): CellInput {
  const judged = (side: 'baseline' | 'candidate') =>
    pairs.reduce((sum, pair) => sum + pair[side].trials, 0);
  return {
    pairs,
    judgedTrials: { baseline: judged('baseline'), candidate: judged('candidate') },
    gated: false,
    margin: 0.1,
    minCases: 3,
    z: Z_GATED4,
    ...overrides,
  };
}

describe('n_min', () => {
  it('001 FR-022 is ⌈z_L²(1−m)/m⌉: 73, 35 and 22 for m = 0.05, 0.10 and 0.15', () => {
    for (const z of [Z_L, 1.96]) {
      expect(nMin(0.05, z)).toBe(73);
      expect(nMin(0.1, z)).toBe(35);
      expect(nMin(0.15, z)).toBe(22);
    }
  });
});

describe('verdict order', () => {
  it('001 FR-022 row 1: no judged trial in either run is not-applicable', () => {
    const result = judgeCell(cell([]));
    expect(result).toMatchObject({
      baseline: { cases: 0, trials: 0, rate: null },
      candidate: { cases: 0, trials: 0, rate: null },
      diff: null,
      deff: null,
      verdict: 'not-applicable',
    });
    expect(result.note).toBeUndefined();
  });

  it('001 FR-022 row 2: fewer than 3 common cases is insufficient, also when one run alone has judged trials', () => {
    const two = judgeCell(cell(pairedRepeats(5, [5, 5], [5, 4])));
    expect(two.verdict).toBe('insufficient');
    expect(two.note).toBeUndefined();
    const oneSided = judgeCell(cell([], { judgedTrials: { baseline: 10, candidate: 0 } }));
    expect(oneSided).toMatchObject({ verdict: 'insufficient', diff: null, deff: null });
  });

  it('001 FR-022 row 3 before row 4: a collapse is regressed below minCases', () => {
    const result = judgeCell(cell(pairedRepeats(5, [5, 5, 5], [1, 0, 1]), { minCases: 5 }));
    expect(result.verdict).toBe('regressed');
    // 3 cases: U takes t_{2, 0.975}; without it U would be −0.548.
    expect(result.diff?.high).toBeCloseTo(-0.2759140018082664, 12);
    expect(result.note).toBeUndefined();
  });

  it('001 FR-022 row 4: K below minCases is insufficient', () => {
    const result = judgeCell(cell(pairedRepeats(5, [5, 5, 5], [5, 4, 5]), { minCases: 5 }));
    expect(result.verdict).toBe('insufficient');
    expect(result.deff).toBeCloseTo(15 / 14, 12);
  });

  it('001 FR-022 row 5: L > 0 is improved', () => {
    const result = judgeCell(cell(pairedRepeats(5, times(30, 3), times(30, 5))));
    expect(result.verdict).toBe('improved');
    expect(result.diff?.low).toBeCloseTo(0.32099345681338265, 12);
  });

  it('001 FR-022 row 6: L > −m is non-inferior, with drop-within-margin when U < 0', () => {
    const held = judgeCell(cell(pairedRepeats(5, times(30, 5), [...times(29, 5), 4])));
    expect(held.verdict).toBe('non-inferior');
    expect(held.note).toBeUndefined();
    expect(held.diff?.low).toBeCloseTo(-0.03695954383297351, 12);

    const drop = judgeCell(
      cell(pairedRepeats(10, times(60, 10), [...times(30, 10), ...times(30, 9)])),
    );
    expect(drop).toMatchObject({ verdict: 'non-inferior', note: 'drop-within-margin' });
    expect(drop.diff?.high).toBeCloseTo(-0.03393222596200588, 12);
  });

  it('001 FR-022 row 7: min(ñ) below n_min is insufficient, with drop-too-few-samples when U < 0', () => {
    const few = judgeCell(cell(pairedRepeats(5, [5, 5, 5], [5, 5, 4])));
    expect(few.verdict).toBe('insufficient');
    expect(few.note).toBeUndefined();

    const drop = judgeCell(cell(pairedRepeats(5, times(6, 5), times(6, 4))));
    expect(drop).toMatchObject({ verdict: 'insufficient', note: 'drop-too-few-samples' });
    expect(drop.diff?.high).toBeCloseTo(-0.0454051489670976, 12);
  });

  it('001 FR-022 row 8: otherwise inconclusive, with drop-margin-undecided when U < 0', () => {
    const drop = judgeCell(
      cell(pairedRepeats(5, times(30, 5), [...times(15, 5), ...times(15, 4)])),
    );
    expect(drop).toMatchObject({ verdict: 'inconclusive', note: 'drop-margin-undecided' });
    expect(drop.diff?.high).toBeCloseTo(-0.05414612053711972, 12);

    const wide = judgeCell(cell(pairedRepeats(5, times(10, 5), [...times(7, 5), 0, 0, 5])));
    expect(wide.verdict).toBe('inconclusive');
    expect(wide.note).toBeUndefined();
    expect(wide.deff).toBeCloseTo(50 / 9, 12);
  });

  it('001 FR-022 uses the corrected z_U for gated cells only', () => {
    const pairs = pairedRepeats(10, times(60, 10), [...times(30, 10), ...times(30, 9)]);
    expect(judgeCell(cell(pairs)).diff?.high).toBeCloseTo(-0.03393222596200588, 12);
    expect(judgeCell(cell(pairs, { gated: true })).diff?.high).toBeCloseTo(
      -0.029302649535278967,
      12,
    );
    expect(judgeCell(cell(pairs, { gated: true })).diff?.low).toBeCloseTo(-0.07048026312773603, 12);
  });

  it('001 FR-022 orders the rows as data-model §Statistics lists them', () => {
    const settings = { margin: 0.1, minCases: 5, zLower: Z_L };
    const evidence = (cases: number, low: number, high: number, nEff: number): VerdictEvidence => ({
      judgedTrials: { baseline: 10, candidate: 10 },
      cases,
      diff: { low, high },
      minEffectiveTrials: nEff,
    });
    expect(decideVerdict(evidence(3, -0.5, -0.2, 15), settings)).toBe('regressed');
    expect(decideVerdict(evidence(4, 0.05, 0.3, 200), settings)).toBe('insufficient');
    expect(decideVerdict(evidence(5, 0.01, 0.3, 25), settings)).toBe('improved');
    expect(decideVerdict(evidence(5, -0.05, 0.1, 25), settings)).toBe('non-inferior');
    expect(decideVerdict(evidence(5, -0.15, 0.1, 34), settings)).toBe('insufficient');
    expect(decideVerdict(evidence(5, -0.15, 0.1, 35), settings)).toBe('inconclusive');
    expect(decideVerdict(evidence(2, -0.9, -0.8, 10), settings)).toBe('insufficient');
  });
});

describe('100% compliance on both sides', () => {
  it.each([
    [0.05, 72, 1, 'insufficient'],
    [0.05, 73, 1, 'non-inferior'],
    [0.1, 6, 5, 'insufficient'],
    [0.1, 7, 5, 'non-inferior'],
    [0.1, 34, 1, 'insufficient'],
    [0.1, 35, 1, 'non-inferior'],
    [0.15, 21, 1, 'insufficient'],
    [0.15, 22, 1, 'non-inferior'],
  ] as const)(
    '001 FR-022 at margin %s with %i cases × %i repeats is %s',
    (margin, cases, repeats, expected) => {
      const result = judgeCell(
        cell(pairedRepeats(repeats, times(cases, repeats), times(cases, repeats)), { margin }),
      );
      const trials = cases * repeats;
      expect(result.verdict).toBe(expected);
      expect(result.diff?.low).toBeCloseTo(-(Z_L ** 2) / (trials + Z_L ** 2), 13);
      expect(result.note).toBeUndefined();
    },
  );
});

describe('verdicts with few cases', () => {
  it('001 SC-003 FR-022 does not block a 3-case drop that U with z_U alone would call regressed', () => {
    // U with z_U is −0.305; with t_{2, 1−α/4} it is 0.324, so row 3 does not apply.
    const result = judgeCell(cell(pairedRepeats(5, [5, 5, 5], [0, 2, 1]), { gated: true }));
    expect(result.diff?.high).toBeCloseTo(0.3238841589851098, 12);
    expect(result.verdict).toBe('insufficient');
  });
});

describe('cell notes', () => {
  it('001 FR-022 marks a clear drop on fewer than 3 cases from U without the design effect', () => {
    expect(judgeCell(cell(pairedRepeats(5, [5, 5], [0, 0]))).note).toBe('clear-drop-too-few-cases');
    // deff 30/7 widens U to 0.102; without it U is −0.289, below −m.
    const clustered = judgeCell(
      cell([
        { baseline: counts(5, 5), candidate: counts(5, 0) },
        { baseline: counts(5, 5), candidate: counts(5, 3) },
      ]),
    );
    expect(clustered.deff).toBeCloseTo(30 / 7, 12);
    expect(clustered.diff?.high).toBeGreaterThan(0);
    expect(clustered).toMatchObject({ verdict: 'insufficient', note: 'clear-drop-too-few-cases' });
  });

  it('001 FR-022 gives no other note with K < 3 and none to regressed or improved cells', () => {
    expect(
      cellNote('insufficient', { cases: 2, high: -0.05, highWithoutDesignEffect: -0.05 }, 0.1),
    ).toBeUndefined();
    expect(
      cellNote('regressed', { cases: 30, high: -0.2, highWithoutDesignEffect: -0.3 }, 0.1),
    ).toBeUndefined();
    expect(
      cellNote('insufficient', { cases: 3, high: -0.01, highWithoutDesignEffect: -0.02 }, 0.1),
    ).toBe('drop-too-few-samples');
    expect(
      cellNote('not-applicable', { cases: 0, high: null, highWithoutDesignEffect: null }, 0.1),
    ).toBeUndefined();
  });
});

describe('undecided verdicts', () => {
  it('001 FR-022 counts inconclusive and insufficient as undecided, never as passing', () => {
    expect(isUndecided('inconclusive')).toBe(true);
    expect(isUndecided('insufficient')).toBe(true);
    for (const verdict of ['improved', 'non-inferior', 'regressed', 'not-applicable'] as const) {
      expect(isUndecided(verdict)).toBe(false);
    }
  });
});
