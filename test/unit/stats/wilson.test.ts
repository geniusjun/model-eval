import { describe, expect, it } from 'vitest';

import { wilson } from '../../../src/stats/wilson.js';

import { near } from './cases.js';

const Z95 = 1.959963984540054;

describe('Wilson interval', () => {
  it('001 FR-021 keeps a non-zero width when every trial passed or failed', () => {
    // n / (n + z²) and z² / (n + z²) are the closed forms at x = n and x = 0.
    expect(wilson(10, 10, 1.96)).toEqual({
      low: near(10 / (10 + 1.96 ** 2), 13),
      high: 1,
    });
    expect(wilson(0, 10, 1.96)).toEqual({
      low: 0,
      high: near(1.96 ** 2 / (10 + 1.96 ** 2), 13),
    });
    expect(wilson(10, 10, 1.96).low).toBeCloseTo(0.7224598312333834, 13);
  });

  it('001 FR-021 matches the score interval for integer and design-effect-scaled counts', () => {
    // Expected values: an independent Python implementation of the score interval.
    expect(wilson(7, 20, Z95)).toEqual({
      low: near(0.1811918241010821, 13),
      high: near(0.5671457233147637, 13),
    });
    expect(wilson(12.5, 17.3, Z95)).toEqual({
      low: near(0.48701213526102005, 13),
      high: near(0.8772011418503457, 13),
    });
    expect(wilson(3, 4, 2.497705474412374)).toEqual({
      low: near(0.2269254959544758, 13),
      high: near(0.968414995786506, 13),
    });
  });

  it('001 FR-021 rejects counts outside 0 ≤ x ≤ n with n > 0', () => {
    expect(() => wilson(0, 0, Z95)).toThrow(RangeError);
    expect(() => wilson(-1, 5, Z95)).toThrow(RangeError);
    expect(() => wilson(6, 5, Z95)).toThrow(RangeError);
    expect(() => wilson(1, 5, 0)).toThrow(RangeError);
  });
});
