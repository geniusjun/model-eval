import type { CaseValues } from '../config/paths.js';
import { textsFrom } from './references.js';
import { fail, PASS, type CheckOfType, type CheckResult } from './result.js';

/**
 * Fails when the text shares a run of at least `minChars` code points with one of the given
 * texts, both sides NFKC-normalised with all whitespace removed. Each given text is compared on
 * its own, so a run never spans two of them.
 */
export function checkOverlap(
  check: CheckOfType<'overlap'>,
  text: string,
  values: CaseValues,
): CheckResult {
  const fromCase = textsFrom(check.withFrom, values, 'empty');
  if (!fromCase.ok) {
    return fromCase.error;
  }
  const answer = squash(text);
  const runs = [...(check.with ?? []), ...fromCase.values]
    .map((given) => longestCommonRun(answer, squash(given)))
    .filter((run) => run.length >= check.minChars)
    .map((run) => run.join(''));
  return runs.length === 0 ? PASS : fail(runs);
}

function squash(text: string): string[] {
  return Array.from(text.normalize('NFKC').replace(/\p{White_Space}/gu, ''));
}

/** The longest common substring in code points; on a tie, the one that ends first in `a`. */
function longestCommonRun(a: readonly string[], b: readonly string[]): readonly string[] {
  // previous[j] and current[j] hold the length of the common run ending at a[i - 1] and b[j - 1].
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  let bestLength = 0;
  let bestEnd = 0;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const length = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : 0;
      current[j] = length;
      if (length > bestLength) {
        bestLength = length;
        bestEnd = i;
      }
    }
    [previous, current] = [current, previous];
  }
  return a.slice(bestEnd - bestLength, bestEnd);
}
