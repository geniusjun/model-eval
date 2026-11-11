import { describe, expect, it } from 'vitest';

import {
  dollars,
  factor,
  marginPoints,
  NONE,
  seconds,
  tokenMean,
} from '../../../src/report/format.js';

// The number formats of contracts/cli.md §Human Output, shared with report.md.

describe('number formats', () => {
  it('001 FR-028 latency is in seconds with one decimal', () => {
    expect(seconds(1900)).toBe('1.9s');
    expect(seconds(2640)).toBe('2.6s');
    expect(seconds(100)).toBe('0.1s');
    expect(seconds(null)).toBe(NONE);
  });

  it('001 FR-028 a margin has no decimals when it is a whole number of points', () => {
    expect(marginPoints(0.1)).toBe('10pp');
    expect(marginPoints(0.05)).toBe('5pp');
    expect(marginPoints(0.025)).toBe('2.5pp');
  });

  it('001 FR-028 cost per trial is in dollars with three significant digits', () => {
    expect(dollars(0.00017)).toBe('$0.00017');
    expect(dollars(0.000383)).toBe('$0.000383');
    expect(dollars(0.25)).toBe('$0.25');
    expect(dollars(null)).toBe(NONE);
  });

  it('001 FR-028 failure ratios keep three significant digits', () => {
    expect(factor(45.03)).toBe('45');
    expect(factor(2.857)).toBe('2.86');
  });

  it('001 FR-023 token means keep at most one decimal', () => {
    expect(tokenMean(31 / 3)).toBe('10.3');
    expect(tokenMean(50)).toBe('50');
  });
});
