import { describe, expect, it } from 'vitest';

import { reviewSampleRepeats } from '../../../src/checks/review.js';
import { checkSchema } from '../../../src/config/schema.js';

function reviewCheck(fields: Record<string, unknown> = {}) {
  const check = checkSchema.parse({ type: 'review', ...fields });
  if (check.type !== 'review') {
    throw new Error(`parsed a ${check.type} check, expected review`);
  }
  return check;
}

describe('review check', () => {
  it('001 FR-020 takes the lowest repeats of a case, 3 by default', () => {
    expect(reviewSampleRepeats(reviewCheck(), [4, 0, 2, 1, 3])).toEqual([0, 1, 2]);
  });

  it('001 FR-020 takes samples repeats when set, and every repeat when there are fewer', () => {
    expect(reviewSampleRepeats(reviewCheck({ samples: 1 }), [3, 1])).toEqual([1]);
    expect(reviewSampleRepeats(reviewCheck({ samples: 5 }), [2, 0, 2])).toEqual([0, 2]);
    expect(reviewSampleRepeats(reviewCheck(), [])).toEqual([]);
  });
});
