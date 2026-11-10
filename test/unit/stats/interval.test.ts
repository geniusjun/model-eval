import { describe, expect, it } from 'vitest';

import {
  caseWeightedRate,
  cellZValues,
  designEffect,
  differenceInterval,
  effectiveTrials,
  newcombeInterval,
  variantRate,
  zValues,
  type PairedCase,
} from '../../../src/stats/interval.js';

import { counts, near, paired, repeated, times, Z_L, Z_U4 } from './cases.js';

// Expected values that are not closed forms come from an independent Python implementation
// of data-model §Statistics (exact fractions for the estimators, scipy for the quantiles).

const uneven = {
  baseline: [counts(5, 5), counts(5, 4), counts(3, 3), counts(4, 2), counts(5, 5)],
  candidate: [counts(5, 3), counts(2, 2), counts(5, 5), counts(5, 1), counts(4, 4)],
};

const clustered = {
  baseline: repeated(5, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),
  candidate: repeated(5, [5, 5, 5, 5, 5, 5, 5, 0, 0, 5]),
};

describe('confidence levels', () => {
  it('001 FR-021 uses z_L = z_{1−α} and z_U = z_{1−α/G} with α = (1 − confidence)/2', () => {
    expect(zValues(0.95, 4)).toEqual({
      zLower: near(Z_L, 13),
      zUpper: near(Z_U4, 13),
    });
    expect(zValues(0.9, 5)).toEqual({
      zLower: near(1.644853626951472, 13),
      zUpper: near(2.3263478740408408, 13),
    });
    expect(zValues(0.99, 1)).toEqual({
      zLower: near(2.5758293035489004, 13),
      zUpper: near(2.5758293035489004, 13),
    });
  });

  it('001 FR-021 keeps z finite for a confidence just below 1, where 1 − α rounds to 1', () => {
    // α = 5.551115123125783e-17; scipy gives z_{1−α} and z_{1−α/3}.
    expect(zValues(0.9999999999999999, 3)).toEqual({
      zLower: near(8.292361075813595, 10),
      zUpper: near(8.422011622583538, 10),
    });
  });

  it('001 FR-021 leaves z_U uncorrected without gated cells and for ungated cells', () => {
    const none = zValues(0.95, 0);
    expect(none.zUpper).toBe(none.zLower);
    const gated = zValues(0.95, 4);
    expect(cellZValues(gated, true)).toEqual(gated);
    expect(cellZValues(gated, false)).toEqual({ zLower: gated.zLower, zUpper: gated.zLower });
  });
});

describe('case-weighted rates and ñ', () => {
  it('001 FR-021 weights every case equally, not every trial', () => {
    // (1 + 4/5 + 1 + 2/4 + 1) / 5 = 0.86, while the pooled rate is 19/22.
    expect(caseWeightedRate(uneven.baseline)).toBeCloseTo(0.86, 14);
    expect(caseWeightedRate(uneven.candidate)).toBeCloseTo(0.76, 14);
  });

  it('001 FR-021 computes ñ = K² / Σ(1/n_i), exactly K·r for equal repeats', () => {
    // 25 / (1/5 + 1/5 + 1/3 + 1/4 + 1/5) = 25 / (71/60)
    expect(effectiveTrials(uneven.baseline)).toBeCloseTo(1500 / 71, 12);
    for (const [cases, repeats] of [
      [3, 5],
      [20, 5],
      [30, 5],
      [30, 10],
      [7, 5],
    ] as const) {
      expect(effectiveTrials(repeated(repeats, times(cases, 0)))).toBe(cases * repeats);
    }
  });

  it('001 FR-021 computes ñ when the common multiple of the trial counts is not a safe integer', () => {
    // The first 140 primes, 2 to 809, as trial counts; exact fractions give K² / Σ(1/n_i).
    const primes: number[] = [];
    for (let n = 2; primes.length < 140; n += 1) {
      if (primes.every((p) => n % p !== 0)) {
        primes.push(n);
      }
    }
    expect(primes.at(-1)).toBe(809);
    expect(effectiveTrials(primes.map((trials) => counts(trials, 0)))).toBeCloseTo(
      9045.211531891291,
      8,
    );
  });

  it('001 FR-021 gives each variant a Wilson interval widened by its own design effect', () => {
    expect(variantRate(uneven.baseline, Z_L)).toEqual({
      cases: 5,
      trials: 22,
      passes: 19,
      rate: near(0.86, 14),
      pooledRate: 19 / 22,
      low: near(0.5875557606517683, 12),
      high: near(0.9636211199114939, 12),
      nEff: near(1500 / 71, 12),
    });
    expect(variantRate(uneven.candidate, Z_L)).toEqual({
      cases: 5,
      trials: 21,
      passes: 15,
      rate: near(0.76, 14),
      pooledRate: 15 / 21,
      low: near(0.4002459265056999, 12),
      high: near(0.9376024218607322, 12),
      nEff: near(18.51851851851852, 12),
    });
    // deff_c = (s²(y)/K) / (p̂(1 − p̂)/ñ) = (0.16·10/9/10) / (0.16/50) = 50/9
    expect(variantRate(clustered.candidate, Z_L)).toMatchObject({
      rate: near(0.8, 14),
      low: near(0.4737885042450054, 12),
      high: near(0.9467244667032684, 12),
      nEff: 50,
    });
  });

  it('001 FR-022 keeps a non-zero width when every trial passed or failed', () => {
    expect(variantRate(repeated(5, times(30, 5)), Z_L)).toMatchObject({
      rate: 1,
      low: near(150 / (150 + Z_L ** 2), 13),
      high: 1,
      nEff: 150,
    });
    expect(variantRate(repeated(5, [0, 0, 0, 0]), Z_L)).toMatchObject({
      rate: 0,
      low: 0,
      high: near(Z_L ** 2 / (20 + Z_L ** 2), 13),
    });
  });

  it('001 FR-021 has null statistics without a judged trial', () => {
    expect(variantRate([], Z_L)).toEqual({
      cases: 0,
      trials: 0,
      passes: 0,
      rate: null,
      pooledRate: null,
      low: null,
      high: null,
      nEff: null,
    });
  });

  it('001 FR-021 rejects case counts that are not judged trials', () => {
    expect(() => caseWeightedRate([])).toThrow(RangeError);
    expect(() => effectiveTrials([counts(0, 0)])).toThrow(RangeError);
    expect(() => variantRate([counts(3, 4)], Z_L)).toThrow(RangeError);
    expect(() => variantRate([counts(2.5, 1)], Z_L)).toThrow(RangeError);
  });
});

