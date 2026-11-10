import { fail, PASS, type CheckOfType, type CheckResult } from './result.js';

// Extended grapheme cluster rules do not depend on the locale; a fixed one keeps that explicit.
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Fails when the length lies outside `[min, max]`; the evidence is the measured length. */
export function checkLength(check: CheckOfType<'length'>, text: string): CheckResult {
  const length =
    check.unit === 'chars' ? Array.from(text).length : Array.from(graphemes.segment(text)).length;
  const tooShort = check.min !== undefined && length < check.min;
  const tooLong = check.max !== undefined && length > check.max;
  return tooShort || tooLong ? fail([String(length)]) : PASS;
}
