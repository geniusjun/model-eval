import { fail, PASS, type CheckOfType, type CheckResult } from './result.js';

/**
 * `forbid` fails when the regex matches, `require` when it does not. The regex always has the
 * `u` flag. A fresh global regex per call collects every match without keeping `lastIndex`
 * between calls, so results never depend on call order.
 */
export function checkPattern(check: CheckOfType<'pattern'>, text: string): CheckResult {
  const regex = new RegExp(check.regex, `gu${check.flags ?? ''}`);
  const matches = Array.from(text.matchAll(regex), ([match]) => match);
  if (check.mode === 'forbid') {
    return matches.length === 0 ? PASS : fail(matches);
  }
  return matches.length === 0 ? fail([]) : PASS;
}
