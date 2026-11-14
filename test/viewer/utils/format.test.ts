import { describe, expect, it } from 'vitest';

import { binCounts } from '../../../viewer/src/utils/format.js';

const BINS = 20;

/** `BINS` counts, all 0 except the ones given by bin index. */
function counts(filled: Readonly<Record<number, number>>): number[] {
  return Array.from({ length: BINS }, (_, bin) => filled[bin] ?? 0);
}

describe('002 binCounts', () => {
  it('002 FR-006 splits min to max into 20 equal-width bins', () => {
    expect(binCounts([1000, 1049, 1050, 1500, 2000], 1000, 2000, BINS)).toEqual(
      counts({ 0: 2, 1: 1, 10: 1, 19: 1 }),
    );
  });

  it('002 FR-006 splits 0 to max into 20 equal-width bins when the fastest is 0', () => {
    expect(binCounts([0, 99, 100, 1050, 1999], 0, 2000, BINS)).toEqual(
      counts({ 0: 2, 1: 1, 10: 1, 19: 1 }),
    );
  });

  it('002 FR-006 puts a value equal to max in the last bin', () => {
    expect(binCounts([2000, 2000], 0, 2000, BINS)).toEqual(counts({ 19: 2 }));
  });

  it('002 FR-006 puts every value in the first bin when max is not above min', () => {
    expect(binCounts([0, 0, 0], 0, 0, BINS)).toEqual(counts({ 0: 3 }));
  });

  it('002 FR-006 counts nothing for no values', () => {
    expect(binCounts([], 0, 2000, BINS)).toEqual(counts({}));
    expect(binCounts([], 0, 0, BINS)).toEqual(counts({}));
  });
});
