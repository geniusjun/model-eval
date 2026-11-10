import type { CaseValues } from '../config/paths.js';
import { textsFrom } from './references.js';
import { checkError, fail, PASS, type CheckOfType, type CheckResult } from './result.js';

/**
 * `forbid` fails when a listed phrase appears, `require` when none does. With `normalize`, both
 * sides are NFKC-normalised and lower-cased before the substring match. Empty strings in the
 * `anyFrom` value are dropped, and a value with none left cannot be graded.
 */
export function checkPhrases(
  check: CheckOfType<'phrases'>,
  text: string,
  values: CaseValues,
): CheckResult {
  const fromCase = textsFrom(check.anyFrom, values, 'unresolved');
  if (!fromCase.ok) {
    return fromCase.error;
  }
  const fromPhrases = fromCase.values.filter((phrase) => phrase !== '');
  if (check.anyFrom !== undefined && fromPhrases.length === 0) {
    return checkError({ code: 'unresolved-ref', path: check.anyFrom });
  }
  const comparable = check.normalize ? normalizePhrase : (value: string) => value;
  const haystack = comparable(text);
  const found = [...(check.any ?? []), ...fromPhrases].filter((phrase) =>
    haystack.includes(comparable(phrase)),
  );
  if (check.mode === 'forbid') {
    return found.length === 0 ? PASS : fail(found);
  }
  return found.length === 0 ? fail([]) : PASS;
}

function normalizePhrase(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}
