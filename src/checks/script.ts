import type { CaseValues } from '../config/paths.js';
import { textsFrom } from './references.js';
import { checkError, fail, PASS, type CheckOfType, type CheckResult } from './result.js';

/** Property values are plain names; anything else would be spliced into the regex source. */
const SCRIPT_NAME = /^[A-Za-z_]+$/;

/**
 * Fails on a code point whose Unicode `Script` (not `Script_Extensions`) is not allowed, after
 * removing `ignore` strings and `ignoreFrom` values from the text.
 */
export function checkScript(
  check: CheckOfType<'script'>,
  text: string,
  values: CaseValues,
): CheckResult {
  const ignored = textsFrom(check.ignoreFrom, values, 'empty');
  if (!ignored.ok) {
    return ignored.error;
  }
  const unknown = check.allow.find((script) => !isScriptName(script));
  if (unknown !== undefined) {
    return checkError({ code: 'unknown-script', script: unknown });
  }
  const classes = check.allow.map((script) => `\\p{Script=${script}}`).join('');
  const allowed = new RegExp(`^[${classes}]$`, 'u');
  const remaining = [...(check.ignore ?? []), ...ignored.values].reduce(
    (rest, fragment) => rest.replaceAll(fragment, ''),
    text,
  );
  const violations = Array.from(remaining).filter((character) => !allowed.test(character));
  return violations.length === 0 ? PASS : fail(violations);
}

function isScriptName(script: string): boolean {
  if (!SCRIPT_NAME.test(script)) {
    return false;
  }
  try {
    new RegExp(`\\p{Script=${script}}`, 'u');
    return true;
  } catch {
    return false;
  }
}
