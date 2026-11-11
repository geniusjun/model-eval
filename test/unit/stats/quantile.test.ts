import { describe, expect, it } from 'vitest';

import { normalQuantile, studentTQuantile } from '../../../src/stats/quantile.js';

// Expected values: scipy.stats.norm.ppf.
describe('normal quantile', () => {
  it('001 FR-021 gives z_L for 95% confidence and the Bonferroni z_U values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 13);
    expect(normalQuantile(1 - 0.025 / 2)).toBeCloseTo(2.241402727604947, 13);
    expect(normalQuantile(1 - 0.025 / 3)).toBeCloseTo(2.3939797998185104, 13);
    expect(normalQuantile(1 - 0.025 / 4)).toBeCloseTo(2.497705474412374, 13);
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293035489004, 13);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644853626951472, 13);
  });

  it('001 FR-021 covers the centre, both tails and the far tail', () => {
    expect(normalQuantile(0.5)).toBe(0);
    expect(normalQuantile(0.3)).toBeCloseTo(-0.5244005127080409, 13);
    expect(normalQuantile(0.02425)).toBeCloseTo(-1.972961051311885, 13);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 11);
    expect(normalQuantile(0.025)).toBeCloseTo(-normalQuantile(0.975), 13);
  });

  it('001 FR-021 rejects probabilities outside (0, 1)', () => {
    for (const p of [0, 1, -0.1, 1.5, Number.NaN]) {
      expect(() => normalQuantile(p)).toThrow(RangeError);
    }
  });
});

// Expected values: scipy.stats.t.ppf.
describe('Student t quantile', () => {
  it('001 SC-003 FR-021 gives the t quantiles of the few-cases upper bound', () => {
    expect(studentTQuantile(2, 0.995)).toBeCloseTo(9.924843200918287, 11);
    expect(studentTQuantile(4, 0.995)).toBeCloseTo(4.604094871349992, 11);
    expect(studentTQuantile(8, 0.995)).toBeCloseTo(3.355387331333395, 11);
    expect(studentTQuantile(2, 0.975)).toBeCloseTo(4.302652729749462, 11);
    expect(studentTQuantile(29, 0.975)).toBeCloseTo(2.045229642132704, 11);
  });

  it('001 SC-003 FR-021 matches the closed forms for 1 and 2 degrees of freedom', () => {
    for (const p of [0.6, 0.9, 0.975, 0.999]) {
      expect(studentTQuantile(1, p)).toBeCloseTo(Math.tan(Math.PI * (p - 0.5)), 10);
      expect(studentTQuantile(2, p)).toBeCloseTo((2 * p - 1) / Math.sqrt(2 * p * (1 - p)), 11);
    }
  });

  it('001 SC-003 FR-021 is symmetric, 0 at the median and tends to z for many degrees of freedom', () => {
    expect(studentTQuantile(3, 0.5)).toBe(0);
    expect(studentTQuantile(3, 0.6)).toBeCloseTo(0.2766706623326898, 12);
    expect(studentTQuantile(5, 0.025)).toBeCloseTo(-2.5705818356363155, 12);
    expect(studentTQuantile(1000, 0.975)).toBeCloseTo(1.9623390808264078, 11);
    expect(studentTQuantile(10000, 0.975)).toBeCloseTo(1.960201239890626, 11);
    expect(studentTQuantile(10000, 0.975) - normalQuantile(0.975)).toBeLessThan(3e-4);
  });

  it('001 SC-003 FR-021 keeps a tail probability that 1 − p cannot hold', () => {
    // 1 − 1e-20 rounds to 1, so the upper bound asks for the lower tail and negates it.
    expect(-studentTQuantile(2, 1e-20)).toBeCloseTo(7.071067811865475e9, 0);
  });

  it('001 SC-003 FR-021 rejects degrees of freedom that are not positive integers and p outside (0, 1)', () => {
    for (const df of [0, -1, 2.5, Number.NaN]) {
      expect(() => studentTQuantile(df, 0.9)).toThrow(RangeError);
    }
    for (const p of [0, 1, -0.1, Number.NaN]) {
      expect(() => studentTQuantile(3, p)).toThrow(RangeError);
    }
  });
});
