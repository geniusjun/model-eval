import { describe, expect, it } from 'vitest';

import type { PairedCase } from '../../../src/stats/interval.js';
import { trialsNeeded, type NeededInput } from '../../../src/stats/needed.js';

import { counts, pairedRepeats, times, Z_L, Z_U4 } from './cases.js';

// Expected values come from an independent Python implementation of data-model §Statistics,
// Trials needed. The cells are gated, so z_U is the corrected z_{1−α/G} with G = 4.

function input(pairs: PairedCase[], overrides: Partial<NeededInput> = {}): NeededInput {
  return {
    pairs,
    margin: 0.1,
    minCases: 3,
    z: { zLower: Z_L, zUpper: Z_U4 },
    runCases: 40,
    ...overrides,
  };
}

describe('trials needed', () => {
  it('001 FR-024 asks for repeats with z_L when the estimate is above −m', () => {
    // W/c = 19.7, ⌈n_min/K⌉ = 2, ⌊r̄⌋ + 1 = 6
    const pairs = pairedRepeats(5, times(30, 5), [...times(20, 5), ...times(10, 4)]);
    expect(trialsNeeded(input(pairs))).toEqual({
      kind: 'repeats',
      repeats: 20,
      cellTrials: 600,
      trialsPerVariant: 800,
      nearMargin: false,
    });
  });

  it('001 FR-024 uses z_U when the estimate is at or below −m', () => {
    const pairs = pairedRepeats(5, times(30, 5), [...times(10, 5), ...times(20, 4)]);
    expect(trialsNeeded(input(pairs))).toEqual({
      kind: 'repeats',
      repeats: 49,
      cellTrials: 1470,
      trialsPerVariant: 1960,
      nearMargin: false,
    });
  });

  it('001 FR-024 asks for at least one repeat more than now, with r̄ exact for equal repeats', () => {
    // Both variants pass every trial: W/c rounds up to 1 and ⌈35/30⌉ = 2, so ⌊r̄⌋ + 1 = 6 decides.
    const pairs = pairedRepeats(5, times(30, 5), times(30, 5));
    expect(trialsNeeded(input(pairs, { runCases: 30 }))).toEqual({
      kind: 'repeats',
      repeats: 6,
      cellTrials: 180,
      trialsPerVariant: 180,
      nearMargin: false,
    });
  });

  it('001 FR-024 flags nearMargin when r′ exceeds 10·r̄, with r̄ the harmonic mean of candidate trials', () => {
    // r̄ = 6 / (1/5 + 1/3 + 1/5 + 1/4 + 1/2 + 1/5) = 3.56; r′ = 60 > 35.6
    const pairs: PairedCase[] = [
      { baseline: counts(5, 5), candidate: counts(5, 4) },
      { baseline: counts(4, 4), candidate: counts(3, 3) },
      { baseline: counts(5, 5), candidate: counts(5, 5) },
      { baseline: counts(5, 4), candidate: counts(4, 4) },
      { baseline: counts(5, 5), candidate: counts(2, 2) },
      { baseline: counts(5, 5), candidate: counts(5, 4) },
    ];
    expect(trialsNeeded(input(pairs, { runCases: 10 }))).toEqual({
      kind: 'repeats',
      repeats: 60,
      cellTrials: 360,
      trialsPerVariant: 600,
      nearMargin: true,
    });
  });

  it('001 FR-024 asks for cases when the between-case variance leaves c ≤ 0', () => {
    const pairs = pairedRepeats(5, times(30, 5), [...times(28, 5), 0, 0]);
    expect(trialsNeeded(input(pairs))).toEqual({ kind: 'cases', cases: 455 });
  });

  it('001 FR-024 reports on-margin when the estimate is exactly −m', () => {
    // Δ̂ = 0.9 − 1 is −0.09999999999999998 in floating point.
    const pairs = pairedRepeats(5, times(30, 5), [...times(15, 5), ...times(15, 4)]);
    expect(trialsNeeded(input(pairs))).toEqual({ kind: 'on-margin' });
  });

  it('001 FR-024 asks for max(3, minCases) cases first when K is below it', () => {
    expect(trialsNeeded(input([]))).toEqual({ kind: 'cases', cases: 3 });
    expect(trialsNeeded(input(pairedRepeats(5, [5], [2])))).toEqual({ kind: 'cases', cases: 3 });
    expect(trialsNeeded(input(pairedRepeats(5, [5, 5], [5, 4])))).toEqual({
      kind: 'cases',
      cases: 3,
    });
    expect(
      trialsNeeded(input(pairedRepeats(5, [5, 5, 5, 5], [5, 4, 4, 5]), { minCases: 5 })),
    ).toEqual({ kind: 'cases', cases: 5 });
  });

  it('001 FR-024 asks for the larger case count when the cases formula gives more', () => {
    expect(trialsNeeded(input(pairedRepeats(5, [5, 5], [5, 3])))).toEqual({
      kind: 'cases',
      cases: 90,
    });
    expect(trialsNeeded(input(pairedRepeats(5, [5, 5, 5], [5, 4, 5]), { minCases: 5 }))).toEqual({
      kind: 'cases',
      cases: 315,
    });
    expect(trialsNeeded(input(pairedRepeats(5, [5, 5, 5], [5, 5, 5]), { minCases: 5 }))).toEqual({
      kind: 'cases',
      cases: 29,
    });
  });
});
