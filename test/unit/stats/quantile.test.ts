import { describe, expect, it } from 'vitest';

import { normalQuantile } from '../../../src/stats/quantile.js';

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
