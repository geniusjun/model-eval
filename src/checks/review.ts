import type { Check } from '../config/schema.js';

export type ReviewCheck = Extract<Check, { type: 'review' }>;

/**
 * The repeats of one case whose texts a `review` rule shows side by side: the lowest `samples`
 * of the repeats given. `review` never grades (FR-020); the comparison collects these texts.
 */
export function reviewSampleRepeats(check: ReviewCheck, repeats: readonly number[]): number[] {
  return [...new Set(repeats)].sort((a, b) => a - b).slice(0, check.samples);
}
