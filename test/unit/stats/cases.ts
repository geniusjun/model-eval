import { expect } from 'vitest';

import type { CaseCounts, PairedCase, ZValues } from '../../../src/stats/interval.js';

export const Z_L = 1.959963984540054;
/** z_{1−0.025/4}: four gated cells at 95% confidence. */
export const Z_U4 = 2.497705474412374;
/** α = (1 − 0.95)/2 */
export const ALPHA = 0.025;

/** An ungated cell at 95% confidence: z_U = z_L and α_U = α. */
export const Z_UNGATED: ZValues = {
  zLower: Z_L,
  zUpper: Z_L,
  alphaLower: ALPHA,
  alphaUpper: ALPHA,
};

/** A comparison with four gated cells: z_U = z_{1−α/4} and α_U = α/4. */
export const Z_GATED4: ZValues = {
  zLower: Z_L,
  zUpper: Z_U4,
  alphaLower: ALPHA,
  alphaUpper: ALPHA / 4,
};

export const counts = (trials: number, passes: number): CaseCounts => ({ trials, passes });

export const repeated = (repeats: number, passes: readonly number[]): CaseCounts[] =>
  passes.map((x) => counts(repeats, x));

export function paired(
  baseline: readonly CaseCounts[],
  candidate: readonly CaseCounts[],
): PairedCase[] {
  return baseline.map((b, i) => {
    const c = candidate[i];
    if (c === undefined) {
      throw new Error('both variants need the same cases');
    }
    return { baseline: b, candidate: c };
  });
}

/** Cases with equal repeats on both sides, given as passes per case. */
export const pairedRepeats = (
  repeats: number,
  baselinePasses: readonly number[],
  candidatePasses: readonly number[],
): PairedCase[] => paired(repeated(repeats, baselinePasses), repeated(repeats, candidatePasses));

export const times = (count: number, passes: number): number[] =>
  new Array<number>(count).fill(passes);

/** An asymmetric matcher for a number equal to `value` to `digits` decimal places. */
export const near = (value: number, digits: number): unknown => expect.closeTo(value, digits);