describe('design effect and difference interval', () => {
  it('001 FR-021 computes deff = max(1, V_cl / V_bin) from the paired case differences', () => {
    // V_cl = (8·0.2² + 2·0.8²) / (10·9) = 1.6/90, V_bin = 0.8·0.2/50 + 0
    expect(designEffect(paired(clustered.baseline, clustered.candidate))).toBeCloseTo(50 / 9, 12);
    expect(designEffect(paired(uneven.baseline, uneven.candidate))).toBe(1);
  });

  it('001 FR-021 sets deff to 1 when V_bin is 0 or V_cl has no degree of freedom', () => {
    const allPass = repeated(5, [5, 5, 5]);
    expect(designEffect(paired(allPass, allPass))).toBe(1);
    expect(designEffect(paired([counts(4, 3)], [counts(4, 1)]))).toBe(1);
  });

  it('001 FR-021 builds L with z_L and U with z_U from the Wilson bounds of ñ/deff', () => {
    const pairs = paired(uneven.baseline, uneven.candidate);
    expect(differenceInterval(pairs, { zLower: Z_L, zUpper: Z_L })).toEqual({
      diff: {
        estimate: near(-0.1, 14),
        low: near(-0.3449881071315345, 12),
        high: near(0.14485461189817314, 12),
      },
      deff: 1,
    });
    expect(differenceInterval(pairs, { zLower: Z_L, zUpper: Z_U4 })?.diff).toEqual({
      estimate: near(-0.1, 14),
      low: near(-0.3449881071315345, 12),
      high: near(0.21054684175077132, 12),
    });
  });

  it('001 FR-021 widens the interval by the design effect', () => {
    const pairs = paired(clustered.baseline, clustered.candidate);
    expect(differenceInterval(pairs, { zLower: Z_L, zUpper: Z_L })).toEqual({
      diff: {
        estimate: near(-0.2, 14),
        low: near(-0.5262114957549946, 12),
        high: near(0.1331903796979888, 12),
      },
      deff: near(50 / 9, 12),
    });
    expect(differenceInterval(pairs, { zLower: Z_L, zUpper: Z_U4 })?.diff.high).toBeCloseTo(
      0.2399344439445768,
      12,
    );
  });

  it('001 FR-021 uses the harmonic ñ when trial counts differ per case', () => {
    const pairs: PairedCase[] = [
      { baseline: counts(5, 5), candidate: counts(5, 4) },
      { baseline: counts(4, 4), candidate: counts(3, 3) },
      { baseline: counts(5, 5), candidate: counts(5, 5) },
      { baseline: counts(5, 4), candidate: counts(4, 4) },
      { baseline: counts(5, 5), candidate: counts(2, 2) },
      { baseline: counts(5, 5), candidate: counts(5, 4) },
    ];
    expect(
      variantRate(
        pairs.map((pair) => pair.candidate),
        Z_L,
      ).nEff,
    ).toBeCloseTo(21.386138613861387, 12);
    expect(differenceInterval(pairs, { zLower: Z_L, zUpper: Z_U4 })).toEqual({
      diff: {
        estimate: near(-1 / 30, 14),
        low: near(-0.2189752948727874, 12),
        high: near(0.17000892712571014, 12),
      },
      deff: 1,
    });
  });

  it('001 FR-021 gives L = −z²/(ñ+z²) when both variants pass every trial', () => {
    const allPass = repeated(5, times(7, 5));
    const result = differenceInterval(paired(allPass, allPass), { zLower: Z_L, zUpper: Z_U4 });
    expect(result?.diff.estimate).toBe(0);
    expect(result?.diff.low).toBeCloseTo(-(Z_L ** 2) / (35 + Z_L ** 2), 13);
    expect(result?.diff.high).toBeCloseTo(Z_U4 ** 2 / (35 + Z_U4 ** 2), 13);
  });

  it('001 FR-021 can compute the bounds without the design effect', () => {
    const pairs: PairedCase[] = [
      { baseline: counts(5, 5), candidate: counts(5, 0) },
      { baseline: counts(5, 5), candidate: counts(5, 3) },
    ];
    expect(designEffect(pairs)).toBeCloseTo(4.285714285714286, 12);
    expect(newcombeInterval(pairs, { zLower: Z_L, zUpper: Z_L }, 1)).toEqual({
      estimate: near(-0.7, 14),
      low: near(-0.8922087325936989, 12),
      high: near(-0.28894289100317283, 12),
    });
  });

  it('001 FR-021 has no difference without a common case', () => {
    expect(differenceInterval([], { zLower: Z_L, zUpper: Z_L })).toBeNull();
  });
});
