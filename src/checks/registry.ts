import type { CaseValues } from '../config/paths.js';
import type { GradingCheck } from '../config/schema.js';
import { checkAll, checkAny, checkNot } from './combinators.js';
import { checkEmoji } from './emoji.js';
import { checkJson } from './json.js';
import { checkLength } from './length.js';
import { checkOverlap } from './overlap.js';
import { checkPattern } from './pattern.js';
import { checkPhrases } from './phrases.js';
import type { CheckResult } from './result.js';
import { checkScript } from './script.js';

export type { CheckProblem, CheckResult } from './result.js';

/**
 * Runs a grading check on one text. `values` holds the case input and the per-case rule
 * params that `…From` paths read. The same text, check and values always give the same result.
 */
export function runCheck(check: GradingCheck, text: string, values: CaseValues): CheckResult {
  const evaluate = (child: GradingCheck): CheckResult => runCheck(child, text, values);
  switch (check.type) {
    case 'script':
      return checkScript(check, text, values);
    case 'emoji':
      return checkEmoji(text);
    case 'pattern':
      return checkPattern(check, text);
    case 'phrases':
      return checkPhrases(check, text, values);
    case 'overlap':
      return checkOverlap(check, text, values);
    case 'length':
      return checkLength(check, text);
    case 'json':
      return checkJson(check, text);
    case 'all':
      return checkAll(check, evaluate);
    case 'any':
      return checkAny(check, evaluate);
    case 'not':
      return checkNot(check, evaluate);
  }
}
