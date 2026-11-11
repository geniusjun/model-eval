import { fail, PASS, type CheckResult } from './result.js';

/** Fails on any `\p{Extended_Pictographic}` code point; kaomoji are made of other characters. */
export function checkEmoji(text: string): CheckResult {
  const pictographs = Array.from(text.matchAll(/\p{Extended_Pictographic}/gu), ([match]) => match);
  return pictographs.length === 0 ? PASS : fail(pictographs);
}
