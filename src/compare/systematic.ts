import { classifyTrial, completedGrade, mayBeSystematic } from '../grade/outcome.js';
import type { AttemptLine } from '../run/records.js';
import type { PerRole } from '../stats/interval.js';
import { byCase } from './finished.js';

// data-model §Systematic Failures: it needs both runs, so grade sets cannot apply it.

const isCompletedGraded = (line: AttemptLine): boolean =>
  completedGrade(classifyTrial(line)) !== 'skip';

function failuresOf(
  own: ReadonlyMap<string, readonly AttemptLine[]>,
  other: ReadonlyMap<string, readonly AttemptLine[]>,
): AttemptLine[] {
  return [...own].flatMap(([caseId, lines]) =>
    lines.length >= 2 &&
    lines.every((line) => mayBeSystematic(classifyTrial(line))) &&
    (other.get(caseId) ?? []).some(isCompletedGraded)
      ? lines
      : [],
  );
}

/**
 * Trials that fail `completed` because one variant has at least two finished trials of a case,
 * all `transient` or `adapter`, while the other variant has a `completed`-graded trial of it.
 * `finished` holds each run's finished effective lines on common cases. The `completed` column
 * of the outcome table decides "graded", so the completion rate can use this without a
 * `completed` rule.
 */
export function systematicFailures(
  finished: PerRole<readonly AttemptLine[]>,
): PerRole<AttemptLine[]> {
  const baseline = byCase(finished.baseline);
  const candidate = byCase(finished.candidate);
  return {
    baseline: failuresOf(baseline, candidate),
    candidate: failuresOf(candidate, baseline),
  };
}
