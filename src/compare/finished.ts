import { compareCodeUnits } from '../adapter/canonical-json.js';
import { indexTrialLines } from '../run/cost.js';
import type { AttemptLine, TrialLine } from '../run/records.js';
import { trialState } from '../run/retry.js';

/**
 * The effective line of every finished trial key of the given cases, sorted by case and repeat
 * (data-model §Stopping). `retries` is the run's recorded `run.retries`.
 */
export function finishedTrials(
  lines: readonly TrialLine[],
  retries: number,
  caseIds: ReadonlySet<string>,
): AttemptLine[] {
  return [...indexTrialLines(lines).keys.values()]
    .filter((key) => caseIds.has(key.key.caseId))
    .flatMap((key) => {
      const state = trialState(key.attempts, retries);
      return state.kind === 'finished' ? [state.effective] : [];
    })
    .sort((a, b) => compareCodeUnits(a.caseId, b.caseId) || a.repeat - b.repeat);
}
