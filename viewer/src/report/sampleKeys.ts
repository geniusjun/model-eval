import type { Samples } from '../../../src/report/schema.js';

export type SampleKey = Samples['review'][number]['keys'][number];

/**
 * The sample keys of a rule that the side-by-side view steps through: its `review` samples and
 * the failing examples of all its cells. Both the location hash and the side-by-side cursor read
 * positions from these keys, so a hash names a position exactly when the view can show it.
 */
export function ruleSampleKeys(samples: Samples, ruleId: string): SampleKey[] {
  return [
    ...samples.review.filter((entry) => entry.ruleId === ruleId).flatMap((entry) => entry.keys),
    ...samples.failing.filter((entry) => entry.ruleId === ruleId).flatMap((entry) => entry.keys),
  ];
}
